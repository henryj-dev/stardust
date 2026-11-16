// Plugin WebSockets through the dashboard. Where the dashboard is the only
// way in (one name, one Service), a client such as the node agent opens its
// socket here; it is handed to the API server unchanged, which checks the
// credential and answers. Only plugin sockets pass: any other upgrade is
// refused here.
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

const PLUGIN_SOCKET = /^\/api\/v1\/plugins\/[a-z0-9-]+\//;

/** Headers that belong to one hop and are not passed on as they came. */
const HOP = new Set(["host", "connection", "upgrade", "keep-alive", "proxy-connection", "te", "trailer"]);

function refuse(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Hands a plugin socket's upgrade to the API at `apiUrl`, and its bytes both ways after. */
export function relayUpgrade(apiUrl: string) {
  const api = new URL(apiUrl);
  const client = api.protocol === "https:" ? https : http;
  const basePath = api.pathname.replace(/\/+$/, "");

  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = req.url ?? "/";
    if (!PLUGIN_SOCKET.test(new URL(path, "http://stardust").pathname)) return refuse(socket, 404, "Not Found");
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP.has(name)) headers[name] = value;
    }
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade ?? "websocket";

    const out = client.request({
      protocol: api.protocol,
      hostname: api.hostname,
      port: api.port || undefined,
      method: req.method,
      path: `${basePath}${path}`,
      headers,
    });
    socket.on("error", () => out.destroy());
    out.on("error", () => refuse(socket, 502, "Bad Gateway"));
    // The API refused (a wrong token, an unknown path): its answer goes back as it is.
    out.on("response", (res) => {
      let answer = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
      for (let i = 0; i < res.rawHeaders.length; i += 2) answer += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
      socket.write(`${answer}\r\n`);
      res.pipe(socket);
    });
    out.on("upgrade", (res, upstream, upstreamHead) => {
      let head101 = `HTTP/1.1 101 ${res.statusMessage}\r\n`;
      for (let i = 0; i < res.rawHeaders.length; i += 2)
        head101 += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
      socket.write(`${head101}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      // Either side going away ends the other: a dropped agent frees its API connection at once.
      for (const ev of ["end", "close"]) {
        upstream.on(ev, () => socket.destroy());
        socket.on(ev, () => upstream.destroy());
      }
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    out.end();
  };
}
