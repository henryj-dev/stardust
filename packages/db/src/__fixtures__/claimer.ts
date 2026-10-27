/**
 * A minimal worker for concurrency.dbtest.ts: claims jobs until none are left,
 * holds each briefly so the two processes overlap, and prints the name of
 * every job it finished.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { claimJob, finishJob } from "../queue.ts";
import { connectToSchema } from "../testing.ts";

const id = process.argv[2] ?? "worker";
const schema = process.env.TEST_SCHEMA;
if (!schema) throw new Error("TEST_SCHEMA is not set");
const sql = connectToSchema(schema, 2);

let idle = 0;
while (idle < 3) {
  const job = await claimJob(sql, id, 30_000);
  if (!job) {
    idle++;
    await sleep(20);
    continue;
  }
  idle = 0;
  await sleep(Math.random() * 3);
  if (!(await finishJob(sql, job.id, id, "success"))) throw new Error(`lost ${job.name}`);
  process.stdout.write(`${job.name}\n`);
}
await sql.end();
