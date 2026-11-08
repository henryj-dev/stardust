import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envFormChange } from "./env-form.ts";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("env form", () => {
  it("sets a plain value or a secret in the layer it came from, against the revision read", () => {
    assert.deepEqual(envFormChange(form({ layer: "api", revision: "r", name: " PORT ", value: "80" }), "set"), {
      layer: "api",
      name: "PORT",
      change: { expectedRevision: "r", set: { PORT: "80" } },
    });
    assert.deepEqual(
      envFormChange(form({ layer: "_shared", revision: "r", name: "KEY", value: "s3cret", kind: "secret" }), "set"),
      { layer: "_shared", name: "KEY", change: { expectedRevision: "r", setSecrets: { KEY: "s3cret" } } },
    );
  });

  it("removes a plain value or a secret", () => {
    assert.deepEqual(envFormChange(form({ layer: "api", revision: "r", name: "A", kind: "secret" }), "unset"), {
      layer: "api",
      name: "A",
      change: { expectedRevision: "r", unsetSecrets: ["A"] },
    });
  });

  it("refuses an empty name or secret, and a form without its layer; the error never holds the value", () => {
    for (const [fields, op] of [
      [{ layer: "api", revision: "r", name: "", value: "x" }, "set"],
      [{ layer: "api", revision: "r", name: "A", value: "", kind: "secret" }, "set"],
      [{ revision: "r", name: "A", value: "x" }, "set"],
    ] as const) {
      const result = envFormChange(form(fields), op);
      assert.ok("error" in result);
      assert.ok(!JSON.stringify(result).includes('x"'));
    }
  });
});
