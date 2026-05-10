//go:build !linux

package host

import "errors"

// readDisk on non-Linux platforms is a stub. The collector runs only
// inside a Linux container; this file exists so `go vet` / `go build`
// succeed on a developer's macOS / Windows workstation.
func readDisk() (Disk, error) {
	return Disk{}, errors.New("readDisk: unsupported platform (linux only)")
}
