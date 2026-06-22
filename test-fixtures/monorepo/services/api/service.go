package api

import (
	"fmt"
	"os"
)

func DoAThing() {
	fmt.Println(os.Getenv("test"))
}
