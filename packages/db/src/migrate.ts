import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

/**
 * Applies pending migrations in file-name order, in one transaction, under an
 * advisory lock so concurrent starters cannot apply the same file twice.
 * Returns the names it applied.
 */
export async function migrate(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('stardust:migrate'))`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(join(dir, file), "utf8"));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
    return applied;
  });
}
