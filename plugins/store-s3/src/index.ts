/**
 * Object storage on S3, R2 or MinIO (anything S3-compatible, path-style).
 *
 *   store-s3:
 *     endpoint: https://<account>.r2.cloudflarestorage.com
 *     bucket: stardust
 *     region: auto                      # R2: auto; S3: the bucket's region
 *     accessKeyId: { env: S3_ACCESS_KEY_ID }
 *     secretAccessKey: { env: S3_SECRET_ACCESS_KEY }
 *     prefix: build-logs/               # optional: every key under it
 */
import { definePlugin } from "@stardust/core";
import { s3Store } from "./s3.ts";

export type { S3Options } from "./s3.ts";
export { s3Store } from "./s3.ts";

const isRef = (v: unknown) =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && ("env" in v || "file" in v);
const KEYS = ["endpoint", "bucket", "region", "accessKeyId", "secretAccessKey", "prefix"];

export const plugin = definePlugin({
  manifest: { name: "store-s3", description: "Object storage on S3, R2 or MinIO." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) if (!KEYS.includes(key)) problems.push(`unknown key "${key}"`);
    if (typeof s.endpoint !== "string" || !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(s.endpoint)) {
      problems.push("endpoint must be an http(s) URL");
    } else if (/^https?:\/\/[^/]*@/.test(s.endpoint)) {
      problems.push("endpoint must not contain credentials");
    }
    if (typeof s.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s.bucket))
      problems.push("bucket must be a bucket name");
    if (typeof s.region !== "string" || !/^[a-z0-9-]{1,32}$/.test(s.region))
      problems.push("region must be a region name, or auto");
    for (const key of ["accessKeyId", "secretAccessKey"]) {
      if (!isRef(s[key])) problems.push(`${key} must be a reference: { env: NAME } or { file: PATH }`);
    }
    if (
      s.prefix !== undefined &&
      (typeof s.prefix !== "string" || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/$/.test(s.prefix))
    ) {
      problems.push('prefix must be a key path ending in "/", like build-logs/');
    }
    return problems;
  },
  provides: {
    ports: ["store"],
    async create({ config, resolveSecret }) {
      const at = "plugins.store-s3";
      return {
        store: s3Store({
          endpoint: config.endpoint as string,
          bucket: config.bucket as string,
          region: config.region as string,
          accessKeyId: await resolveSecret(config.accessKeyId, `${at}.accessKeyId`),
          secretAccessKey: await resolveSecret(config.secretAccessKey, `${at}.secretAccessKey`),
          ...(config.prefix ? { prefix: config.prefix as string } : {}),
        }),
      };
    },
  },
});
