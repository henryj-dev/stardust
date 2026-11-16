/** Plugin sockets opened at the dashboard reach the API unchanged; other upgrades stop at the dashboard. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { after, it } from "node:test";
import { relayUpgrade } from "../../../socket-relay.ts";

const seen: Array<{ url: string; authorization?: string }> = [];
const apiSockets = new Set<import("node:stream").Duplex>();
// A stand-in API: upgrades a token it knows, refuses others with 401, and echoes after the upgrade.
const api = http.createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
api.on("upgrade", (req, socket, head) => {
  seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
  apiSockets.add(socket);
  socket.on("close", () => apiSockets.delete(socket));
  socket.on("end", () => socket.end()); // as a WebSocket server does when its peer goes
  if (req.headers.authorization !== "Bearer good") {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  if (head.length) socket.write(Buffer.concat([Buffer.from("echo:"), head]));
  socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
const apiPort = (api.address() as net.AddressInfo).port;

const web = http.createServer((_req, res) => res.end());
web.on("upgrade", relayUpgrade(`http://127.0.0.1:${apiPort}`));
web.listen(0, "127.0.0.1");
await once(web, "listening");
const webPort = (web.address() as net.AddressInfo).port;
after(() => {
  for (const s of apiSockets) s.destroy();
  web.close();
  api.close();
  web.closeAllConnections();
  api.closeAllConnections();
});

/** Opens a raw upgrade at the dashboard and returns everything read until `until` matches or the socket ends. */
async function open(path: string, token: string, send?: string, until?: RegExp) {
  const s = net.connect(webPort, "127.0.0.1");
  await once(s, "connect");
  s.write(
    `GET ${path} HTTP/1.1\r\nHost: dash\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${token}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
  );
  let got = "";
  return await new Promise<string>((resolve) => {
    s.on("data", (d) => {
      got += d.toString();
      if (send && got.includes("\r\n\r\n") && got.startsWith("HTTP/1.1 101") && !got.includes("echo:")) s.write(send);
      if (until?.test(got)) {
        s.destroy();
        resolve(got);
      }
    });
    s.on("close", () => resolve(got));
  });
}

it("hands a plugin socket to the API with its credential, and carries bytes both ways", async () => {
  const got = await open("/api/v1/plugins/nodes/infra/node-socket", "good", "hello", /echo:hello/);
  assert.match(got, /^HTTP\/1\.1 101/);
  assert.match(got, /echo:hello/);
  const last = seen.at(-1);
  assert.equal(last?.url, "/api/v1/plugins/nodes/infra/node-socket");
  assert.equal(last?.authorization, "Bearer good");
  // The client went away: the API's side is closed too.
  for (let i = 0; i < 50 && apiSockets.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(apiSockets.size, 0);
});

it("passes the API's refusal back as it is", async () => {
  const got = await open("/api/v1/plugins/nodes/infra/node-socket", "wrong");
  assert.match(got, /^HTTP\/1\.1 401/);
});

it("refuses an upgrade that is not a plugin socket without asking the API", async () => {
  const before = seen.length;
  for (const path of ["/", "/api/v1/projects", "/api/v1/plugins/", "/projects/x"]) {
    assert.match(await open(path, "good"), /^HTTP\/1\.1 404/, path);
  }
  assert.equal(seen.length, before);
});
