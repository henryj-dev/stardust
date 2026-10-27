import { hostname } from "node:os";
import { loadConfig } from "@stardust/config";
import type { Logger } from "@stardust/core";
import { connect, migrate } from "@stardust/db";
import { type JobHandler, runWorker } from "./loop.ts";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

const log: Logger = {
  debug: (message, fields) => console.debug(JSON.stringify({ level: "debug", message, ...fields })),
  info: (message, fields) => console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};

let config: Awaited<ReturnType<typeof loadConfig>>;
try {
  config = await loadConfig(configPath);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const sql = connect(config.database.url, { max: 4 });
await migrate(sql);

// No build executors exist yet. A job that reaches this worker fails loudly
// instead of hanging, so a run never waits forever on a missing executor.
const handler: JobHandler = async (job) => {
  log.error("no executor for this build kind yet", { job: job.id, name: job.name, pipeline: job.def.pipeline });
  return "failed";
};

const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`stardust worker stopping (${signal})`);
    stop.abort();
  });
}

const workerId = `${hostname()}:${process.pid}`;
console.log(`stardust worker started (${workerId})`);
await runWorker({ sql, workerId, handler, log, signal: stop.signal });
await sql.end({ timeout: 5 });
