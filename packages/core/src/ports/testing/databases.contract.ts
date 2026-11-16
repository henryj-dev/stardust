/**
 * What every database engine must do, checked the same way for each: it
 * refuses bad input before rendering, its manifests parse and name secrets
 * only by reference, rendering is deterministic, and a backup covers every
 * target it is given.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAllDocuments } from "yaml";
import type { AppGrant, BackupPlan, DatabaseProvider, DatabaseSpec, DatabaseTarget } from "../databases.ts";

const PASSWORD_LIKE = "s3cr3t-value-that-must-not-appear";

const docs = (files: Record<string, string>) =>
  Object.values(files).flatMap((text) =>
    parseAllDocuments(text).map((d) => {
      assert.equal(d.errors.length, 0, String(d.errors[0]));
      return d.toJS() as { kind?: string; metadata?: { name?: string; namespace?: string } };
    }),
  );

export function databaseProviderContract(name: string, make: () => Promise<DatabaseProvider>) {
  describe(`databases contract: ${name}`, () => {
    const spec = (p: DatabaseProvider, over: Partial<DatabaseSpec> = {}): DatabaseSpec => ({
      name: "orders",
      version: p.capabilities.versions[p.capabilities.versions.length - 1] ?? "",
      storage: "10Gi",
      cpu: "250m",
      memory: "512Mi",
      ...over,
    });
    const target = (p: DatabaseProvider): DatabaseTarget => ({
      ref: { namespace: p.capabilities.namespace, name: "orders" },
      host: `orders.${p.capabilities.namespace}.svc`,
      superuser: p.superuserSecret("orders"),
    });
    const grant: AppGrant = {
      database: "orders",
      role: "orders_app",
      password: { name: "orders-app-db", key: "password" },
    };
    const plan = (p: DatabaseProvider, over: Partial<BackupPlan> = {}): BackupPlan => ({
      name: "db-backup",
      namespace: p.capabilities.namespace,
      schedule: "15 3 * * *",
      storage: { endpoint: "https://s3.example.com", bucket: "backups", credentials: "backup-s3", prefix: "pg" },
      recipient: `age1${"q".repeat(58)}`,
      retentionHours: 168,
      targets: [
        target(p),
        { ...target(p), ref: { namespace: p.capabilities.namespace, name: "billing" }, host: "billing.svc" },
      ],
      ...over,
    });

    it("refuses specs out of bounds and accepts a sane one", async () => {
      const p = await make();
      assert.deepEqual(p.specProblems(spec(p)), []);
      for (const bad of [
        { name: "Orders" },
        { name: "x".repeat(51) },
        { version: "9" },
        { storage: "10TB" },
        { storage: "2000Gi" },
        { cpu: "10m" },
        { memory: "64Mi" },
        { storageClass: "Fast SSD" },
      ]) {
        assert.ok(p.specProblems(spec(p, bad)).length > 0, JSON.stringify(bad));
        assert.throws(() => p.renderInstance(spec(p, bad)));
      }
    });

    it("renders an instance that parses, sits in its namespace, and reads the superuser Secret by reference", async () => {
      const p = await make();
      const files = p.renderInstance(spec(p));
      assert.deepEqual(files, p.renderInstance(spec(p)), "deterministic");
      const all = docs(files);
      assert.ok(all.length > 0);
      for (const d of all) assert.equal(d.metadata?.namespace, p.capabilities.namespace);
      const text = Object.values(files).join("\n");
      assert.ok(text.includes(p.superuserSecret("orders").name), "names the superuser Secret");
      assert.ok(!all.some((d) => d.kind === "Secret"), "the password Secret is the feature's to write, sealed");
    });

    it("renders an application's grant as one Job, refusing names that would need quoting", async () => {
      const p = await make();
      const files = p.renderAppGrant(target(p), grant);
      const all = docs(files);
      assert.deepEqual(
        all.map((d) => d.kind),
        ["Job"],
      );
      const text = Object.values(files).join("\n");
      assert.ok(text.includes("orders-app-db") && !text.includes(PASSWORD_LIKE));
      for (const bad of [
        { role: "orders; DROP ROLE x" },
        { role: "Orders" },
        { database: 'a"b' },
        { role: "postgres" },
        { password: { name: "Bad Name", key: "password" } },
      ]) {
        assert.throws(() => p.renderAppGrant(target(p), { ...grant, ...bad }), JSON.stringify(bad));
      }
    });

    it("renders a backup covering every target once, and refuses plans that would not run safely", async () => {
      const p = await make();
      const files = p.renderBackup(plan(p));
      const all = docs(files);
      assert.deepEqual(
        all.map((d) => d.kind),
        ["CronJob"],
      );
      const text = Object.values(files).join("\n");
      for (const t of plan(p).targets) assert.ok(text.includes(t.superuser.name) && text.includes(t.host), t.ref.name);
      for (const bad of [
        { targets: [] },
        { targets: [target(p), target(p)] },
        { storage: { endpoint: "http://s3.example.com", bucket: "b1", credentials: "c", prefix: "p" } },
        { storage: { endpoint: "https://x.com/$(id)", bucket: "b1", credentials: "c", prefix: "p" } },
        { recipient: "not-a-key" },
        { schedule: "daily" },
        { retentionHours: 1 },
      ]) {
        assert.throws(() => p.renderBackup(plan(p, bad as Partial<BackupPlan>)), JSON.stringify(bad));
      }
    });
  });
}
