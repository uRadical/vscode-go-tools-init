import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  GoTool,
  VscodeTask,
  parseToolDirectives,
  detectLintTool,
  uniqueBinaries,
  taskLabel,
  computeAlternateTools,
  computeTasks,
  stripJsonc,
  isExcludedModPath,
  moduleRelPath,
  isGeneratedShimValue,
  isShimContents,
  isGeneratedTask,
  GENERATED_LINT_TOOLS,
} from './core';

/**
 * vscode-go-tools-init
 *
 * Discovers Go 1.24+ `tool` directives across a workspace (including monorepos
 * with multiple go.mod files) and scaffolds the VSCode integration for those
 * tools:
 *
 *   - .tools/<binary>            a bash shim: `exec go tool <binary> "$@"` (root)
 *   - .vscode/settings.json      go.alternateTools entries (merged, workspace root)
 *   - .vscode/tasks.json         a task per tool, label-prefixed by module (merged)
 *
 * On activation it auto-prompts when unconfigured modules with tool directives
 * are found (unless `goToolsInit.ignore` is set). The "Init Go Project" command
 * (goToolsInit.init) runs the same flow manually and always bypasses the ignore
 * flag. Both are idempotent: re-running only adds what is missing and refreshes
 * shims.
 */

/** globalState key: suppress the auto-prompt across every workspace on this machine. */
const GLOBAL_IGNORE_KEY = 'goToolsInit.globalIgnore';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('goToolsInit.init', () => runInit({ manual: true })),
    vscode.commands.registerCommand('goToolsInit.clean', () => runClean()),
  );
  // Auto-prompt on activation (best effort; never throws into the host).
  void maybePrompt(context.globalState).catch(() => undefined);
}

export function deactivate(): void {
  // no-op
}

interface GoModule {
  /** Directory containing go.mod. */
  dirUri: vscode.Uri;
  /** POSIX path relative to the workspace root; '' for the root module. */
  relPath: string;
  /** Human-facing path: '.' for the root module, else relPath. */
  displayPath: string;
  /** Tool directives parsed from this module's go.mod (always non-empty). */
  tools: GoTool[];
  /** Whether every tool already has a shim and task. Filled in lazily. */
  configured: boolean;
}

/** Auto-prompt flow, triggered on activation. Honours the ignore flags. */
async function maybePrompt(globalState: vscode.Memento): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    return;
  }

  // Suppressed globally (this machine) or for this workspace.
  if (globalState.get<boolean>(GLOBAL_IGNORE_KEY) === true) {
    return;
  }
  if (await isIgnored(root.uri)) {
    return;
  }

  const modules = await discoverModules(root.uri);
  await markConfigured(root.uri, modules);
  const unconfigured = modules.filter((m) => !m.configured);
  if (unconfigured.length === 0) {
    return;
  }

  const message =
    unconfigured.length === 1
      ? `Go tool directives detected in ${unconfigured[0].displayPath}. Set up VSCode integration?`
      : `Go tool directives detected in ${unconfigured.length} modules. Set up VSCode integration?`;

  const SET_UP = 'Set up';
  const DONT_ASK = "Don't Ask Again";
  const NEVER = 'Never for Any Workspace';
  const choice = await vscode.window.showInformationMessage(message, SET_UP, DONT_ASK, NEVER);

  if (choice === NEVER) {
    await globalState.update(GLOBAL_IGNORE_KEY, true);
    return;
  }
  if (choice === DONT_ASK) {
    await setIgnored(root.uri);
    return;
  }
  if (choice !== SET_UP) {
    return;
  }

  let selected: GoModule[];
  if (unconfigured.length === 1) {
    selected = unconfigured;
  } else {
    selected = await pickModules(unconfigured, { showConfigured: false });
  }
  if (selected.length === 0) {
    return;
  }

  await configureModules(root.uri, selected);
}

/** Manual command flow. Always runs regardless of the ignore flag. */
async function runInit(_opts: { manual: true }): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    void vscode.window.showErrorMessage('Go Tools Init: open a workspace folder first.');
    return;
  }

  const modules = await discoverModules(root.uri);
  if (modules.length === 0) {
    void vscode.window.showInformationMessage(
      'Go Tools Init: no tool directives found in any go.mod. Add one with e.g. ' +
        '`go get -tool github.com/golangci/golangci-lint/cmd/golangci-lint`.',
    );
    return;
  }

  await markConfigured(root.uri, modules);

  let selected: GoModule[];
  if (modules.length === 1) {
    selected = modules;
  } else {
    selected = await pickModules(modules, { showConfigured: true });
  }
  if (selected.length === 0) {
    return;
  }

  await configureModules(root.uri, selected);
}

