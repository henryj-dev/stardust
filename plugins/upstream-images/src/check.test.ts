import assert from "node:assert/strict";
import { it } from "node:test";
import type { Database, FeatureContext } from "@stardust/core";
import { checkAll } from "./index.ts";

const d = (c: string) => `sha256:${c.repeat(64)}`;

it("finds a newer release for a mirrored image, says when it cannot check, and changes nothing", async () => {
  const rows: unknown[][] = [];
  const db: Database = {
    query: async (_text: string, params: readonly unknown[] = []) => {
      rows.push([...params]);
      return [];
    },
    transaction: async (work) => work(db),
  } as Database;
  const ctx = {
    config: {},
    ports: {
      database: db,
      projects: {
        get: async () => null,
        list: async () => [
          {
            id: "counter",
            name: "Counter",
            githubRepo: null,
            components: [
              { name: "app", deployDir: "a", pipeline: "M", image: `docker.io/org/counter:2.7.0@${d("a")}` },
              { name: "api", deployDir: "b", pipeline: "C" },
              { name: "other", deployDir: "c", pipeline: "M", image: `ghcr.io/org/other:1@${d("b")}` },
            ],
          },
        ],
      },
    },
  } as unknown as FeatureContext;
  const fetcher = async (url: string) => {
    assert.match(url, /^https:\/\/hub\.docker\.com\/v2\/repositories\/org\/counter\/tags/);
    return Response.json({
      results: [
        { name: "2.7.0", digest: d("a") },
        { name: "2.8.0", digest: d("c") },
      ],
    });
  };
  assert.equal(await checkAll(ctx, fetcher), 2);
  const app = rows.find((r) => r[1] === "app");
  assert.deepEqual(app?.slice(3, 7), ["2.8.0", d("c"), true, null]);
  const other = rows.find((r) => r[1] === "other");
  assert.deepEqual(other?.slice(5, 7), [false, "only Docker Hub images are checked"]);
});
