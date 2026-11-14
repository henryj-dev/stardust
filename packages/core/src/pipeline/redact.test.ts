import assert from "node:assert/strict";
import { it } from "node:test";
import { buildLogKey, redactLog } from "./redact.ts";

// Made up at run time, so no credential-shaped literal sits in the repository.
const bearer = ["eyJhbGciOi", "payload", "sig"].join(".");
const awsKeyId = `AKIA${"ABCDEFGHIJ"}${"KLMNOP"}`;

it("masks token shapes and URL credentials, and leaves the rest of the log", () => {
  const log = [
    `cloning https://x-access-token:ghs_${"a".repeat(36)}@github.com/acme/app`,
    `export TOKEN=ghp_${"B".repeat(36)}`,
    `curl -H 'Authorization: Bearer ${bearer}' https://api.example.com`,
    `aws key ${awsKeyId} used`,
    "step 3/7: RUN pnpm install --frozen-lockfile",
  ].join("\n");
  const out = redactLog(log);
  assert.ok(!out.includes("ghs_") && !out.includes("ghp_") && !out.includes("eyJ") && !out.includes("AKIA"), out);
  assert.ok(out.includes("https://x-access-token:[redacted]@github.com/acme/app"));
  assert.ok(out.includes("step 3/7: RUN pnpm install --frozen-lockfile"));
  assert.equal(redactLog("nothing secret here\n"), "nothing secret here\n");
});

it("keeps logs under build-logs/<project>/<run>/<job>.log", () => {
  assert.equal(buildLogKey("demo", "r1", "api"), "build-logs/demo/r1/api.log");
});
