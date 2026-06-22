# Test fixtures

Throwaway workspaces for exercising the extension in an Extension Development Host.
Not shipped in the VSIX (excluded via `.vscodeignore`).

The committed fixtures are **minimal**: a `go.mod` with tool directives, a source
file with an intentional lint issue, and a `.golangci.yml`. That text is all the
extension reads — discovery, the picker, the preview, lint-tool wiring, and the
gap-fill prompt all work without resolving any dependencies.

- `single/` — golangci-lint (v2) + goimports
- `monorepo/services/auth/` — golangci-lint (v2) + goimports
- `monorepo/services/api/` — goimports only (**the golangci-lint gap**)

> No `go.sum` is committed. Resolving golangci-lint pulls its entire dependency
> tree, which is throwaway state we keep out of git. You only need it to actually
> *run* a tool — see [Verifying golangci-lint actually runs](#verifying-golangci-lint-actually-runs-issue-2).
> Expect gopls to flag the modules as needing `go mod tidy` until you do.

## How to run (Level 1 — scaffolding, no deps needed)

1. `npm install` (once).
2. Press **F5** and pick a launch config:
   - **Run Extension (monorepo fixture)** → opens `monorepo/`
   - **Run Extension (single-module fixture)** → opens `single/`
   - **Run Extension (empty …)** → opens nothing; use *File → Open* on your own repo.
3. A second VS Code window (the Dev Host) opens with the extension loaded.

## What each fixture checks

### `single/`
One module declaring `golangci-lint` (v2) and `goimports`.
- Auto-prompt should say *"Go tool directives detected in `.`"* (single-module copy).
- **Set up → Apply** should create `single/.tools/{golangci-lint,goimports}`,
  `single/.vscode/settings.json` with `go.alternateTools` **and** `go.lintTool:
  "golangci-lint-v2"`, and `single/.vscode/tasks.json`.

### `monorepo/`
Two real modules plus two that must be ignored:
- `services/auth` — `golangci-lint` (v2) + `goimports`
- `services/api` — `goimports`
- `vendor/example.com/dep` — **must not appear** (vendor/)
- `services/auth/testdata/fake` — **must not appear** (testdata/)

Checks:
- Auto-prompt says *"…detected in 2 modules"*; the multi-select picker lists
  exactly `services/api` and `services/auth`.
- **Preview** modal (#4) lists shims/settings/tasks before writing; nothing is
  written until **Apply**.
- Shims are created **once** at the workspace root (`monorepo/.tools/{goimports,golangci-lint}`),
  not per module.
- Task labels are module-prefixed, e.g. `services/auth: golangci-lint run ./...`.
- `goimports` appears once in `go.alternateTools`, pointing at `${workspaceFolder}/.tools/goimports`
  (one global entry per tool name).
- Re-running **Init Go Project** (Command Palette) shows the modules with
  `(already configured)`.
- **Never for Any Workspace** (#3) suppresses the prompt in every fixture until you
  clear it (see Reset below).
- **Mixed-linter handling** — because `services/api` lacks golangci-lint while
  `services/auth` has it, `go.lintTool` is **not** set (a global linter isn't forced
  on api). No prompt, no warning — api is simply left as declared. `go.lintTool`
  *would* be set if both modules declared golangci-lint (as in `single/`).

## Verifying golangci-lint actually runs (issue #2)

This is **Level 2** and the only part that needs resolved dependencies. Resolve once
(pulls golangci-lint's tree — local, git-ignored, throwaway):

```bash
./setup.sh
```

Then, to prove the Go extension uses the **pinned** linter via the shim:

1. Open `single/` (or `monorepo/`) in the Dev Host and set up the integration.
2. **Trust the workspace** (accept the Workspace Trust prompt, or *Workspaces: Manage
   Workspace Trust*). In Restricted Mode the Go extension ignores `go.alternateTools`
   entirely — this is the make-or-break gate from #2.
3. The fixture source (`*.go`) already has an unchecked-error lint issue. On save (or
   via **Go: Lint Workspace**) golangci-lint diagnostics should appear in **Problems**,
   and **Output ▸ Go** should show the command running through `${workspaceFolder}/.tools/golangci-lint`.

> First `go tool golangci-lint` run compiles golangci-lint and can take a minute.
> Sanity-check from a terminal: `(cd test-fixtures/single && go tool golangci-lint run ./...)`
> When done, `git checkout test-fixtures` to drop the resolved go.mod bloat.

## Reset between runs

```bash
# from repo root — removes generated shims/config (incl. stale per-module .tools
# from older runs) but keeps the go.mod fixtures
find test-fixtures -type d \( -name .tools -o -name .vscode \) -prune -exec rm -rf {} +
```

To clear the global "Never for Any Workspace" flag, run **Developer: Reset Global
State** in the Dev Host, or relaunch from a clean Extensions profile.
