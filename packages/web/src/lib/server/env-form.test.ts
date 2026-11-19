// biome-ignore-all lint/suspicious/noTemplateCurlyInString: env values are written with ${NAME} references on purpose
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envFormChange, literalFormChange, valueFromFile } from "./env-form.ts";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** The change of a parsed form, failing the test when the form was refused. */
const changeOf = (r: ReturnType<typeof envFormChange>) => {
  assert.ok("change" in r, "error" in r ? r.error : "");
  return r.change;
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

  it("keeps a multi-line value exactly, and sends Literal only when it changes", () => {
    const toml = '[auth]\n  audience = "${AUDIENCE}"\n';
    assert.deepEqual(
      envFormChange(form({ layer: "api", revision: "r", name: "PUSH_TOML", value: toml, kind: "secret" }), "set"),
      { layer: "api", name: "PUSH_TOML", change: { expectedRevision: "r", setSecrets: { PUSH_TOML: toml } } },
    );
    assert.deepEqual(
      changeOf(envFormChange(form({ layer: "api", revision: "r", name: "S", value: "${X}", literal: "on" }), "set")),
      { expectedRevision: "r", set: { S: "${X}" }, literal: { S: true } },
    );
    assert.deepEqual(
      changeOf(envFormChange(form({ layer: "api", revision: "r", name: "S", value: "${X}", wasLiteral: "on" }), "set")),
      { expectedRevision: "r", set: { S: "${X}" }, literal: { S: false } },
    );
    assert.deepEqual(
      changeOf(
        envFormChange(
          form({ layer: "api", revision: "r", name: "S", value: "x", literal: "on", wasLiteral: "on" }),
          "set",
        ),
      ),
      { expectedRevision: "r", set: { S: "x" } },
      "unchanged, so not sent",
    );
  });

  it("toggles Literal alone", () => {
    assert.deepEqual(literalFormChange(form({ layer: "api", revision: "r", name: "S", literal: "on" })), {
      layer: "api",
      name: "S",
      change: { expectedRevision: "r", literal: { S: true } },
    });
    assert.deepEqual(changeOf(literalFormChange(form({ layer: "api", revision: "r", name: "S" }))), {
      expectedRevision: "r",
      literal: { S: false },
    });
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

it("passes on that a plain value is public on purpose, only for plain values", () => {
  const form = (kind: string, pub: boolean) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({
      layer: "_shared",
      revision: "a".repeat(20),
      name: "PUBLIC_TOKEN_URL",
      value: "x",
      kind,
    }))
      f.set(k, v);
    if (pub) f.set("public", "on");
    return f;
  };
  const plain = envFormChange(form("plain", true), "set");
  assert.ok("change" in plain && plain.change.plainOnPurpose?.[0] === "PUBLIC_TOKEN_URL");
  const unticked = envFormChange(form("plain", false), "set");
  assert.ok("change" in unticked && unticked.change.plainOnPurpose === undefined);
  const secret = envFormChange(form("secret", true), "set");
  assert.ok("change" in secret && secret.change.plainOnPurpose === undefined);
});

describe("a value from a file", () => {
  const withFile = (fields: Record<string, string>, file: File) => {
    const f = form(fields);
    f.set("file", file);
    return f;
  };
  const KEY = "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n";

  it("takes the file's text as the value, newlines and all, and a secret is set with it", async () => {
    const f = withFile(
      { layer: "_shared", revision: "r1", name: "APNS_KEY", kind: "secret" },
      new File([KEY], "AuthKey.p8"),
    );
    assert.equal(await valueFromFile(f), null);
    assert.equal(f.get("file"), null, "the file is not passed on");
    assert.deepEqual(envFormChange(f, "set"), {
      layer: "_shared",
      name: "APNS_KEY",
      change: { expectedRevision: "r1", setSecrets: { APNS_KEY: KEY } },
    });
  });

  it("leaves a form without a file, or with an empty one, as it is", async () => {
    const typed = form({ layer: "_shared", revision: "r1", name: "A", value: "typed" });
    assert.equal(await valueFromFile(typed), null);
    assert.equal(typed.get("value"), "typed");
    const empty = withFile({ layer: "_shared", revision: "r1", name: "A", value: "typed" }, new File([], ""));
    assert.equal(await valueFromFile(empty), null);
    assert.equal(empty.get("value"), "typed");
  });

  it("refuses a typed value and a file together, a file over 32 KiB, and anything but UTF-8 text", async () => {
    const both = withFile({ name: "A", value: "typed" }, new File(["x"], "a.txt"));
    assert.match((await valueFromFile(both))?.error ?? "", /not both/);
    const big = withFile({ name: "A" }, new File(["x".repeat(32 * 1024 + 1)], "big.json"));
    assert.match((await valueFromFile(big))?.error ?? "", /big\.json is larger than 32 KiB/);
    const binary = withFile({ name: "A" }, new File([new Uint8Array([0xff, 0xfe, 0x00])], "blob.bin"));
    assert.match((await valueFromFile(binary))?.error ?? "", /blob\.bin is not UTF-8 text/);
    const nul = withFile({ name: "A" }, new File(["a\u0000b"], "nul.txt"));
    assert.match((await valueFromFile(nul))?.error ?? "", /not UTF-8 text/);
    assert.equal(nul.get("value"), null, "nothing is set from a refused file");
  });
});
