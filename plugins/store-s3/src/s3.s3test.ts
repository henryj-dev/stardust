/**
 * The ObjectStore contract against a real S3-compatible server:
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=test S3_TEST_KEY=… S3_TEST_SECRET=… pnpm run test:s3
 */
import { objectStoreContract } from "@stardust/core/testing";
import { s3Store } from "./s3.ts";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

objectStoreContract("store-s3 (real server)", async () =>
  s3Store({
    endpoint: env("S3_TEST_ENDPOINT"),
    bucket: env("S3_TEST_BUCKET"),
    region: process.env.S3_TEST_REGION ?? "us-east-1",
    accessKeyId: env("S3_TEST_KEY"),
    secretAccessKey: env("S3_TEST_SECRET"),
    prefix: "contract-run/",
  }),
);
