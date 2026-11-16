/**
 * Plugin schedules against a real database: at most one run per interval
 * across workers, errors recorded, and nothing at all when the plugin is
 * not enabled.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFeatures, createPluginRegistry, definePlugin, type Logger } from "@stardust/core";
import { claimScheduleRun, databasePort, finishScheduleRun } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { runDueSchedules } from "./schedules.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => db.close());

let runs = 0;
let fail = false;
const ticker = definePlugin({
  manifest: { name: "ticker", description: "Test only: counts its runs." },
  validateConfig: () => [],
  schedules: [
    {
      id: "count",
      everyMs: 60_000,
      run: async ({ ports }) => {
        assert.ok(ports.database, "a schedule gets the ports");
        runs++;
        if (fail) throw new Error("tick failed");
      },
    },
  ],
});

const featuresWith = (sections: Record<string, unknown>) =>
  buildFeatures(createPluginRegistry([ticker]).resolve(sections), sections, { database: databasePort(db.sql) }, quiet);
const signal = new AbortController().signal;

describe("schedules", () => {
  it("not enabled: nothing runs and nothing is recorded", async () => {
    assert.deepEqual(
      await runDueSchedules({ sql: db.sql, features: featuresWith({}), holder: "w1", log: quiet, signal }),
      [],
    );
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM schedule_runs`)[0]?.n, 0);
  });

  it("runs once per interval, however many workers try", async () => {
    const features = featuresWith({ ticker: {} });
    const tries = await Promise.all(
      ["w1", "w2", "w3", "w1"].map((holder) => runDueSchedules({ sql: db.sql, features, holder, log: quiet, signal })),
    );
    assert.equal(runs, 1);
    assert.equal(tries.flat().length, 1);
    assert.deepEqual(tries.flat(), ["ticker.count"]);
    await runDueSchedules({ sql: db.sql, features, holder: "w2", log: quiet, signal });
    assert.equal(runs, 1, "not again within the interval");
  });

  it("records a failed run's error, and runs again once the interval has passed", async () => {
    const features = featuresWith({ ticker: {} });
    await db.sql`UPDATE schedule_runs SET last_started_at = now() - interval '2 minutes' WHERE name = 'ticker.count'`;
    fail = true;
    await runDueSchedules({ sql: db.sql, features, holder: "w2", log: quiet, signal });
    assert.equal(runs, 2);
    const [row] = await db.sql`SELECT holder, lease_until, last_error FROM schedule_runs WHERE name = 'ticker.count'`;
    assert.deepEqual(row, { holder: null, lease_until: null, last_error: "tick failed" });
  });

  it("a held lease blocks others until it expires, even when the run is due", async () => {
    await db.sql`INSERT INTO schedule_runs (name) VALUES ('ticker.held')`;
    assert.equal(await claimScheduleRun(db.sql, "ticker.held", "w1", 10_000, 60_000), true);
    await db.sql`UPDATE schedule_runs SET last_started_at = now() - interval '1 hour' WHERE name = 'ticker.held'`;
    assert.equal(await claimScheduleRun(db.sql, "ticker.held", "w2", 10_000, 60_000), false, "w1 still holds it");
    await db.sql`UPDATE schedule_runs SET lease_until = now() - interval '1 second' WHERE name = 'ticker.held'`;
    assert.equal(await claimScheduleRun(db.sql, "ticker.held", "w2", 10_000, 60_000), true, "an expired lease is free");
    await finishScheduleRun(db.sql, "ticker.held", "w1", "late");
    const [row] = await db.sql`SELECT holder, last_error FROM schedule_runs WHERE name = 'ticker.held'`;
    assert.deepEqual(row, { holder: "w2", last_error: null }, "a holder that lost the lease cannot finish the run");
  });
});
