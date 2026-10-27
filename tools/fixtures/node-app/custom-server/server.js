import { createServer } from "node:http";
import { note } from "./shutdown.js";

createServer((_, res) => res.end(JSON.stringify({ entry: "server.js", note }))).listen(process.env.PORT);