/** What `clean` would remove. */
interface CleanPlan {
  shims: vscode.Uri[];
  toolsDir: vscode.Uri;
  settingsUri: vscode.Uri;
  tasksUri: vscode.Uri;
  removeAltKeys: string[];
  removeLintTool: string | undefined;
  removeTaskLabels: string[];
  lines: string[];
}

/**
 * Reverse of init: remove only the integration this extension generated — the
 * .tools/ shims, the go.alternateTools entries pointing at them, our go.lintTool
 * value, and the `go tool` tasks. User-authored settings/tasks are left intact.
 */
async function runClean(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    void vscode.window.showErrorMessage('Go Tools Init: open a workspace folder first.');
    return;
  }

  const plan = await buildCleanPlan(root.uri);
  if (plan.lines.length === 0) {
    void vscode.window.showInformationMessage(
      'Go Tools Init: nothing to clean — no generated integration found.',
    );
    return;
  }

  const REMOVE = 'Remove';
  const choice = await vscode.window.showWarningMessage(
    `Go Tools Init will remove ${plan.lines.length} generated item${plan.lines.length === 1 ? '' : 's'}:`,
    { modal: true, detail: plan.lines.join('\n') },
    REMOVE,
  );
  if (choice !== REMOVE) {
    return;
  }

  await applyClean(plan);
  void vscode.window.showInformationMessage(
    `Go Tools Init: removed ${plan.lines.length} generated item${plan.lines.length === 1 ? '' : 's'}.`,
  );
}

/** Inspect the workspace and list exactly what `clean` would remove. */
async function buildCleanPlan(root: vscode.Uri): Promise<CleanPlan> {
  const lines: string[] = [];
  const toolsDir = vscode.Uri.joinPath(root, '.tools');
  const settingsUri = vscode.Uri.joinPath(root, '.vscode', 'settings.json');
  const tasksUri = vscode.Uri.joinPath(root, '.vscode', 'tasks.json');

  // Shims: files under .tools/ whose contents match what we write.
  const shims: vscode.Uri[] = [];
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(toolsDir)) {
      if (type !== vscode.FileType.File) {
        continue;
      }
      const uri = vscode.Uri.joinPath(toolsDir, name);
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        if (isShimContents(text)) {
          shims.push(uri);
          lines.push(`  remove    .tools/${name}`);
        }
      } catch {
        // unreadable — skip
      }
    }
  } catch {
    // no .tools/ — nothing to remove there
  }

  // settings.json: alternateTools entries pointing at our shims, and our lintTool.
  const settings = (await readJson(settingsUri)) ?? {};
  const alt = settings['go.alternateTools'];
  const removeAltKeys: string[] = [];
  if (alt && typeof alt === 'object') {
    for (const [key, value] of Object.entries(alt as Record<string, unknown>)) {
      if (isGeneratedShimValue(value)) {
        removeAltKeys.push(key);
      }
    }
  }
  if (removeAltKeys.length > 0) {
    lines.push(`  settings  go.alternateTools -= ${removeAltKeys.join(', ')}`);
  }
  const lintToolValue = settings['go.lintTool'];
  const removeLintTool =
    typeof lintToolValue === 'string' && GENERATED_LINT_TOOLS.includes(lintToolValue)
      ? lintToolValue
      : undefined;
  if (removeLintTool) {
    lines.push(`  settings  go.lintTool (${removeLintTool})`);
  }

  // tasks.json: our `go tool …` tasks.
  const tasksFile = (await readJson(tasksUri)) ?? {};
  const tasks = Array.isArray(tasksFile['tasks']) ? (tasksFile['tasks'] as VscodeTask[]) : [];
  const removeTaskLabels: string[] = [];
  for (const t of tasks) {
    if (isGeneratedTask(t)) {
      const label = typeof t.label === 'string' ? t.label : '(task)';
      removeTaskLabels.push(label);
      lines.push(`  task      ${label}`);
    }
  }

  return {
    shims,
    toolsDir,
    settingsUri,
    tasksUri,
    removeAltKeys,
    removeLintTool,
    removeTaskLabels,
    lines,
  };
}

