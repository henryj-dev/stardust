/**
 * Upstream images: whether the image a mirrored component (pipeline M) is
 * pinned to has a newer release. Checked daily; nothing is changed: moving
 * the pin is a person's decision, made by editing the component.
 *
 *   upstream-images: {}
 *
 * Docker Hub images are read (its public tag API); others are reported as
 * not supported rather than guessed at.
 */
import { type Database, definePlugin, type FeatureContext, type Route } from "@stardust/core";
import { type Candidate, dockerHubRef, latest, rank } from "./tags.ts";

export { type Candidate, dockerHubRef, latest, rank, versionOf } from "./tags.ts";

const MIGRATION = `
-- The newest release each mirrored component's upstream has, as last seen.
CREATE TABLE upstream_images_checks (
  project_id    text NOT NULL,
  component     text NOT NULL,
  pinned        text NOT NULL,
  latest_tag    text,
  latest_digest text,
  newer         boolean NOT NULL DEFAULT false,
  error         text CHECK (length(error) <= 500),
  checked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, component)
);
`;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Docker Hub's published tags with their digests, newest first. */
export async function dockerHubTags(repo: string, fetcher: Fetcher = fetch): Promise<Candidate[]> {
  const res = await fetcher(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("the image is not public");
  if (res.status === 404) throw new Error("no such public image");
  if (res.status === 429) throw new Error("Docker Hub's rate limit: try later");
  if (!res.ok) throw new Error(`Docker Hub answered ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ name?: unknown; digest?: unknown }> };
  const ranked = rank(body.results ?? []);
  if (ranked.length === 0) throw new Error("Docker Hub listed no tag with a digest");
  return ranked;
}

const database = (ctx: FeatureContext): Database => {
  if (!ctx.ports.database) throw new Error("upstream-images needs the database");
  return ctx.ports.database;
};

/** Checks every mirrored component and records what it found. */
export async function checkAll(ctx: FeatureContext, fetcher: Fetcher = fetch): Promise<number> {
  const db = database(ctx);
  const projects = (await ctx.ports.projects?.list?.()) ?? [];
  let checked = 0;
  for (const p of projects) {
    for (const c of p.components) {
      if (c.pipeline !== "M" || !c.image) continue;
      checked++;
      const ref = dockerHubRef(c.image);
      let found: { tag: string | null; digest: string | null; newer: boolean; error: string | null };
      if (!ref) {
        found = { tag: null, digest: null, newer: false, error: "only Docker Hub images are checked" };
      } else {
        try {
          const newest = latest(await dockerHubTags(ref.repo, fetcher));
          found = {
            tag: newest?.tag ?? null,
            digest: newest?.digest ?? null,
            newer: Boolean(newest && newest.digest !== ref.digest),
            error: null,
          };
        } catch (err) {
          found = { tag: null, digest: null, newer: false, error: (err as Error).message.slice(0, 500) };
        }
      }
      await db.query(
        `INSERT INTO upstream_images_checks (project_id, component, pinned, latest_tag, latest_digest, newer, error, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (project_id, component) DO UPDATE SET pinned = $3, latest_tag = $4, latest_digest = $5, newer = $6, error = $7, checked_at = now()`,
        [p.id, c.name, c.image, found.tag, found.digest, found.newer, found.error],
      );
    }
  }
  return checked;
}

function routes(ctx: FeatureContext): Route[] {
  const db = database(ctx);
  return [
    {
      method: "GET",
      path: "/checks",
      permission: "upstream-images:read",
      async handle() {
        const checks = await db.query(
          `SELECT project_id AS "projectId", component, pinned, latest_tag AS "latestTag", latest_digest AS "latestDigest",
                  newer, error, checked_at AS "checkedAt"
           FROM upstream_images_checks ORDER BY newer DESC, project_id, component`,
        );
        return { status: 200, body: { checks } };
      },
    },
    {
      method: "POST",
      path: "/checks",
      permission: "upstream-images:write",
      audit: "upstream-images.check",
      async handle() {
        const checked = await checkAll(ctx);
        return { status: 200, body: { checked }, audit: { target: "all", detail: { checked } } };
      },
    },
  ];
}

export const plugin = definePlugin({
  manifest: { name: "upstream-images", description: "Whether mirrored images have newer releases." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    return Object.keys(section).map((k) => `unknown key "${k}"`);
  },
  requires: ["database", "projects"],
  permissions: [
    { id: "upstream-images:read", description: "See whether mirrored images have newer releases", grantedTo: "admins" },
    { id: "upstream-images:write", description: "Check now", grantedTo: "admins" },
  ],
  capabilities: ["upstream-images.checks"],
  migrations: async () => [{ name: "0001_checks.sql", scope: "regional", sql: MIGRATION }],
  schedules: [{ id: "check", everyMs: 24 * 3_600_000, run: async (ctx) => void (await checkAll(ctx)) }],
  routes,
});
