//go:build linux

package host

import "syscall"

// readDisk uses statvfs(2) on the host root mount. Bavail (not Bfree)
// is what userspace can actually use — Bfree includes blocks reserved
// for root.
func readDisk() (Disk, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(HostRootDir, &st); err != nil {
		return Disk{}, err
	}
	total := st.Blocks * uint64(st.Bsize)
	avail := st.Bavail * uint64(st.Bsize)
	used := total - avail
	return Disk{
		TotalBytes: total,
		UsedBytes:  used,
		FreeBytes:  avail,
		UsedPct:    pct(used, total),
	}, nil
}
