// The dashboard's entry point in the image, in place of the adapter's own (Node runs it as TypeScript).
//
// SvelteKit 3 takes the app's origin from build-time configuration only
// (paths.origin), and otherwise derives it from each request, assuming https.
// One image serves every installation, so the origin is configuration: ORIGIN
// (the chart sets it from config.server.publicUrl). It reaches the adapter
// through the headers PROTOCOL_HEADER and HOST_HEADER name, which this server
// sets on every request, overwriting whatever the client sent.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

const PROTO_HEADER = "x-stardust-origin-proto";
const HOST_HEADER = "x-stardust-origin-host";

/** The scheme and host of an origin like http://host:port, or null when unset. */
export function parseOrigin(value: string | undefined): { proto: string; host: string } | null {
  if (!value) return null;
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`ORIGIN must be an http(s) origin without a path, not ${value}`);
  }
  return { proto: url.protocol.slice(0, -1), host: url.host };
}

const origin = parseOrigin(process.env.ORIGIN);
if (origin) {
  process.env.PROTOCOL_HEADER = PROTO_HEADER;
  process.env.HOST_HEADER = HOST_HEADER;
}
// Imported after the environment is set: the handler reads it when it loads.
// The path is a variable so the type checker does not walk into the build output.
type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
const entry = "./build/handler.js";
const { handler } = (await import(entry)) as { handler: Handler };

const server = http.createServer((req, res) => {
  if (origin) {
    req.headers[PROTO_HEADER] = origin.proto;
    req.headers[HOST_HEADER] = origin.host;
  }
  handler(req, res, () => {
    res.statusCode = 404;
    res.end("Not found");
  });
});
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "0.0.0.0", () => {
  console.log(`stardust web listening on ${process.env.HOST ?? "0.0.0.0"}:${process.env.PORT ?? 3000}`);
});

const stop = () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
