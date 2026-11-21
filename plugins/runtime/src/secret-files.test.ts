import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFeatures, type Logger, type Route } from "@stardust/core";
import { MemoryRepo } from "@stardust/core/testing";
import { parse, stringify } from "yaml";
import { plugin } from "./index.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DIR = "deploy/demo/server";
const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata: { name: server, namespace: demo }
spec:
  selector: { matchLabels: { app: server } }
  template:
    metadata: { labels: { app: server } }
    spec:
      securityContext: { fsGroup: 1000 }
      containers: [{ name: server, image: registry.example.com/demo/server:1 }]
`;

/** Like SOPS: values under data are sealed, keys stay in clear. */
const sealing = () => {
  const seal = (v: string) => `ENC[${Buffer.from(v).toString("hex")}]`;
  const open = (v: string) => Buffer.from(v.replace(/^ENC\[|\]$/g, ""), "hex").toString();
  const map = (doc: Record<string, unknown>, f: (v: string) => string) => ({
    ...doc,
    data: Object.fromEntries(Object.entries((doc.data ?? {}) as Record<string, string>).map(([k, v]) => [k, f(v)])),
  });
  const cipher = {
    encryptions: 0,
    async decrypt(document: string) {
      const { sops: _s, ...doc } = parse(document) as Record<string, unknown>;
      return stringify(map(doc, open));
    },
    async encryptIfChanged(current: string | null, plain: string) {
      if (current !== null && (await cipher.decrypt(current)) === stringify(parse(plain)))
        return { changed: false, document: current };
      cipher.encryptions++;
      return { changed: true, document: stringify({ ...map(parse(plain), seal), sops: { version: "fake" } }) };
    },
    revisionKey: "k",
  };
  return cipher;
};

function setup(withCipher = true) {
  const repo = new MemoryRepo({
    [`${DIR}/deployment.yaml`]: DEPLOYMENT,
    [`${DIR}/kustomization.yaml`]: "resources:\n  - deployment.yaml\n",
  });
  const cipher = sealing();
  const projects = {
    get: async (id: string) =>
      id === "demo" ? { id, name: "Demo", githubRepo: null, components: [{ name: "server", deployDir: DIR }] } : null,
  };
  const kube = { request: async () => ({ status: 404, body: "" }), stream: () => Promise.reject(new Error("x")) };
  const [feature] = buildFeatures(
    [plugin],
    { runtime: {} },
    { kube, deployRepo: { repo }, projects, ...(withCipher ? { cipher } : {}) },
    quiet,
    "test",
  );
  const route = (method: string, path: string) => {
    const r = feature?.routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r as Route;
  };
  const call = (method: string, path: string, params: Record<string, string>, body: unknown = null) =>
    route(method, path).handle({
      params: { project: "demo", component: "server", ...params },
      query: new URLSearchParams(),
      body,
      user: { id: "u", username: "admin", isAdmin: true },
      signal: new AbortController().signal,
    });
  return { repo, cipher, route, call };
}

const KEY = "/projects/:project/components/:component/secret-files/:set/keys/:key";
const LIST = "/projects/:project/components/:component/secret-files";
const at = { set: "kek", key: "key" };

describe("secret files", () => {
  it("generates a sealed value in one commit with its mount and list entry, and never shows it", async () => {
    const { repo, call, route } = setup();
    assert.equal(route("POST", KEY).permission, "runtime:secrets");
    assert.equal(plugin.permissions?.find((p) => p.id === "runtime:secrets")?.grantedTo, "admins");
    assert.equal(route("PUT", KEY).fresh, true, "replacing loses the old value: a recent sign-in");
    const res = await call("POST", KEY, at, { generate: { bytes: 32 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(repo.commitCount(), 1);
    assert.deepEqual(res.audit?.detail, { set: "kek", key: "key", generated: { bytes: 32, encoding: "raw" } });
    const sealed = repo.files()[`${DIR}/secret-files-kek.secret.enc.yaml`] ?? "";
    const value = (parse(sealed) as { data: { key: string } }).data.key;
    assert.match(value, /^ENC\[/, "sealed in the repository");
    const plain = Buffer.from(Buffer.from(value.slice(4, -1), "hex").toString(), "base64");
    assert.equal(plain.length, 32, "32 raw bytes");
    assert.ok(!JSON.stringify(res).includes(value.slice(4, 20)), "the answer holds no value");
    assert.match(repo.files()[`${DIR}/deployment.yaml`] ?? "", /mountPath: \/run\/secrets\/kek/);
    assert.match(repo.files()[`${DIR}/kustomization.yaml`] ?? "", /- secret-files-kek.secret.enc.yaml/);
    const list = await call("GET", LIST, {});
    assert.deepEqual(list.body, {
      available: true,
      fsGroup: 1000,
      sets: [{ name: "kek", secret: "server-files-kek", path: "/run/secrets/kek", keys: ["key"], mounted: true }],
    });
    assert.ok(!JSON.stringify(list.body).includes("ENC["));
  });

  it("does not overwrite a key by adding it again; replacing and deleting are on purpose", async () => {
    const { repo, call } = setup();
    await call("POST", KEY, at, { generate: { bytes: 32 } });
    const before = repo.files()[`${DIR}/secret-files-kek.secret.enc.yaml`];
    const again = await call("POST", KEY, at, { generate: { bytes: 32 } });
    assert.equal(again.status, 409);
    assert.equal(repo.files()[`${DIR}/secret-files-kek.secret.enc.yaml`], before, "the key is kept");
    const upload = Buffer.from([0, 1, 2, 3, 250, 251]).toString("base64");
    assert.equal((await call("POST", KEY, { set: "kek", key: "old.bin" }, { value: upload })).status, 200);
    assert.equal((await call("PUT", KEY, at, { generate: { bytes: 64, encoding: "hex" } })).status, 200);
    assert.equal((await call("PUT", KEY, { set: "kek", key: "nope" }, { value: upload })).status, 409);
    assert.equal((await call("DELETE", KEY, at)).status, 200);
    assert.equal((await call("DELETE", KEY, { set: "kek", key: "old.bin" })).status, 200);
    const files = repo.files();
    assert.equal(files[`${DIR}/secret-files-kek.secret.enc.yaml`], undefined, "the last key takes the set with it");
    assert.doesNotMatch(files[`${DIR}/deployment.yaml`] ?? "", /run\/secrets/);
    assert.doesNotMatch(files[`${DIR}/kustomization.yaml`] ?? "", /secret-files/);
  });

  it("refuses what it cannot do, naming no value", async () => {
    const { repo, call } = setup();
    assert.equal((await call("POST", KEY, at, {})).status, 400);
    assert.equal((await call("POST", KEY, at, { generate: { bytes: 8 } })).status, 400);
    assert.equal((await call("POST", KEY, at, { value: "not base64!" })).status, 400);
    assert.equal((await call("POST", KEY, { set: "Bad", key: "k" }, { generate: { bytes: 32 } })).status, 400);
    assert.equal((await call("POST", KEY, { set: "kek", key: "../x" }, { generate: { bytes: 32 } })).status, 400);
    assert.equal(repo.commitCount(), 0);
    const off = setup(false);
    assert.equal((await off.call("POST", KEY, at, { generate: { bytes: 32 } })).status, 404);
  });

  it("refuses a pod without an fsGroup: the files are readable by their group only", async () => {
    const { repo, call } = setup();
    repo.push({
      [`${DIR}/deployment.yaml`]: DEPLOYMENT.replace("securityContext: { fsGroup: 1000 }", "securityContext: {}"),
    });
    const res = await call("POST", KEY, at, { generate: { bytes: 32 } });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /fsGroup/);
    assert.equal(repo.files()[`${DIR}/secret-files-kek.secret.enc.yaml`], undefined);
  });
});
