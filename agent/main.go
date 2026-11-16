// Command agent is the stardust node agent. It holds a WebSocket open to the
// server and sends a heartbeat ("beat") every 5 seconds, plus heavier metrics
// every 60 seconds.
//
// An optional HTTP agent that reports once a minute can run alongside it as a
// backstop. The server records the two channels separately, so if only the
// socket dies the node shows as "socket degraded" rather than "host down".
//
// Why Go: to avoid maintaining a hand-written RFC 6455 client (fragmented
// frames, interleaved control frames, the close handshake, back-pressure). The
// binary is statically linked, so it has no runtime dependencies, and it is
// built with GOAMD64=v1 so it requires no particular CPU features. Portability
// matters here because a VM can be silently moved to an older CPU generation.
// The agent cannot prevent the OS failing to boot after such a move, but by
// reporting cpu_model it lets the server detect the move before the next reboot.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

var version = "dev" // set at build time with -ldflags

const (
	protocolVersion = 1
	beatInterval    = 5 * time.Second
	metricsInterval = 60 * time.Second
	// The server treats 15 s (three beats) of silence as a lost connection.
	// Keep the write timeout well below that.
	writeTimeout = 8 * time.Second
	// A session that lasted at least this long counts as healthy, and the
	// reconnect backoff is reset. This must be comfortably longer than the
	// server's freshness window (15 s); otherwise a session that never produced
	// a single observation could earn a reset.
	sessionStableAfter = 60 * time.Second
	// Upper bound for the reconnect wait. It must stay below the server's grace
	// period (90 s); if it were equal, a normal reconnect could exceed the grace
	// period and the node would be falsely reported as missing.
	maxBackoff = 30 * time.Second
	confDir    = "/etc/node-agent"
	socketPath = "/infra/node-socket"
)

func main() {
	log.SetFlags(0)
	token := readConf("token")
	if token == "" {
		// Exit quietly without a token, so systemd does not keep restarting the
		// agent on a host where it has not been set up yet.
		log.Println("[node-agent] no token configured, exiting")
		return
	}
	base := readConf("url")
	if base == "" {
		// Same as the missing token case: no server URL means nothing to do.
		log.Println("[node-agent] no url configured, exiting")
		return
	}
	wsURL := socketURL(base)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Jittered backoff from 1 s up to 30 s, reset to 1 s after a session that
	// stayed up (see nextBackoff). The cap must stay below the server's 90 s
	// grace period, or a normal reconnect could be reported as missing.
	backoff := time.Second
	// The metrics schedule lives outside the session so it survives reconnects
	// (see metricsSched).
	ms := &metricsSched{}
	for ctx.Err() == nil {
		start := time.Now()
		err := session(ctx, wsURL, token, ms)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Printf("[node-agent] session ended: %v", err)
		}
		// Reset the backoff after a session that stayed up for a while. Without
		// this, a few early failures would leave the process waiting 30 s on every
		// reconnect for its whole lifetime, and since the server's freshness
		// window is 15 s the node would look degraded each time.
		//
		// The point is to reset on "stayed up", not on "connected": if a
		// connection that drops immediately earned a reset, that would turn into
		// a reconnect storm. The threshold is well above the freshness window, so
		// only a session that produced at least one real observation counts.
		backoff = nextBackoff(backoff, time.Since(start))
		// Add jitter so that all hosts do not reconnect at the same moment.
		sleep := backoff + time.Duration(rand.Int63n(int64(backoff/2+1)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(sleep):
		}
	}
}

// socketURL turns the configured server base URL into the WebSocket URL:
// https becomes wss, http becomes ws, and the socket path is appended.
func socketURL(base string) string {
	u := strings.TrimRight(base, "/")
	switch {
	case strings.HasPrefix(u, "https://"):
		u = "wss://" + strings.TrimPrefix(u, "https://")
	case strings.HasPrefix(u, "http://"):
		u = "ws://" + strings.TrimPrefix(u, "http://")
	}
	return u + socketPath
}

// nextBackoff picks the next reconnect wait based on how long the session that
// just ended lasted.
//
// Without a reset, a few early failures would pin the process at the cap (30 s)
// for its whole lifetime, and with the server's 15 s freshness window the node
// would look degraded on every reconnect.
//
// The reset is based on the session having stayed up, not on it having
// connected: if a connection that drops immediately earned a reset, that would
// turn into a reconnect storm.
func nextBackoff(current, lasted time.Duration) time.Duration {
	if lasted >= sessionStableAfter {
		return time.Second
	}
	// Multiply first, then clamp. Doubling whenever current < maxBackoff would
	// turn 16 s into 32 s and exceed the cap, and a wait above the cap eats into
	// the margin before the server's 90 s grace period.
	next := current * 2
	if next > maxBackoff {
		return maxBackoff
	}
	return next
}

