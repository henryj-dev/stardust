import assert from "node:assert/strict";
import { it } from "node:test";
import { readMounts } from "./files-form.ts";

it("reads the rows in order, trimmed, and leaves out a row whose path was cleared", () => {
  const f = new FormData();
  f.set("mounts.2.key", "FCM_JSON");
  f.set("mounts.2.path", " /etc/pico/fcm.json ");
  f.set("mounts.0.key", "PUSH_TOML");
  f.set("mounts.0.path", "/etc/pico/push.toml");
  f.set("mounts.1.key", "APNS_KEY");
  f.set("mounts.1.path", "");
  f.set("other", "x");
  assert.deepEqual(readMounts(f), [
    { key: "PUSH_TOML", path: "/etc/pico/push.toml" },
    { key: "FCM_JSON", path: "/etc/pico/fcm.json" },
  ]);
  assert.deepEqual(readMounts(new FormData()), []);
});