/** Apply a clean plan: delete shims and strip the generated settings/tasks. */
async function applyClean(plan: CleanPlan): Promise<void> {
  for (const uri of plan.shims) {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // already gone
    }
  }
  // Remove .tools/ if it is now empty.
  try {
    if ((await vscode.workspace.fs.readDirectory(plan.toolsDir)).length === 0) {
      await vscode.workspace.fs.delete(plan.toolsDir);
    }
  } catch {
    // missing or non-empty — leave it
  }

  if (plan.removeAltKeys.length > 0 || plan.removeLintTool) {
    const settings = (await readJson(plan.settingsUri)) ?? {};
    const alt = settings['go.alternateTools'];
    if (alt && typeof alt === 'object') {
      const map = alt as Record<string, unknown>;
      for (const key of plan.removeAltKeys) {
        delete map[key];
      }
      if (Object.keys(map).length === 0) {
        delete settings['go.alternateTools'];
      }
    }
    if (plan.removeLintTool) {
      delete settings['go.lintTool'];
    }
    await writeJson(plan.settingsUri, settings);
  }

  if (plan.removeTaskLabels.length > 0) {
    const tasksFile = (await readJson(plan.tasksUri)) ?? {};
    if (Array.isArray(tasksFile['tasks'])) {
      tasksFile['tasks'] = (tasksFile['tasks'] as VscodeTask[]).filter((t) => !isGeneratedTask(t));
      await writeJson(plan.tasksUri, tasksFile);
    }
  }
}

interface ModuleQuickPickItem extends vscode.QuickPickItem {
  module: GoModule;
}

