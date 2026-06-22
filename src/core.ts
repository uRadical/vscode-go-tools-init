/**
 * Pure, vscode-free logic for Go Tools Init.
 *
 * Everything here operates on plain data (strings and POJOs) with no VS Code or
 * filesystem dependencies, so it can be unit-tested directly with Node — no
 * extension host download required. extension.ts wires these into the VS Code
 * API and the filesystem.
 */

export interface GoTool {
  /** Full import path from the tool directive, e.g. github.com/foo/bar/cmd/baz */
  importPath: string;
  /** Binary name derived from the last path segment, e.g. baz */
  binary: string;
}

/** The vscode-free shape the pure helpers need from a discovered module. */
export interface ModuleSpec {
  /** POSIX path relative to the workspace root; '' for the root module. */
  relPath: string;
  /** Tool directives parsed from this module's go.mod. */
  tools: GoTool[];
}

export interface VscodeTask {
  label?: string;
  type?: string;
  command?: string;
  args?: string[];
  options?: { cwd?: string };
  problemMatcher?: unknown;
  group?: unknown;
  [key: string]: unknown;
}

/**
 * Parse `tool` directives from go.mod. Supports both the single-line form:
 *
 *   tool github.com/foo/bar/cmd/baz
 *
 * and the block form:
 *
 *   tool (
 *       github.com/foo/bar/cmd/baz
 *       golang.org/x/tools/cmd/goimports
 *   )
 */
export function parseToolDirectives(goMod: string): GoTool[] {
  const tools: GoTool[] = [];
  const seen = new Set<string>();
  const lines = goMod.split(/\r?\n/);

  let inBlock = false;
  for (const raw of lines) {
    // Strip line comments and surrounding whitespace.
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') {
      continue;
    }

    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      addTool(tools, seen, line);
      continue;
    }

    if (line === 'tool (') {
      inBlock = true;
      continue;
    }

    const single = line.match(/^tool\s+(\S+)\s*$/);
    if (single) {
      addTool(tools, seen, single[1]);
    }
  }

  return tools;
}

function addTool(tools: GoTool[], seen: Set<string>, importPath: string): void {
  const path = importPath.trim();
  if (path === '' || seen.has(path)) {
    return;
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  const binary = segments[segments.length - 1];
  if (!binary) {
    return;
  }
  seen.add(path);
  tools.push({ importPath: path, binary });
}

/** Sensible default arguments for well-known tools; falls back to none. */
export function defaultArgs(binary: string): string[] {
  switch (binary) {
    case 'golangci-lint':
      return ['run', './...'];
    case 'goimports':
      return ['-l', '.'];
    case 'gofumpt':
      return ['-l', '.'];
    case 'staticcheck':
      return ['./...'];
    case 'govulncheck':
      return ['./...'];
    case 'errcheck':
      return ['./...'];
    case 'gosec':
      return ['./...'];
    default:
      return [];
  }
}

/** True if a workspace-relative go.mod path is inside a vendor/ or testdata/ tree. */
export function isExcludedModPath(relModPath: string): boolean {
  return /(^|\/)(vendor|testdata)\//.test(relModPath);
}

/** Module directory (POSIX, '' for root) from a workspace-relative go.mod path. */
export function moduleRelPath(relModPath: string): string {
  return relModPath.replace(/\\/g, '/').replace(/(^|\/)go\.mod$/, '');
}

/** Sorted, de-duplicated tool binary names across the given modules. */
export function uniqueBinaries(modules: ModuleSpec[]): string[] {
  const set = new Set<string>();
  for (const m of modules) {
    for (const tool of m.tools) {
      set.add(tool.binary);
    }
  }
  return [...set].sort();
}

/** `${workspaceFolder}`-relative path of the shared root shim for a binary. */
export function shimTarget(binary: string): string {
  return `\${workspaceFolder}/.tools/${binary}`;
}

/** The go.lintTool values this extension sets (so `clean` knows which to remove). */
export const GENERATED_LINT_TOOLS = ['golangci-lint', 'golangci-lint-v2'];

/** True if a go.alternateTools value points at one of our generated root shims. */
export function isGeneratedShimValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('${workspaceFolder}/.tools/');
}

