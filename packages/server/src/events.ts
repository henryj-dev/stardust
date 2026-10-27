/**
 * Pushes run changes to subscribers. One LISTEN connection receives
 * "<project> <run>" on `stardust_runs` (migration 0003); bursts for the same
 * run — a run and its jobs change together — are coalesced, and each
 * subscriber of that project gets the run's current view once.
 */
import { getRun, type RunView, type Sql } from "@stardust/db";

type Listener = (run: RunView) => void;

export class RunEvents {
  private readonly sql: Sql;
  private readonly coalesceMs: number;
  private readonly subscribers = new Map<string, Set<Listener>>();
  private readonly pending = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private unlisten: (() => Promise<void>) | null = null;

  constructor(sql: Sql, coalesceMs = 50) {
    this.sql = sql;
    this.coalesceMs = coalesceMs;
  }

  async start(): Promise<void> {
    const listener = await this.sql.listen("stardust_runs", (payload) => {
      const [project, run] = payload.split(" ");
      if (!project || !run || !this.subscribers.has(project)) return;
      this.pending.set(run, project);
      this.timer ??= setTimeout(() => void this.flush(), this.coalesceMs);
    });
    this.unlisten = listener.unlisten;
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [runId, project] of batch) {
      const listeners = this.subscribers.get(project);
      if (!listeners?.size) continue;
      const run = await getRun(this.sql, runId).catch(() => null);
      if (!run) continue;
      for (const listener of listeners) listener(run);
    }
  }

  subscribe(project: string, listener: Listener): () => void {
    let set = this.subscribers.get(project);
    if (!set) {
      set = new Set();
      this.subscribers.set(project, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(project);
    };
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.unlisten?.();
  }
}
