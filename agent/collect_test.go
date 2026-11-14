package main

import "testing"

func TestParseCPUInfo(t *testing.T) {
	// Realistic shape (Xeon). Only the interesting flags may be kept, so the
	// frame stays well under the size limit.
	in := `processor	: 0
model name	: Intel(R) Xeon(R) Processor @ 2.30GHz
flags		: fpu vme sse4_2 popcnt avx avx2 bmi2 lm nx
processor	: 1
model name	: Intel(R) Xeon(R) Processor @ 2.30GHz
flags		: fpu vme sse4_2 popcnt avx avx2 bmi2 lm nx
`
	model, flags := ParseCPUInfo(in)
	if model != "Intel(R) Xeon(R) Processor @ 2.30GHz" {
		t.Fatalf("model = %q", model)
	}
	// One set of flags even with several CPUs.
	for _, want := range []string{"sse4_2", "popcnt", "avx", "avx2", "bmi2"} {
		found := false
		for _, f := range flags {
			if f == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("flag %s missing: %v", want, flags)
		}
	}
	if len(flags) != 5 {
		t.Fatalf("only the interesting flags should remain: %v", flags)
	}
}

func TestParseCPUInfoAtom(t *testing.T) {
	// The older-CPU case: no avx/avx2 (x86-64-v2). The server raises
	// host_migrated when cpu_model changes, so the model name must be read.
	in := "model name\t: Intel(R) Atom(TM) CPU C3558 @ 2.20GHz\nflags\t: fpu sse4_2 popcnt\n"
	model, flags := ParseCPUInfo(in)
	if model == "" {
		t.Fatal("without the Atom model name a host migration cannot be detected")
	}
	for _, f := range flags {
		if f == "avx2" {
			t.Fatal("reported a flag that is not present")
		}
	}
}

func TestParseCPUInfoEmpty(t *testing.T) {
	model, flags := ParseCPUInfo("")
	if model != "" || len(flags) != 0 {
		t.Fatal("must not invent values for empty input")
	}
}

func TestParseUptime(t *testing.T) {
	if got := ParseUptime("1190203.45 4700000.00"); got != 1190203 {
		t.Fatalf("got %d", got)
	}
	// Returning 0 on failure would read as "just booted" and cause a false
	// reboot event.
	for _, bad := range []string{"", "abc", "-5 1"} {
		if got := ParseUptime(bad); got != -1 {
			t.Fatalf("%q -> %d, want -1", bad, got)
		}
	}
}

func TestParseLoadAvg(t *testing.T) {
	l1, l5, l15, ok := ParseLoadAvg("0.52 0.58 0.59 1/523 12345")
	if !ok || l1 != 0.52 || l5 != 0.58 || l15 != 0.59 {
		t.Fatalf("%v %v %v %v", l1, l5, l15, ok)
	}
	if _, _, _, ok := ParseLoadAvg("0.52 0.58"); ok {
		t.Fatal("too few fields should return false")
	}
}

func TestParseMemInfo(t *testing.T) {
	in := "MemTotal:        7928000 kB\nMemFree:          100000 kB\nMemAvailable:    2843000 kB\n"
	total, avail := ParseMemInfo(in)
	if total != 7742 || avail != 2776 {
		t.Fatalf("total=%d avail=%d", total, avail)
	}
}

func TestParseMemInfoNoAvailable(t *testing.T) {
	// A kernel without MemAvailable. Falling back to MemFree would count page
	// cache as unavailable and look much worse than reality, so report -1
	// (unknown).
	total, avail := ParseMemInfo("MemTotal: 1024000 kB\nMemFree: 512000 kB\n")
	if total != 1000 {
		t.Fatalf("total=%d", total)
	}
	if avail != -1 {
		t.Fatalf("avail=%d; must not invent an unknown value", avail)
	}
}

func TestReadTrimMissing(t *testing.T) {
	// One failed probe must not block the whole beat.
	if got := ReadTrim("/nonexistent/probe/path"); got != "" {
		t.Fatalf("got %q", got)
	}
}

