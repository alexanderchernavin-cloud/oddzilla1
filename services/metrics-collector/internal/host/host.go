// Package host reads OS-level metrics from the procfs + the host root
// filesystem mounted into this container.
//
// The collector runs in its own Docker container with three read-only
// bind mounts: /proc -> /host/proc, / -> /host-root, and the docker.sock.
// All calls in this package go through HostProcDir + HostRootDir so the
// reads are explicit about touching host state rather than the
// container's overlayfs.

package host

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// Defaults match the bind mounts in docker-compose.yml. Override only
	// for unit tests against a fixture proc tree.
	HostProcDir = "/host/proc"
	HostRootDir = "/host-root"
)

// LoadAvg holds the three Linux load-average values from /proc/loadavg.
type LoadAvg struct {
	M1  float64 `json:"m1"`
	M5  float64 `json:"m5"`
	M15 float64 `json:"m15"`
}

// Memory captures total / used / free in bytes plus the convenience pct.
// Used follows the modern "used = total - available" definition (which
// htop / free -m -h use), not the deprecated "total - free - buffers -
// cached" form. Available accounts for reclaimable cache so the percent
// reflects pressure, not buffered I/O.
type Memory struct {
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	FreeBytes  uint64  `json:"freeBytes"`
	UsedPct    float64 `json:"usedPct"`
}

// Swap captures swap usage. Total may be 0 on hosts with no swap; in
// that case UsedPct is forced to 0 instead of NaN.
type Swap struct {
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	UsedPct    float64 `json:"usedPct"`
}

// Disk captures filesystem usage at HostRootDir (mount of host /).
type Disk struct {
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	FreeBytes  uint64  `json:"freeBytes"`
	UsedPct    float64 `json:"usedPct"`
}

// Snapshot is the merged host view returned to the API.
type Snapshot struct {
	UptimeSec int64    `json:"uptimeSec"`
	CPUCount  int      `json:"cpuCount"`
	LoadAvg   LoadAvg  `json:"loadAvg"`
	CPUPct    *float64 `json:"cpuPct"` // nil on first call (no baseline yet)
	Memory    Memory   `json:"memory"`
	Swap      Swap     `json:"swap"`
	Disk      Disk     `json:"disk"`
}

// Reader carries the rolling state needed to compute CPU% (delta over
// the previous /proc/stat reading). The first call returns nil for
// CPUPct so callers can render "-" instead of a misleading 0.
type Reader struct {
	mu      sync.Mutex
	lastCPU cpuTotals
	hasCPU  bool
}

func NewReader() *Reader { return &Reader{} }

// Read collects every host metric and returns a Snapshot. The CPU
// percent is computed against the previous Read; the rest are
// instantaneous reads.
func (r *Reader) Read() (*Snapshot, error) {
	uptime, err := readUptime()
	if err != nil {
		return nil, fmt.Errorf("uptime: %w", err)
	}
	la, err := readLoadAvg()
	if err != nil {
		return nil, fmt.Errorf("loadavg: %w", err)
	}
	mem, swap, err := readMeminfo()
	if err != nil {
		return nil, fmt.Errorf("meminfo: %w", err)
	}
	disk, err := readDisk()
	if err != nil {
		return nil, fmt.Errorf("disk: %w", err)
	}
	cpuPct, err := r.readCPUPct()
	if err != nil {
		return nil, fmt.Errorf("cpu: %w", err)
	}
	cpuCount, err := readCPUCount()
	if err != nil {
		// Fall back to the runtime view; this is only used for the
		// "load > N x cpu" threshold colouring on the frontend, so a
		// graceful degradation is fine.
		cpuCount = runtime.NumCPU()
	}
	return &Snapshot{
		UptimeSec: uptime,
		CPUCount:  cpuCount,
		LoadAvg:   la,
		CPUPct:    cpuPct,
		Memory:    mem,
		Swap:      swap,
		Disk:      disk,
	}, nil
}

func readUptime() (int64, error) {
	b, err := os.ReadFile(HostProcDir + "/uptime")
	if err != nil {
		return 0, err
	}
	parts := strings.Fields(string(b))
	if len(parts) == 0 {
		return 0, fmt.Errorf("empty uptime")
	}
	f, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0, err
	}
	return int64(f), nil
}

func readLoadAvg() (LoadAvg, error) {
	b, err := os.ReadFile(HostProcDir + "/loadavg")
	if err != nil {
		return LoadAvg{}, err
	}
	parts := strings.Fields(string(b))
	if len(parts) < 3 {
		return LoadAvg{}, fmt.Errorf("malformed loadavg: %q", string(b))
	}
	m1, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return LoadAvg{}, err
	}
	m5, err := strconv.ParseFloat(parts[1], 64)
	if err != nil {
		return LoadAvg{}, err
	}
	m15, err := strconv.ParseFloat(parts[2], 64)
	if err != nil {
		return LoadAvg{}, err
	}
	return LoadAvg{M1: m1, M5: m5, M15: m15}, nil
}