/** Show a multi-select quick pick of modules. Returns [] if cancelled. */
async function pickModules(
  modules: GoModule[],
  opts: { showConfigured: boolean },
): Promise<GoModule[]> {
  const items: ModuleQuickPickItem[] = modules.map((m) => ({
    label: m.displayPath,
    description: m.configured ? '(already configured)' : undefined,
    detail: `${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}: ${m.tools
      .map((t) => t.binary)
      .join(', ')}`,
    picked: opts.showConfigured ? !m.configured : true,
    module: m,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Go Tools Init',
    placeHolder: 'Select modules to configure',
  });

  return picked?.map((p) => p.module) ?? [];
}

/**
 * Find every go.mod in the workspace root folder (recursively), skipping
 * vendor/ and testdata/ trees, parse each independently, and keep only modules
 * that declare at least one tool directive.
 */
async function discoverModules(root: vscode.Uri): Promise<GoModule[]> {
  const folder = vscode.workspace.getWorkspaceFolder(root);
  const pattern = folder ? new vscode.RelativePattern(folder, '**/go.mod') : '**/go.mod';
  const found = await vscode.workspace.findFiles(pattern, '{**/vendor/**,**/testdata/**}');

  const modules: GoModule[] = [];
  for (const modUri of found) {
    const rel = vscode.workspace.asRelativePath(modUri, false).replace(/\\/g, '/');
    // Belt-and-braces: drop anything inside a vendor/ or testdata/ segment.
    if (isExcludedModPath(rel)) {
      continue;
    }

    let tools: GoTool[];
    try {
      const bytes = await vscode.workspace.fs.readFile(modUri);
      tools = parseToolDirectives(Buffer.from(bytes).toString('utf8'));
    } catch {
      continue;
    }
    if (tools.length === 0) {
      continue;
    }

    const relPath = moduleRelPath(rel);
    modules.push({
      dirUri: vscode.Uri.joinPath(modUri, '..'),
      relPath,
      displayPath: relPath === '' ? '.' : relPath,
      tools,
      configured: false,
    });
  }

  modules.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return modules;
}

/**
 * Determine which modules are already fully configured: every tool has a shim
 * on disk and a matching task in the workspace-root tasks.json.
 */
async function markConfigured(root: vscode.Uri, modules: GoModule[]): Promise<void> {
  const tasksUri = vscode.Uri.joinPath(root, '.vscode', 'tasks.json');
  const tasksFile = await readJson(tasksUri);
  const taskList =
    tasksFile && Array.isArray(tasksFile['tasks']) ? (tasksFile['tasks'] as VscodeTask[]) : [];
  const labels = new Set<string>(
    taskList.map((t) => (typeof t?.label === 'string' ? t.label : '')).filter((l) => l !== ''),
  );

  for (const m of modules) {
    m.configured = await isModuleConfigured(root, m, labels);
  }
}

async function isModuleConfigured(
  root: vscode.Uri,
  m: GoModule,
  taskLabels: Set<string>,
): Promise<boolean> {
  for (const tool of m.tools) {
    const shimUri = vscode.Uri.joinPath(root, '.tools', tool.binary);
    if (!(await exists(shimUri))) {
      return false;
    }
    if (!taskLabels.has(taskLabel(m.relPath, tool))) {
      return false;
    }
  }
  return true;
}

/**
 * Generate shims, settings, and tasks for the selected modules, after showing
 * the user a preview of exactly what will be created or modified.
 */
async function configureModules(root: vscode.Uri, modules: GoModule[]): Promise<void> {
  const plan = await buildPlan(root, modules);
  if (plan.length === 0) {
    void vscode.window.showInformationMessage(
      'Go Tools Init: nothing to do — the selected modules are already configured.',
    );
    return;
  }

  const APPLY = 'Apply';
  const choice = await vscode.window.showInformationMessage(
    `Go Tools Init will make ${plan.length} change${plan.length === 1 ? '' : 's'}:`,
    { modal: true, detail: plan.join('\n') },
    APPLY,
  );
  if (choice !== APPLY) {
    return;
  }

  const generated: string[] = [];

  // 1. One shim per unique tool name in the workspace-root .tools/. go.alternateTools
  //    is a single global map (one entry per tool name), and each shim runs
  //    `go tool <name>` relative to its invocation directory — so a single root shim
  //    serves every module, resolving that module's pinned tool via cwd.
  const toolsDir = vscode.Uri.joinPath(root, '.tools');
  await ensureDir(toolsDir);
  for (const binary of uniqueBinaries(modules)) {
    await writeShim(vscode.Uri.joinPath(toolsDir, binary), binary);
    generated.push(`.tools/${binary}`);
  }

  // 2. Workspace-root .vscode/settings.json — merged go.alternateTools.
  const vscodeDir = vscode.Uri.joinPath(root, '.vscode');
  await ensureDir(vscodeDir);
  const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
  if (await mergeSettings(settingsUri, modules)) {
    generated.push('.vscode/settings.json (go.alternateTools)');
  }

  // 3. Workspace-root .vscode/tasks.json — merged, module-prefixed tasks.
  const tasksUri = vscode.Uri.joinPath(vscodeDir, 'tasks.json');
  if (await mergeTasks(tasksUri, modules)) {
    generated.push('.vscode/tasks.json (tasks)');
  }

  const toolCount = modules.reduce((n, m) => n + m.tools.length, 0);
  const detail =
    generated.map((g) => `  • ${g}`).join('\n') +
    '\n\nThe Go extension only honours go.alternateTools in a trusted workspace — ' +
    'accept the Workspace Trust prompt if you have not already.';
  void vscode.window.showInformationMessage(
    `Go Tools Init: configured ${toolCount} tool${toolCount === 1 ? '' : 's'} across ` +
      `${modules.length} module${modules.length === 1 ? '' : 's'}.`,
    { modal: false, detail },
  );
}

/**
 * Compute a human-readable preview of the changes configureModules would make,
 * without writing anything. Shims are always rewritten (create or refresh);
 * settings/tasks entries are only listed when they would actually be added.
 */
async function buildPlan(root: vscode.Uri, modules: GoModule[]): Promise<string[]> {
  const lines: string[] = [];

  // Shims — one per unique tool name at the workspace root, always (re)written.
  for (const binary of uniqueBinaries(modules)) {
    const shimUri = vscode.Uri.joinPath(root, '.tools', binary);
    const action = (await exists(shimUri)) ? 'refresh' : 'create ';
    lines.push(`  ${action}  .tools/${binary}`);
  }

  // settings.json — new go.alternateTools keys and go.lintTool.
  const settings = (await readJson(vscode.Uri.joinPath(root, '.vscode', 'settings.json'))) ?? {};
  const current = settings['go.alternateTools'];
  const seen = new Set<string>(
    typeof current === 'object' && current !== null ? Object.keys(current) : [],
  );
  const newKeys: string[] = [];
  for (const m of modules) {
    for (const tool of m.tools) {
      if (!seen.has(tool.binary)) {
        seen.add(tool.binary);
        newKeys.push(tool.binary);
      }
    }
  }
  if (newKeys.length > 0) {
    lines.push(`  settings  go.alternateTools += ${newKeys.join(', ')}`);
  }
  const lintTool = detectLintTool(modules);
  if (lintTool && settings['go.lintTool'] === undefined) {
    lines.push(`  settings  go.lintTool = ${lintTool}`);
  }

  // tasks.json — new task labels.
  const tasksFile = (await readJson(vscode.Uri.joinPath(root, '.vscode', 'tasks.json'))) ?? {};
  const existingLabels = new Set<string>(
    (Array.isArray(tasksFile['tasks']) ? (tasksFile['tasks'] as VscodeTask[]) : [])
      .map((t) => (typeof t?.label === 'string' ? t.label : ''))
      .filter((l) => l !== ''),
  );
  for (const m of modules) {
    for (const tool of m.tools) {
      const label = taskLabel(m.relPath, tool);
      if (!existingLabels.has(label)) {
        existingLabels.add(label);
        lines.push(`  task      ${label}`);
      }
    }
  }

  return lines;
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(uri);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function writeShim(uri: vscode.Uri, binary: string): Promise<void> {
  const contents = `#!/usr/bin/env bash\nexec go tool ${binary} "$@"\n`;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
  // Mark executable (best effort; not supported on all platforms / filesystems).
  try {
    fs.chmodSync(uri.fsPath, 0o755);
  } catch {
    // ignore — Windows or restricted FS
  }
}

/**
 * Merge the selected modules' tools into go.alternateTools at the workspace root,
 * and set go.lintTool when every module declares golangci-lint. Existing entries
 * and a user's chosen linter are never overwritten. Returns true if it wrote.
 */
async function mergeSettings(uri: vscode.Uri, modules: GoModule[]): Promise<boolean> {
  const existing = (await readJson(uri)) ?? {};
  const settings: Record<string, unknown> =
    typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {};

  const current = settings['go.alternateTools'];
  const currentMap: Record<string, string> =
    typeof current === 'object' && current !== null ? (current as Record<string, string>) : {};

  const { value: alternate, changed: altChanged } = computeAlternateTools(currentMap, modules);
  let changed = altChanged;

  // go.alternateTools only changes which *binary* a tool resolves to — it does not
  // make the Go extension run that tool. golangci-lint only runs when go.lintTool
  // selects it (unset by default), and that setting is workspace-global, so we set
  // it only when every module declares golangci-lint (see detectLintTool) and never
  // clobber a user's explicit choice.
  const lintTool = detectLintTool(modules);
  if (lintTool && settings['go.lintTool'] === undefined) {
    settings['go.lintTool'] = lintTool;
    changed = true;
  }

  if (!changed && current !== undefined) {
    return false;
  }

  settings['go.alternateTools'] = alternate;
  await writeJson(uri, settings);
  return true;
}

/** Merge per-tool tasks into tasks.json. Returns true if a write happened. */
async function mergeTasks(uri: vscode.Uri, modules: GoModule[]): Promise<boolean> {
  const existing = (await readJson(uri)) as Record<string, unknown> | undefined;
  const tasksFile: Record<string, unknown> = existing ?? {};

  if (typeof tasksFile['version'] !== 'string') {
    tasksFile['version'] = '2.0.0';
  }

  const currentTasks = Array.isArray(tasksFile['tasks'])
    ? (tasksFile['tasks'] as VscodeTask[])
    : [];

  const { value: result, changed } = computeTasks(currentTasks, modules);

  if (!changed && existing !== undefined && Array.isArray(existing['tasks'])) {
    return false;
  }

  tasksFile['tasks'] = result;
  await writeJson(uri, tasksFile);
  return true;
}

/** Read the workspace-root ignore flag. */
async function isIgnored(root: vscode.Uri): Promise<boolean> {
  const settings = await readJson(vscode.Uri.joinPath(root, '.vscode', 'settings.json'));
  return settings?.['goToolsInit.ignore'] === true;
}

/** Persist the workspace-root ignore flag, merging into settings.json. */
async function setIgnored(root: vscode.Uri): Promise<void> {
  const vscodeDir = vscode.Uri.joinPath(root, '.vscode');
  await ensureDir(vscodeDir);
  const uri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
  const existing = (await readJson(uri)) ?? {};
  const settings: Record<string, unknown> =
    typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {};
  settings['goToolsInit.ignore'] = true;
  await writeJson(uri, settings);
}

/**
 * Read a JSON/JSONC file, tolerating // and block comments and trailing commas.
 * Returns undefined if the file does not exist; returns {} on parse failure so a
 * malformed file is replaced rather than crashing the command.
 */
async function readJson(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
  const text = Buffer.from(bytes).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonc(text));
    } catch {
      void vscode.window.showWarningMessage(
        `Go Tools Init: could not parse ${uri.fsPath}; merging into a fresh file.`,
      );
      return {};
    }
  }
}

async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}
