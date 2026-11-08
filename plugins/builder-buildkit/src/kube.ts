/**
 * The few Kubernetes API calls the builder needs, over node:https with the
 * in-cluster service account. The token is re-read for every request because
 * projected tokens rotate.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";

export interface KubeResponse {
  status: number;
  body: string;
}

export interface KubeClient {
  request(method: string, path: string, body?: unknown): Promise<KubeResponse>;
}

/** A GET whose body is read as it arrives, such as a followed pod log. */
export interface KubeStreamResponse {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

export interface KubeStreamClient extends KubeClient {
  /** Aborting the signal ends the request and the body. */
  stream(path: string, signal: AbortSignal): Promise<KubeStreamResponse>;
}

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

export function inClusterClient(): KubeStreamClient {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("not running in a cluster: KUBERNETES_SERVICE_HOST is not set");
  let ca: Promise<Buffer> | null = null;
  const credentials = () => {
    ca ??= readFile(`${SA}/ca.crt`);
    return Promise.all([ca, readFile(`${SA}/token`, "utf8")]);
  };
  return {
    async stream(path, signal) {
      const [caCert, token] = await credentials();
      return new Promise((resolve, reject) => {
        const req = request(
          {
            host,
            port,
            path,
            method: "GET",
            ca: caCert,
            signal,
            headers: { authorization: `Bearer ${token.trim()}` },
            // A quiet build prints nothing for minutes; only a dead connection should end it.
            timeout: 15 * 60_000,
          },
          (res: IncomingMessage) => resolve({ status: res.statusCode ?? 0, body: res }),
        );
        req.on("timeout", () => req.destroy(new Error(`kubernetes API GET ${path} timed out`)));
        req.on("error", reject);
        req.end();
      });
    },
    async request(method, path, body) {
      const [caCert, token] = await credentials();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = request(
          {
            host,
            port,
            path,
            method,
            ca: caCert,
            headers: {
              authorization: `Bearer ${token.trim()}`,
              accept: "application/json",
              ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
            },
            timeout: 30_000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("timeout", () => req.destroy(new Error(`kubernetes API ${method} ${path} timed out`)));
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
