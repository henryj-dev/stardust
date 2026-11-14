package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// The source of truth for the golden frames is Go. A hand-written fixture
// silently drifts the moment the agent changes a key, and then the contract
// test protects the fixture rather than the contract. So this test writes the
// files (with -update) and otherwise only compares against them.
//
// What is compared is the wire bytes: exactly what json.Marshal produces (the
// standard library sorts map keys). The golden files may be pretty-printed by a
// formatter, so they are compacted before comparison; key order and values must
// still match exactly.
//
// Every input here is a fixed value. If time.Now() or /proc reads leaked into
// the payload, this comparison would fail on every run; that is why frames.go
// is pure.
//
// The server's protocol test reads the same files and runs them through its
// parser. Updating only this side breaks that test.

var updateGolden = flag.Bool("update", false, "rewrite the golden frame files from the current output")

const goldenDir = "testdata/frames"

// goldenFrames maps name to frame. The inputs are fixed values shaped like real
// measurements.
func goldenFrames() map[string]map[string]any {
	return map[string]map[string]any{
		"hello": helloFrame("1.4.2", HostProfile{
			CPUModel:  "Intel(R) Xeon(R) Processor @ 2.30GHz",
			CPUFlags:  []string{"sse4_2", "popcnt", "avx", "avx2", "bmi2"},
			Kernel:    "6.12.0-55.9.1.el10_0.x86_64",
			MachineID: "9d2a1f0c4b8e4a1fa0c3b7e6d5f41234",
		}),
		"beat": beatFrame(42, 987654, "6d5aa963-6aef-4e57-99d9-6e75bc978a03"),
		"metrics": metricsFrame(
			0.42, 0.75, 1.03, true,
			16384, 9012,
			map[string]int{"/": 31, "/var": 58},
			map[string]string{
				"k3s":          "active",
				"wg-quick@wg0": "active",
				"dnsmasq":      "inactive",
				"firewalld":    "absent",
				"containerd":   "active",
			},
			// Magnitudes are modelled on a real node. Cumulative counters in the
			// tens of GB are normal, and golden values with small numbers would
			// make the frame size check looser than reality (int64 digits are
			// bytes on the wire).
			map[string]NetCounters{
				"enp1s0": {RxBytes: 233679756822, TxBytes: 16607512487},
				"enp8s0": {RxBytes: 105013845885, TxBytes: 59945337224},
				"wg0":    {RxBytes: 1530955104, TxBytes: 1529382432},
			},
		),
	}
}

func TestFrameGolden(t *testing.T) {
	for name, frame := range goldenFrames() {
		got, err := json.Marshal(frame)
		if err != nil {
			t.Fatalf("%s: marshal: %v", name, err)
		}
		// The server accepts at most 4 KB per frame. A golden frame above that
		// would enshrine a frame the live server rejects.
		if len(got) > 4096 {
			t.Fatalf("%s: %d bytes, over the 4096 byte frame limit", name, len(got))
		}
		path := filepath.Join(goldenDir, name+".json")

		if *updateGolden {
			if err := os.MkdirAll(goldenDir, 0o755); err != nil {
				t.Fatalf("%s: mkdir: %v", name, err)
			}
			if err := os.WriteFile(path, append(got, '\n'), 0o644); err != nil {
				t.Fatalf("%s: write: %v", name, err)
			}
			t.Logf("%s updated (%d bytes)", path, len(got))
			continue
		}

		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: golden file missing (%v); create it with `go test ./... -run TestFrameGolden -update`", path, err)
		}
		// Byte for byte: the golden file is exactly what the agent writes.
		want := bytes.TrimRight(raw, "\n")
		if !bytes.Equal(want, got) {
			t.Errorf("%s differs from the current frame\ngolden:  %s\ncurrent: %s\n"+
				"if the change is intended, update with -update and check the server's protocol test too",
				path, want, got)
		}
	}
}

// Assert separately that the keys are actually present, so the golden test
// cannot pass on an empty frame. Without this, if frame construction broke
// entirely (an empty map), updating the golden files would turn the test green.
func TestFrameKeys(t *testing.T) {
	want := map[string][]string{
		"hello":   {"type", "agent_version", "protocol_version", "host_profile"},
		"beat":    {"type", "seq", "uptime_s", "boot_id"},
		"metrics": {"type", "load", "mem_total_mb", "mem_avail_mb", "disk", "systemd", "net"},
	}
	frames := goldenFrames()
	for name, keys := range want {
		f, ok := frames[name]
		if !ok {
			t.Fatalf("frame %s is missing", name)
		}
		for _, k := range keys {
			if _, ok := f[k]; !ok {
				t.Errorf("%s: key %q is missing; this changes the wire contract", name, k)
			}
		}
		if len(f) != len(keys) {
			t.Errorf("%s: %d keys, want %d; if you added a key, update this list and the golden files together", name, len(f), len(keys))
		}
	}
}
