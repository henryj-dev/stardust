import assert from "node:assert/strict";
import { it } from "node:test";
import { readStorageForm } from "./storage-form.ts";

it("reads the rows in order, trimmed, leaves out a row whose mount path was cleared, and the checked boxes", () => {
  const f = new FormData();
  f.set("volumes.1.name", "cache");
  f.set("volumes.1.mountPath", "");
  f.set("volumes.1.size", "1Gi");
  f.set("volumes.0.name", " data ");
  f.set("volumes.0.mountPath", "/var/lib/push");
  f.set("volumes.0.size", "2Gi");
  f.set("volumes.0.storageClass", "");
  f.set("fsGroup", "10001");
  f.append("adopt", "db");
  f.append("deleteData", "old");
  assert.deepEqual(readStorageForm(f), {
    volumes: [{ name: "data", mountPath: "/var/lib/push", size: "2Gi" }],
    adopt: ["db"],
    deleteData: ["old"],
    fsGroup: 10001,
  });
});

it("a blank fsGroup removes it, and an absent one leaves it", () => {
  const blank = new FormData();
  blank.set("fsGroup", "");
  assert.deepEqual(readStorageForm(blank), { volumes: [], fsGroup: null });
  assert.deepEqual(readStorageForm(new FormData()), { volumes: [] });
});
