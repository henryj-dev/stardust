/** The node agent's socket, over a real HTTP server: tokens, the frames, fencing, revocation, the API. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { buildFeatures, createPluginRegistry, type Logger } from "@stardust/core";
import { createUser, databasePort, ensureBootstrapAdmin, listAudit, migratePlugin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { plugin } from "@stardust/plugin-nodes";
import { WebSocket } from "ws";
import { createApp } from "./app.ts";
import { attachSockets } from "./sockets.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const golden = (name: string) =>
  readFileSync(new URL(`../../../agent/testdata/frames/${name}.json`, import.meta.url), "utf8");
let db: TestDb;
let server: Server;
let base = "";
let closeSockets = () => {};
const as: Record<string, Record<string, string>> = {};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "member", password: PASSWORD });
  for (const who of ["admin", "member"]) {
    const r = await signIn(db.sql, who, PASSWORD);
    if (!r.ok) throw new Error(who);
    as[who] = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  }
  const sections = { nodes: {} };
  const features = buildFeatures(
    createPluginRegistry([plugin]).resolve(sections),
    sections,
    { database: databasePort(db.sql) },
    quiet,
    "test",
  );
  await migratePlugin(
    { regional: db.sql, global: db.sql },
    "nodes",
    await (features[0] as (typeof features)[number]).migrations(),
  );
  const app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features, log: quiet },
  );
  server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s as unknown as Server));
  });
  closeSockets = attachSockets(server, features, quiet);
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  closeSockets();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await db.close();
});

const api = (method: string, path: string, who = "admin", body?: unknown) =>
  fetch(`http://${base}/api/v1/plugins/nodes${path}`, {
    method,
    headers: as[who] ?? {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Opens the agent socket; resolves with the server's hello, or rejects with the refused status. */
function connect(token: string) {
  const ws = new WebSocket(`ws://${base}/api/v1/plugins/nodes/infra/node-socket`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const closed = new Promise<{ code: number; reason: string }>((r) =>
    ws.on("close", (code, reason) => r({ code, reason: reason.toString() })),
  );
  const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.once("message", (d) => resolve(JSON.parse(d.toString())));
    ws.once("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once("error", reject);
  });
  return { ws, hello, closed };
}
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};
const nodes = async () =>
  ((await (await api("GET", "/nodes")).json()) as { nodes: Array<Record<string, unknown>> }).nodes;

describe("the node agent", () => {
  let token = "";
  let tokenId = "";

  it("gets a token from an administrator, shown once and audited", async () => {
    assert.equal((await api("POST", "/tokens", "member", { hostname: "web-1" })).status, 403);
    assert.equal((await api("POST", "/tokens", "admin", { hostname: "not a host" })).status, 400);
    const res = await api("POST", "/tokens", "admin", { hostname: "Web-1.", label: "first" });
    assert.equal(res.status, 201);
    ({ token, id: tokenId } = (await res.json()) as { token: string; id: string });
    assert.match(token, /^stnode_[0-9a-f]{64}$/);
    const listed = JSON.stringify(await (await api("GET", "/tokens")).json());
    assert.ok(listed.includes("web-1") && !listed.includes(token), "the list never shows the token");
    assert.equal((await listAudit(db.sql, { action: "nodes.token.issue" })).events[0]?.target, "web-1");
    assert.deepEqual(
      (await nodes()).map((n) => [n.hostname, n.state, n.hasToken]),
      [["web-1", "missing", true]],
    );
  });

  it("is refused without a valid token, before any upgrade", async () => {
    await assert.rejects(connect("stnode_nope").hello, /401/);
    await assert.rejects(connect("not-a-node-token").hello, /401/);
  });

  it("connects, says hello, beats and reports metrics; the host shows online", async () => {
    const agent = connect(token);
    const hello = await agent.hello;
    assert.equal(hello.type, "hello");
    assert.equal(hello.beat_interval_ms, 5000);
    agent.ws.send(golden("hello"));
    agent.ws.send(golden("beat"));
    agent.ws.send(golden("metrics"));
    await until(async () => (await nodes())[0]?.metrics != null);
    const [host] = await nodes();
    assert.equal(host?.state, "online");
    assert.equal(host?.uptimeS, 987654);
    assert.equal(host?.agentVersion, "1.4.2");
    assert.deepEqual((host?.metrics as { load?: number[] } | undefined)?.load, [0.42, 0.75, 1.03]);
    agent.ws.close();
    await agent.closed;
  });

  it("fences an older session out when the host reconnects, and closes on a bad frame", async () => {
    const first = connect(token);
    await first.hello;
    const second = connect(token);
    await second.hello;
    first.ws.send(JSON.stringify({ type: "beat", seq: 1 }));
    assert.equal((await first.closed).code, 4001);
    second.ws.send("{not json");
    assert.equal((await second.closed).code, 1008);
  });

  it("ends a revoked host's session and refuses its token afterwards", async () => {
    const agent = connect(token);
    await agent.hello;
    assert.equal((await api("DELETE", `/tokens/${tokenId}`)).status, 200);
    agent.ws.send(JSON.stringify({ type: "beat", seq: 1 }));
    assert.equal((await agent.closed).code, 4001);
    await assert.rejects(connect(token).hello, /401/);
    assert.equal((await api("DELETE", `/tokens/${tokenId}`)).status, 404);
  });
});