// readMeminfo parses the kB-suffixed key/value lines in /proc/meminfo
// and returns Memory + Swap structs in bytes.
func readMeminfo() (Memory, Swap, error) {
	f, err := os.Open(HostProcDir + "/meminfo")
	if err != nil {
		return Memory{}, Swap{}, err
	}
	defer f.Close()

	values := map[string]uint64{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		key := line[:colon]
		rest := strings.TrimSpace(line[colon+1:])
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		// /proc/meminfo reports kB on Linux for every memory key.
		if len(fields) > 1 && strings.EqualFold(fields[1], "kB") {
			n *= 1024
		}
		values[key] = n
	}
	if err := sc.Err(); err != nil {
		return Memory{}, Swap{}, err
	}

	total := values["MemTotal"]
	available := values["MemAvailable"]
	free := values["MemFree"]
	swapTotal := values["SwapTotal"]
	swapFree := values["SwapFree"]

	used := uint64(0)
	if total > available {
		used = total - available
	}
	mem := Memory{
		TotalBytes: total,
		UsedBytes:  used,
		FreeBytes:  free,
		UsedPct:    pct(used, total),
	}

	swapUsed := uint64(0)
	if swapTotal > swapFree {
		swapUsed = swapTotal - swapFree
	}
	swap := Swap{
		TotalBytes: swapTotal,
		UsedBytes:  swapUsed,
		UsedPct:    pct(swapUsed, swapTotal),
	}
	return mem, swap, nil
}

// readDisk is implemented per-OS. On Linux it calls statfs(2) against
// the host root mount; on other platforms (only used for `go vet` on a
// dev workstation) it returns ErrUnsupported.

// cpuTotals holds the cumulative jiffy counters from /proc/stat's first
// "cpu" line. We only need the total of every column and the idle slice
// to compute "active%" = (deltaTotal - deltaIdle) / deltaTotal.
type cpuTotals struct {
	total uint64
	idle  uint64
	at    time.Time
}

func readCPUTotals() (cpuTotals, error) {
	f, err := os.Open(HostProcDir + "/stat")
	if err != nil {
		return cpuTotals{}, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		if err := sc.Err(); err != nil {
			return cpuTotals{}, err
		}
		return cpuTotals{}, fmt.Errorf("empty /proc/stat")
	}
	line := sc.Text()
	if !strings.HasPrefix(line, "cpu ") {
		return cpuTotals{}, fmt.Errorf("unexpected first /proc/stat line: %q", line)
	}
	fields := strings.Fields(line[len("cpu "):])
	// fields: user nice system idle iowait irq softirq steal guest guest_nice
	if len(fields) < 4 {
		return cpuTotals{}, fmt.Errorf("malformed /proc/stat cpu line: %q", line)
	}
	var total uint64
	var idle uint64
	for i, s := range fields {
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return cpuTotals{}, err
		}
		total += n
		// /proc/stat columns: user(0) nice(1) system(2) idle(3) iowait(4) ...
		// Treat "idle + iowait" as not-active; iowait is time blocked on disk
		// rather than time the CPU spent computing for the workload.
		if i == 3 || i == 4 {
			idle += n
		}
	}
	return cpuTotals{total: total, idle: idle, at: time.Now()}, nil
}

func (r *Reader) readCPUPct() (*float64, error) {
	cur, err := readCPUTotals()
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.hasCPU {
		r.lastCPU = cur
		r.hasCPU = true
		// First call — no baseline available yet. Returning nil lets the
		// caller render "-" rather than a misleading 0%.
		return nil, nil
	}

	dt := cur.total - r.lastCPU.total
	di := cur.idle - r.lastCPU.idle
	r.lastCPU = cur

	if dt == 0 {
		zero := 0.0
		return &zero, nil
	}
	active := float64(dt-di) / float64(dt) * 100
	if active < 0 {
		active = 0
	} else if active > 100 {
		active = 100
	}
	return &active, nil
}

// readCPUCount returns the count of online CPUs from /proc/cpuinfo.
// Falls back to runtime.NumCPU() at the call site if this fails — the
// number is only used for threshold colouring.
func readCPUCount() (int, error) {
	f, err := os.Open(HostProcDir + "/cpuinfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	count := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "processor") {
			count++
		}
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	if count == 0 {
		return 0, fmt.Errorf("no processor lines in /proc/cpuinfo")
	}
	return count, nil
}

func pct(used, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return float64(used) / float64(total) * 100
}