func readConf(name string) string { return ReadTrim(confDir + "/" + name) }

// session manages the lifetime of one connection. When it returns, the caller
// reconnects.
func session(ctx context.Context, url, token string, ms *metricsSched) error {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(dialCtx, url, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + token}},
	})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer c.CloseNow()
	// The server caps frames at 4 KB. Allow some headroom but keep a limit.
	c.SetReadLimit(8 << 10)

	// Send hello right after connecting. host_profile does not change, so it is
	// sent only here.
	if err := writeJSON(ctx, c, helloFrame(version, readHostProfile())); err != nil {
		return fmt.Errorf("hello: %w", err)
	}

	// Drain server frames; if nobody reads, flow control stalls. The contents
	// are not used yet.
	readErr := make(chan error, 1)
	go func() {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				readErr <- err
				return
			}
		}
	}()

	beatT := time.NewTicker(beatInterval)
	defer beatT.Stop()

	return runLoop(ctx, loopDeps{
		now:     time.Now,
		after:   realAfter,
		beat:    beatT.C,
		readErr: readErr,
		sendBeat: func(seq int64) error {
			return writeJSON(ctx, c, beatFrame(seq, readUptime(), readBootID()))
		},
		sendMetrics: func() error { return writeJSON(ctx, c, collectMetrics()) },
		closeNormal: func() { _ = c.Close(websocket.StatusNormalClosure, "shutdown") },
	}, ms)
}

// metricsSched holds, for the lifetime of the process, the time at which the
// next metrics collection should start.
//
// Contract: collections start on a fixed 60 s grid, and that grid is kept
// across sessions. If the scheduled time has already passed when a session
// starts, collect immediately and use that moment as the new base. So a healthy
// connection yields 1440 samples a day (matching the server's expected samples
// per day), a short reconnect keeps the original schedule (no second sample in
// the same minute), and after a long gap the agent never waits more than 60 s.
//
// This is the interval between collection starts on the client. The server
// stamps `at` with its own processing time and queues per instance, so stored
// `at` values are not strictly guaranteed to be at least 60 s apart.
//
// Earlier designs and why they were wrong:
//   - Restarting the 60 s count in every session delayed the first sample after
//     a reconnect by 60 s, so every server redeploy dropped that minute's sample
//     for every node.
//   - Always sending immediately on reconnect produced a second sample in the
//     same minute when a connection dropped 5 s after a sample and came back,
//     inflating per-minute counts.
//   - Rescheduling at "last send finished + 60 s" accumulated the collection
//     time every cycle: with a 2 s collection that gives about 1394 samples a
//     day, with 7 s about 1290, below the threshold for full coverage (1296).
type metricsSched struct {
	next time.Time
	set  bool
}

// due reports whether a new session should collect immediately: either nothing
// has been scheduled yet or the scheduled time has passed.
func (m *metricsSched) due(now time.Time) bool {
	return !m.set || !now.Before(m.next)
}

// following returns the scheduled time after a collection that started at
// start. With rebase, start becomes the new base; otherwise it is one step on
// the existing grid, so collection time does not shift the schedule. If that
// step is not after now (when collection finished), it skips ahead to the first
// slot after now instead of sending a burst of catch-up samples.
func (m *metricsSched) following(start, now time.Time, rebase bool) time.Time {
	base := m.next
	if rebase || !m.set {
		base = start
	}
	next := base.Add(metricsInterval)
	if !next.After(now) {
		k := now.Sub(next)/metricsInterval + 1
		next = next.Add(k * metricsInterval)
	}
	return next
}

// afterFunc is a one-shot timer. Tests inject a fake clock through it.
type afterFunc func(d time.Duration) (<-chan time.Time, func())

func realAfter(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTimer(d)
	return t.C, func() { t.Stop() }
}

// loopDeps is everything the session loop touches in the outside world. The
// socket and clock come in only through here, so tests can run the real loop
// (the select) against fake channels.
type loopDeps struct {
	now         func() time.Time
	after       afterFunc
	beat        <-chan time.Time
	readErr     <-chan error
	sendBeat    func(seq int64) error
	sendMetrics func() error
	closeNormal func()
}