/** True if a file's contents look like a shim this extension wrote. */
export function isShimContents(text: string): boolean {
  return /^#!\/usr\/bin\/env bash\s*\nexec go tool \S+ "\$@"\s*$/.test(text.trim());
}

/** True if a task is one this extension generated (`go tool <name> …`). */
export function isGeneratedTask(task: VscodeTask): boolean {
  return task.command === 'go' && Array.isArray(task.args) && task.args[0] === 'tool';
}

/** Task label, prefixed by module directory to avoid cross-module collisions. */
export function taskLabel(relPath: string, tool: GoTool): string {
  const argline = [tool.binary, ...defaultArgs(tool.binary)].join(' ');
  return relPath === '' ? `go tool: ${argline}` : `${relPath}: ${argline}`;
}

/**
 * The Go extension's go.lintTool value to use — but only when *every* module
 * declares golangci-lint. go.lintTool is workspace-global, so setting it would
 * make the Go extension run golangci-lint in modules that didn't ask for it,
 * which then error. Returns undefined if any module lacks it (or there are none),
 * so a mixed workspace is left to the user. golangci-lint v2 has a separate
 * lintTool option ('golangci-lint-v2'), identified by its /v2/ module path.
 */
export function detectLintTool(modules: ModuleSpec[]): string | undefined {
  if (modules.length === 0) {
    return undefined;
  }
  let lint: GoTool | undefined;
  for (const m of modules) {
    const tool = m.tools.find((t) => t.binary === 'golangci-lint');
    if (!tool) {
      return undefined; // a module opted out — don't impose a global linter
    }
    lint = tool;
  }
  if (!lint) {
    return undefined;
  }
  return /\/v2\//.test(lint.importPath) ? 'golangci-lint-v2' : 'golangci-lint';
}

/**
 * Merge the modules' tools into an existing go.alternateTools map. Binary names
 * are global, so a name shared across modules keeps its first occurrence — no
 * duplication, and existing entries are never overwritten. Returns the new map
 * and whether anything was added.
 */
export function computeAlternateTools(
  existing: Record<string, string>,
  modules: ModuleSpec[],
): { value: Record<string, string>; changed: boolean } {
  const value: Record<string, string> = { ...existing };
  let changed = false;
  for (const m of modules) {
    for (const tool of m.tools) {
      if (tool.binary in value) {
        continue;
      }
      value[tool.binary] = shimTarget(tool.binary);
      changed = true;
    }
  }
  return { value, changed };
}

/**
 * Merge per-tool tasks into an existing task list, de-duplicated by label. Each
 * task runs `go tool <binary>` in its module's directory. Returns the new list
 * and whether anything was added.
 */
export function computeTasks(
  existing: VscodeTask[],
  modules: ModuleSpec[],
): { value: VscodeTask[]; changed: boolean } {
  const byLabel = new Set<string>();
  for (const t of existing) {
    if (t && typeof t.label === 'string') {
      byLabel.add(t.label);
    }
  }

  const value = [...existing];
  let changed = false;
  for (const m of modules) {
    for (const tool of m.tools) {
      const label = taskLabel(m.relPath, tool);
      if (byLabel.has(label)) {
        continue;
      }
      const task: VscodeTask = {
        label,
        type: 'shell',
        command: 'go',
        args: ['tool', tool.binary, ...defaultArgs(tool.binary)],
        group: 'build',
        problemMatcher: [],
      };
      if (m.relPath !== '') {
        task.options = { cwd: `\${workspaceFolder}/${m.relPath}` };
      }
      value.push(task);
      byLabel.add(label);
      changed = true;
    }
  }
  return { value, changed };
}

/** Strip // line comments, block comments, and trailing commas from JSONC. */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }

  // Remove trailing commas: , followed by optional whitespace then } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}
