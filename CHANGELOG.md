# Changelog

## 0.1.0

Initial public release — a stop-gap until the official Go extension supports
`go tool` natively ([golang/vscode-go#3799](https://github.com/golang/vscode-go/issues/3799)).

- Discover Go 1.24+ `tool` directives across a workspace, including monorepos with
  multiple `go.mod` files (skips `vendor/` and `testdata/`).
- Generate root `.tools/<binary>` shims, merge `go.alternateTools` into the
  workspace `.vscode/settings.json`, and add module-prefixed `go tool` tasks to
  `.vscode/tasks.json`.
- Set `go.lintTool` for golangci-lint (v1/v2) only when every module declares it.
- Preview every change before writing; merge into existing settings/tasks rather
  than overwriting.
- Auto-prompt on activation with per-workspace and machine-wide opt-outs.
- **Clean Generated Integration** command removes only what the extension created.

**Known limitation:** macOS/Linux only (bash shims); Windows is not yet supported
([#1](https://github.com/uRadical/vscode-go-tools-init/issues/1)).
