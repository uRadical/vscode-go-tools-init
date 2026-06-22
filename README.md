<p align="center">
  <img src="https://raw.githubusercontent.com/uRadical/vscode-go-tools-init/main/assets/github_social_preview.png" alt="Go Tools Init">
</p>

# Go Tools Init

A small VSCode extension that wires up your Go 1.24+ [`tool` directives](https://go.dev/doc/modules/managing-dependencies#tools) for use inside VSCode.

> **Status: stop-gap.** This exists to bridge the gap until the official Go
> extension supports `go tool` natively
> ([golang/vscode-go#3799](https://github.com/golang/vscode-go/issues/3799)). When
> that lands, run **Clean Generated Integration** and uninstall — nothing is
> locked in.

## Requirements & limitations

- **Go 1.24+** (for `tool` directives) and the official **Go extension** (`golang.go`).
- **macOS / Linux** (the integration uses bash shims). This includes **Windows via
  WSL or Dev Containers**, where the workspace is Linux. **Native Windows** is not
  supported yet ([#1](https://github.com/uRadical/vscode-go-tools-init/issues/1)).
- The Go extension only honours `go.alternateTools` in a **trusted** workspace —
  accept the Workspace Trust prompt. See
  [How the Go extension picks up your tools](#how-the-go-extension-picks-up-your-tools).

Go 1.24 lets you track developer tools in `go.mod`:

```
tool (
    github.com/golangci/golangci-lint/cmd/golangci-lint
    golang.org/x/tools/cmd/goimports
)
```

…and run them with `go tool <name>`. This extension scaffolds the glue so the Go extension and your tasks can use those tools without a global install.

## Usage

1. Open your workspace (a single Go module, or a monorepo with many `go.mod` files).
2. When tool directives are found, the extension prompts you to set up the
   integration. You can also run **Init Go Project** from the Command Palette
   (`goToolsInit.init`) at any time.
3. To undo it, run **Clean Generated Integration** (`goToolsInit.clean`) — it
   previews and removes only what this extension created (the `.tools/` shims, its
   `go.alternateTools` entries, its `go.lintTool` value, and its `go tool` tasks),
   leaving your own settings and tasks untouched. Handy once you no longer need the
   stop-gap (see [Relationship to upstream](#relationship-to-upstream)).

It globs **every** `go.mod` in the workspace (skipping `vendor/` and `testdata/`),
parses each module's `tool` directives independently, derives the binary name from
the last segment of each import path, and generates:

- **`.tools/<binary>`** (workspace root) — one executable bash shim per unique tool
  name:
  ```bash
  #!/usr/bin/env bash
  exec go tool <binary> "$@"
  ```
  The shim has no `cd`, so `go tool` resolves to the **calling module's** pinned tool
  via the working directory. A single root shim therefore serves every module — there
  is no per-module copy.
- **`.vscode/settings.json`** (workspace root) — `go.alternateTools` mapping each
  binary to its root shim, e.g. `${workspaceFolder}/.tools/golangci-lint`.
  `go.alternateTools` is a single global map (one entry per tool name), so a tool
  shared by several modules has exactly one entry. `go.lintTool` may also be set
  (see below). Existing settings are merged, not overwritten.
- **`.vscode/tasks.json`** (workspace root) — one task per tool, with sensible
  default args. Labels are prefixed by module directory to avoid collisions, e.g.
  `services/auth: golangci-lint run ./...`, `services/api: goimports -l .`. Each
  task runs in its module's directory. Existing tasks are merged.

## How the Go extension picks up your tools

`go.alternateTools` only changes **which binary** a tool resolves to — it does not,
by itself, make the Go extension *run* that tool. Two things matter:

- **Workspace Trust.** The Go extension only reads `go.alternateTools` from
  `.vscode/settings.json` in a **trusted** workspace. Accept VS Code's Workspace
  Trust prompt (or "Trust" the folder) — in Restricted Mode the mappings, and the
  Go extension itself, are ignored.
- **Linting.** `go.lintTool` is unset by default, so golangci-lint never runs as a
  linter on its own. This extension sets `go.lintTool` to `golangci-lint` (or
  `golangci-lint-v2` for `/v2/` modules) **only when every configured module declares
  it** — and only if you haven't already chosen a linter. The pinned binary is then
  used via the shim.
- **Per-module is your choice.** `go.lintTool` is workspace-global: it can only name
  one linter for the whole workspace. Because whether a module declares golangci-lint
  is a deliberate per-module decision, a mixed workspace (some modules with it, some
  without) is left alone — `go.lintTool` is **not** set, so no module gets a linter
  forced on it. Each module's `tasks.json` entries still reflect exactly what that
  module declares. Set `go.lintTool` yourself if you want one linter everywhere.
- **Formatting.** `goimports` / `gofumpt` are mapped in `go.alternateTools`, but the
  Go extension formats via gopls by default. To route formatting through the pinned
  binary, set `go.formatTool` to `goimports` / `gofumpt` yourself (gofumpt is often
  better enabled via `gopls`: `"formatting.gofumpt": true`).
- Tasks in `tasks.json` run `go tool <name>` directly and work regardless of the
  above.

## Behaviour

- **Monorepo aware** — when more than one module has unconfigured tool directives,
  you get a multi-select list (shown as paths relative to the workspace root) to
  choose which modules to configure.
- **Auto-prompt** — on activation, if unconfigured modules with tool directives
  exist, you're asked whether to set up the integration.
  - Single module: _"Go tool directives detected in `<module>`. Set up VSCode integration?"_
  - Multiple: _"Go tool directives detected in N modules…"_, then the picker.
- **Preview before writing** — once you confirm and choose modules, a modal lists
  every shim, setting, and task that will be created or changed; nothing is written
  until you click **Apply**.
- **Don't Ask Again** — sets `"goToolsInit.ignore": true` in the workspace-root
  `.vscode/settings.json`, suppressing the auto-prompt for this workspace.
  **Never for Any Workspace** suppresses it on this machine entirely (stored in the
  extension's global state). The **Init Go Project** command always bypasses both
  flags, and (with multiple modules) lists every module, marking configured ones
  `(already configured)`.
- **Idempotent** — safe to re-run when you add new tools; it only adds what is
  missing and refreshes the shims.
- **No tool directives anywhere** → tells you, and suggests `go get -tool <import-path>`.
- On success, shows a notification listing what was generated.

## Relationship to upstream

This extension is a stop-gap. The Go team is tracking native `go tool` support in
the official Go extension — see
[golang/vscode-go#3799](https://github.com/golang/vscode-go/issues/3799). If/when
that lands, the `go.alternateTools` half of this extension becomes unnecessary; the
generated `tasks.json` entries (plain `go tool <name>` runners) are likely to stay
useful regardless. Track the upstream issue before investing heavily here.

## Notes

- Shims are marked executable on Unix-like systems (best effort; chmod is skipped on Windows).
- JSON files are read tolerantly (comments and trailing commas are accepted on
  read), but are rewritten as plain JSON, so hand-written comments in
  `settings.json` / `tasks.json` are not preserved.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press `F5` in VSCode to launch an Extension Development Host.

<p align="center">
  <img src="icon.png" alt="Go Tools Init" width="128" height="128">
</p>