// A sample taken verbatim from a real /proc/net/dev. A hand-made sample tends
// to miss the case where the name runs into the colon: long interface names
// lose the separating space, and a Fields-based parser then silently shifts by
// one column.
const procNetDevSample = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567    8910    0    0    0     0          0         0  1234567    8910    0    0    0     0       0          0
enp1s0: 233679756822 53416516    0    0    0     0          0         0 16607512487 44958902    0    0    0     0       0          0
enp8s0: 105013845885 123292235    0   15    0     0          0         0 59945337224 50149550    0    0    0     0       0          0
lxc1144d0c0ab16: 137140371656 25199394    0    0    0     0          0         0 5413477929 13666755    0    0    0     0       0          0
cilium_host:  101790    1453    0    0    0     0          0         0  1756840   23691    0    0    0     0       0          0
`

func TestParseNetDev(t *testing.T) {
	got := ParseNetDev(procNetDevSample)

	// The two header lines must not be parsed as interfaces.
	if len(got) != 5 {
		t.Fatalf("%d interfaces; a header line was included or a line was dropped: %v", len(got), got)
	}

	// A line whose name has no space before the colon must still parse. If this
	// fails, the parser has gone back to splitting with Fields.
	if c, ok := got["lxc1144d0c0ab16"]; !ok || c.RxBytes != 137140371656 {
		t.Fatalf("failed to read a long name with no space before the colon: %+v", got["lxc1144d0c0ab16"])
	}

	// rx is the first field, tx the ninth. Any column shift is caught here.
	if c := got["enp1s0"]; c.RxBytes != 233679756822 || c.TxBytes != 16607512487 {
		t.Fatalf("enp1s0 rx/tx wrong (columns shifted?): %+v", c)
	}
	if c := got["cilium_host"]; c.RxBytes != 101790 || c.TxBytes != 1756840 {
		t.Fatalf("columns shifted on a line with two spaces after the colon: %+v", c)
	}
}

func TestParseNetDevRejectsShortLines(t *testing.T) {
	// Lines with too few fields are dropped. Filling with 0 would read as "no
	// traffic", turning a read failure into a normal-looking value.
	got := ParseNetDev("eth0: 1 2 3\nbad line without colon\n:\n")
	if len(got) != 0 {
		t.Fatalf("accepted incomplete lines: %v", got)
	}
}

func TestKeepInterface(t *testing.T) {
	// A Kubernetes node can have dozens of interfaces, most of them pod veths.
	// Without filtering, the same packet is counted on both the physical NIC
	// and the veth, inflating totals.
	cases := []struct {
		name      string
		hasDevice bool
		want      bool
		why       string
	}{
		{"enp1s0", true, true, "physical NIC"},
		{"enp8s0", true, true, "physical NIC (private network)"},
		{"lo", false, false, "traffic to itself"},
		{"lxc1144d0c0ab16", false, false, "Cilium veth, duplicates the physical NIC"},
		{"cilium_host", false, false, "CNI virtual device"},
		{"wg0", false, true, "no hardware, but real mesh traffic runs over it"},
		// The decision is based on the device, not the name. If a CNI changes its
		// naming scheme, interfaces without hardware are still excluded; a prefix
		// list would let them through.
		{"unknownname", false, false, "no hardware, excluded"},
		{"unknownname", true, true, "has hardware, included"},
	}
	for _, c := range cases {
		if got := KeepInterface(c.name, c.hasDevice); got != c.want {
			t.Errorf("KeepInterface(%q, device=%v) = %v, want %v (%s)",
				c.name, c.hasDevice, got, c.want, c.why)
		}
	}
}

func TestSocketURL(t *testing.T) {
	cases := []struct{ base, want string }{
		{"https://example.com", "wss://example.com/infra/node-socket"},
		{"https://example.com/", "wss://example.com/infra/node-socket"},
		{"http://example.com:8080", "ws://example.com:8080/infra/node-socket"},
		{"http://example.com:8080//", "ws://example.com:8080/infra/node-socket"},
		{"wss://example.com", "wss://example.com/infra/node-socket"},
	}
	for _, c := range cases {
		if got := socketURL(c.base); got != c.want {
			t.Errorf("socketURL(%q) = %q, want %q", c.base, got, c.want)
		}
	}
}
