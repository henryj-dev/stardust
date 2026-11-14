package main

// Host state collection. Parsing of /proc is split into pure functions so it
// can be tested; thin wrappers do the actual file reads, and every parsing rule
// is verified here.

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// HostProfile is sent once per connection (the values do not change).
//
// Why cpu_model is here: a cloud provider can move a VM to a host with an
// older CPU (x86-64-v2, e.g. Atom), and a distribution built for a newer
// baseline will then fail to boot on the next reboot. An agent that does not
// report the CPU cannot notice such a silent move. The server records a change
// in cpu_model as a host_migrated event: a warning before the outage rather
// than a record of it.
type HostProfile struct {
	CPUModel  string   `json:"cpu_model"`
	CPUFlags  []string `json:"cpu_flags"`
	Kernel    string   `json:"kernel"`
	MachineID string   `json:"machine_id"`
}

// Only the flags needed to tell x86-64 microarchitecture levels apart. The full
// list runs to hundreds of entries and would threaten the 4 KB frame limit.
var interestingFlags = map[string]bool{
	"sse4_2": true, "popcnt": true, "avx": true, "avx2": true,
	"bmi2": true, "fma": true, "f16c": true, "movbe": true,
}

// ParseCPUInfo extracts the model name and the interesting flags from
// /proc/cpuinfo.
func ParseCPUInfo(s string) (model string, flags []string) {
	seen := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		line := sc.Text()
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		switch k {
		case "model name":
			if model == "" {
				model = v
			}
		case "flags", "Features":
			for _, f := range strings.Fields(v) {
				if interestingFlags[f] && !seen[f] {
					seen[f] = true
					flags = append(flags, f)
				}
			}
		}
	}
	return model, flags
}

// ParseUptime returns the first field of /proc/uptime (seconds) as an integer.
// It returns -1 on failure; returning 0 would be misread as "just booted".
func ParseUptime(s string) int64 {
	f := strings.Fields(s)
	if len(f) == 0 {
		return -1
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil || v < 0 {
		return -1
	}
	return int64(v)
}

// ParseLoadAvg returns the 1, 5 and 15 minute values from /proc/loadavg.
func ParseLoadAvg(s string) (l1, l5, l15 float64, ok bool) {
	f := strings.Fields(s)
	if len(f) < 3 {
		return 0, 0, 0, false
	}
	var err error
	if l1, err = strconv.ParseFloat(f[0], 64); err != nil {
		return 0, 0, 0, false
	}
	if l5, err = strconv.ParseFloat(f[1], 64); err != nil {
		return 0, 0, 0, false
	}
	if l15, err = strconv.ParseFloat(f[2], 64); err != nil {
		return 0, 0, 0, false
	}
	return l1, l5, l15, true
}

// ParseMemInfo returns MemTotal and MemAvailable in MB.
// On kernels without MemAvailable (before 3.14) avail is -1. Falling back to
// MemFree would count page cache as unavailable and make memory look much
// worse than it is.
func ParseMemInfo(s string) (totalMB, availMB int64) {
	totalMB, availMB = -1, -1
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		kb, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSpace(k) {
		case "MemTotal":
			totalMB = kb / 1024
		case "MemAvailable":
			availMB = kb / 1024
		}
	}
	return totalMB, availMB
}

// ReadTrim reads a file and trims surrounding whitespace. A missing file yields
// an empty string, not an error: one failed probe must not block the whole beat.
func ReadTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readHostProfile() HostProfile {
	model, flags := ParseCPUInfo(ReadTrim("/proc/cpuinfo"))
	return HostProfile{
		CPUModel:  model,
		CPUFlags:  flags,
		Kernel:    ReadTrim("/proc/sys/kernel/osrelease"),
		MachineID: ReadTrim("/etc/machine-id"),
	}
}

func readUptime() int64  { return ParseUptime(ReadTrim("/proc/uptime")) }
func readBootID() string { return ReadTrim("/proc/sys/kernel/random/boot_id") }

// NetCounters holds one interface's cumulative byte counts since boot.
//
// These are cumulative values, not usage. Consumers must sum only the positive
// deltas between consecutive samples: counters reset to 0 on reboot, so max
// minus min would go negative on that day. Hosts do reboot in practice.
type NetCounters struct {
	RxBytes int64 `json:"rx"`
	TxBytes int64 `json:"tx"`
}

// ParseNetDev extracts cumulative rx/tx bytes per interface from /proc/net/dev.
//
// The format is two header lines followed by
// `name: rx_bytes rx_packets ... tx_bytes tx_packets ...`, and there may or may
// not be whitespace between the name and the colon (long names run into it).
// So the line is split at the colon first rather than with Fields.
//
// IPv4 and IPv6 are not separated here: the kernel does not expose per-interface
// IPv4 byte counts (/proc/net/dev_snmp6 covers IPv6 only and has no IPv4
// counterpart). Deriving IPv4 by subtraction would mix in L2 headers and ARP and
// would not be accurate, so this frame sends only the totals the kernel reports.
func ParseNetDev(s string) map[string]NetCounters {
	out := map[string]NetCounters{}
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue // filters out the two header lines
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		f := strings.Fields(rest)
		// Eight rx fields (bytes packets errs drop fifo frame compressed
		// multicast), then tx bytes.
		if len(f) < 9 {
			continue
		}
		rx, err1 := strconv.ParseInt(f[0], 10, 64)
		tx, err2 := strconv.ParseInt(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out[name] = NetCounters{RxBytes: rx, TxBytes: tx}
	}
	return out
}

// KeepInterface decides whether an interface is meaningful for traffic totals.
//
// Without this filter the numbers are meaningless. A Kubernetes node can have
// dozens of interfaces, most of them pod veths (e.g. Cilium's lxc*). Summing
// them all counts the same packet once on the physical NIC and again on the
// veth, inflating totals several times over.
//
// The decision is based on whether /sys/class/net/<if>/device exists, not on
// the name: if it exists, the NIC is backed by hardware. Filtering by name
// prefix would silently let interfaces through the day a CNI changes its naming
// scheme.
//
// As an exception, wg* interfaces are kept even though they have no hardware:
// the mesh traffic runs over them, so they carry real traffic. lo is dropped
// (traffic to itself).
func KeepInterface(name string, hasDevice bool) bool {
	if name == "lo" {
		return false
	}
	if strings.HasPrefix(name, "wg") {
		return true
	}
	return hasDevice
}
