package api

import "os"

// Demo contains an intentional lint issue (unchecked error from os.Mkdir) so
// golangci-lint has something to report when wired up.
func Demo() {
	os.Mkdir("data", 0o755)
}
