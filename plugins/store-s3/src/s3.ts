/**
 * The few S3 calls an ObjectStore needs, signed with AWS Signature V4,
 * path-style (`<endpoint>/<bucket>/<key>`), which S3, R2 and MinIO all
 * accept. No SDK: the signing is small and this keeps the image lean.
 */
import { createHash, createHmac } from "node:crypto";
import { OBJECT_KEY, type ObjectStore } from "@stardust/core";

export interface S3Options {
  endpoint: string;
  bucket: string;
  /** R2 uses `auto`. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Every key is stored under it, e.g. `stardust/`. */
  prefix?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding, as SigV4 wants it; "/" is kept in the path.
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (s: string) => s.split("/").map(encode).join("/");

export interface SignInput {
  method: string;
  /** URI-encoded path. */
  path: string;
  /** Canonical (sorted, encoded) query string, without "?". */
  query: string;
  /** Lower-case names; every one is signed. */
  headers: Record<string, string>;
  payloadHash: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
  region: string;
  service: string;
  secretAccessKey: string;
}

/** The Signature V4 signature of one request (hex). */
export function signV4(input: SignInput): string {
  const signed = Object.keys(input.headers).sort();
  // Method, path, query, one "name:value\n" per header, the signed names, the payload hash.
  const canonicalHeaders = signed.map((h) => `${h}:${String(input.headers[h]).trim()}\n`).join("");
  const canonical = [input.method, input.path, input.query, canonicalHeaders, signed.join(";"), input.payloadHash].join(
    "\n",
  );
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service),
    "aws4_request",
  );
  return createHmac("sha256", signingKey).update(toSign).digest("hex");
}

export function s3Store(options: S3Options): ObjectStore {
  const endpoint = new URL(options.endpoint);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const prefix = options.prefix ?? "";
  if (prefix && !OBJECT_KEY.test(prefix.replace(/\/$/, ""))) throw new Error("prefix must be a plain key path");

  const keyOf = (key: string) => {
    if (!OBJECT_KEY.test(key)) throw new Error(`not an object key: ${JSON.stringify(key)}`);
    return `${prefix}${key}`;
  };

  async function request(
    method: string,
    key: string | null,
    query: Record<string, string>,
    body?: Uint8Array,
    contentType?: string,
  ) {
    const path = `${endpoint.pathname.replace(/\/+$/, "")}/${encode(options.bucket)}${key === null ? "/" : `/${encodePath(key)}`}`;
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(query[k] ?? "")}`)
      .join("&");
    const at = now();
    const amzDate = at
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? "");
    const headers: Record<string, string> = {
      host: endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(contentType ? { "content-type": contentType } : {}),
    };
    const signature = signV4({
      method,
      path,
      query: canonicalQuery,
      headers,
      payloadHash,
      amzDate,
      region: options.region,
      service: "s3",
      secretAccessKey: options.secretAccessKey,
    });
    const signed = Object.keys(headers).sort();
    const scope = `${day}/${options.region}/s3/aws4_request`;
    const { host: _host, ...sent } = headers;
    return doFetch(`${endpoint.protocol}//${endpoint.host}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`, {
      method,
      headers: {
        ...sent,
        authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`,
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(60_000),
    });
  }

  const fail = async (what: string, res: Response): Promise<never> => {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`object store: ${what} answered ${res.status}${code ? ` (${code})` : ""}`);
  };

  return {
    async put(key, body, contentType) {
      const res = await request("PUT", keyOf(key), {}, body, contentType);
      if (!res.ok) await fail("PUT", res);
    },
    async get(key) {
      const res = await request("GET", keyOf(key), {});
      if (res.status === 404) return null;
      if (!res.ok) await fail("GET", res);
      return new Uint8Array(await res.arrayBuffer());
    },
    async list(listPrefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await request("GET", null, {
          "list-type": "2",
          prefix: `${prefix}${listPrefix}`,
          ...(token ? { "continuation-token": token } : {}),
        });
        if (!res.ok) await fail("LIST", res);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
          const k = (m[1] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
          keys.push(k.slice(prefix.length));
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1]
          : undefined;
      } while (token);
      return keys.sort();
    },
    async delete(key) {
      const res = await request("DELETE", keyOf(key), {});
      if (!res.ok && res.status !== 404) await fail("DELETE", res);
    },
  };
}