// runLoop is the session lifetime after the connection is up (after hello).
//
// Metrics are not driven by a time.Ticker: the schedule has to live outside the
// session (metricsSched) to survive reconnects, and the skip-ahead that
// prevents catch-up bursts has to be decided here.
func runLoop(ctx context.Context, d loopDeps, ms *metricsSched) error {
	now := d.now()
	rebase := ms.due(now)
	wait := time.Duration(0)
	if !rebase {
		wait = ms.next.Sub(now)
	}
	metricsC, stopMetrics := d.after(wait)
	defer func() { stopMetrics() }() // stop whichever timer was armed last

	var seq int64
	for {
		select {
		case <-ctx.Done():
			// Clean shutdown: send a close frame so the server drops the session
			// right away.
			d.closeNormal()
			return nil
		case err := <-d.readErr:
			return fmt.Errorf("read: %w", err)
		case <-d.beat:
			seq++
			if err := d.sendBeat(seq); err != nil {
				return fmt.Errorf("beat: %w", err)
			}
		case <-metricsC:
			start := d.now()
			if err := d.sendMetrics(); err != nil {
				// Leave the schedule alone: the next session sees it as overdue and
				// collects immediately.
				return fmt.Errorf("metrics: %w", err)
			}
			done := d.now()
			ms.next = ms.following(start, done, rebase)
			ms.set = true
			rebase = false
			stopMetrics()
			metricsC, stopMetrics = d.after(ms.next.Sub(done))
		}
	}
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

func nilIfNeg(v int64) any {
	if v < 0 {
		return nil
	}
	return v
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// collectMetrics gathers the heavier values sent every 60 s. They are kept out
// of the beat so the beat stays cheap; running df and systemctl every 5 s would
// add up.
func collectMetrics() map[string]any {
	l1, l5, l15, ok := ParseLoadAvg(ReadTrim("/proc/loadavg"))
	total, avail := ParseMemInfo(ReadTrim("/proc/meminfo"))
	// frames.go builds the shape; the golden test calls the same function.
	return metricsFrame(l1, l5, l15, ok, total, avail, diskUsage(), systemdStates(), netUsage())
}

// netUsage returns cumulative rx/tx bytes since boot for each interface.
//
// KeepInterface decides which interfaces to keep; this function only asks the
// filesystem. An interface with /sys/class/net/<if>/device is backed by
// hardware.
// These are cumulative counters, not usage. Consumers compute daily totals by
// summing the positive deltas between consecutive samples, because counters
// reset to 0 on reboot.
func netUsage() map[string]NetCounters {
	out := map[string]NetCounters{}
	for name, c := range ParseNetDev(ReadTrim("/proc/net/dev")) {
		_, err := os.Stat("/sys/class/net/" + name + "/device")
		if !KeepInterface(name, err == nil) {
			continue
		}
		out[name] = c
	}
	return out
}

// systemdStates reports unit states. Failures yield empty values; one failed
// probe must not block the whole metrics frame.
func systemdStates() map[string]string {
	out := map[string]string{}
	for _, u := range []string{"k3s", "wg-quick@wg0", "dnsmasq", "firewalld", "containerd"} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		b, _ := exec.CommandContext(ctx, "systemctl", "is-active", u).Output()
		cancel()
		s := strings.TrimSpace(string(b))
		if s == "" {
			s = "absent"
		}
		out[u] = s
	}
	return out
}

// diskUsage reports usage percentage per mount point, using statfs.
// Keep it per mount: collapsing to a single percentage hides which filesystem
// is full.
func diskUsage() map[string]int {
	out := map[string]int{}
	mounts := ReadTrim("/proc/mounts")
	seen := map[string]bool{}
	for _, line := range strings.Split(mounts, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		dev, mp, fstype := f[0], f[1], f[2]
		// Skip virtual filesystems: they have no meaningful capacity or are
		// always 0 or 100 percent, which is just noise.
		switch fstype {
		case "tmpfs", "devtmpfs", "overlay", "efivarfs", "vfat", "proc", "sysfs", "cgroup2", "squashfs":
			continue
		}
		if !strings.HasPrefix(dev, "/dev/") || seen[mp] {
			continue
		}
		seen[mp] = true
		var st syscall.Statfs_t
		if err := syscall.Statfs(mp, &st); err != nil {
			continue
		}
		if st.Blocks == 0 {
			continue
		}
		used := st.Blocks - st.Bfree
		// Same definition as df: relative to space available to users
		// (reserved blocks excluded).
		denom := used + st.Bavail
		if denom == 0 {
			continue
		}
		out[mp] = int(used * 100 / denom)
	}
	return out
}
