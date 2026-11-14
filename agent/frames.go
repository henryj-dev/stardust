package main

// This file holds only the construction of the three frames the agent sends.
//
// Why it is separate: the keys of these maps are the wire contract itself. They
// used to be built inline in session() (hello, beat) and collectMetrics()
// (metrics), where tests could not call them. If tests cannot call them, the
// golden frames end up written by hand instead of by Go, and the fixtures
// silently drift from what the agent actually sends.
//
// Keep these functions pure: no clock, file or process reads here. The moment
// they read anything, golden comparison becomes impossible and this file loses
// its purpose. Callers (session, collectMetrics) gather the values; this file
// only shapes them.
//
// Changing a key breaks the golden test in frames_test.go. Updating the golden
// files then breaks the server's protocol test, which reads the same files.
// Those two steps together are the contract.

// helloFrame is sent once right after connecting. host_profile does not change,
// so it is sent only here.
func helloFrame(agentVersion string, prof HostProfile) map[string]any {
	return map[string]any{
		"type":             "hello",
		"agent_version":    agentVersion,
		"protocol_version": protocolVersion,
		"host_profile":     prof,
	}
}

// beatFrame is the minimal frame sent every 5 s. Heavier collection lives in
// the metrics frame. A negative uptimeS (read failure) becomes null; 0 would
// read as "just booted".
func beatFrame(seq int64, uptimeS int64, bootID string) map[string]any {
	return map[string]any{
		"type":     "beat",
		"seq":      seq,
		"uptime_s": nilIfNeg(uptimeS),
		"boot_id":  nilIfEmpty(bootID),
	}
}

// metricsFrame is sent every 60 s. When load cannot be read, the key is
// omitted entirely; that is the established behaviour and is kept. The server
// treats a missing key and null the same, but changing the shape here would
// make the golden files diverge from real output.
func metricsFrame(l1, l5, l15 float64, loadOK bool, memTotalMb, memAvailMb int64, disk map[string]int, systemd map[string]string, net map[string]NetCounters) map[string]any {
	m := map[string]any{
		"type":         "metrics",
		"mem_total_mb": nilIfNeg(memTotalMb),
		"mem_avail_mb": nilIfNeg(memAvailMb),
		"disk":         disk,
		"systemd":      systemd,
		// Cumulative counters. To compute a daily total the server must sum only
		// positive deltas; counters reset to 0 on reboot, so max minus min would
		// go negative on that day.
		"net": net,
	}
	if loadOK {
		m["load"] = []float64{l1, l5, l15}
	}
	return m
}
