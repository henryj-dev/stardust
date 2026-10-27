import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./load.ts";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/stardust.yaml");

it("examples/stardust.yaml is a valid configuration", async () => {
  const config = await loadConfig(EXAMPLE, { env: { DATABASE_URL: "postgres://example" } });
  assert.equal(config.version, 1);
});
