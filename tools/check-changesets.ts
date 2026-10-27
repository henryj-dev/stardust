/**
 * Validates the files in .changeset/.
 *
 * stardust ships as one product, so changesets track a single package named
 * "stardust" (charts/stardust/package.json). The internal @stardust/* packages
 * are ignored by changesets — and changesets silently drops a changeset that
 * names an ignored package, which would mean "merged, but never released".
 * This check turns that into an error.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const PRODUCT = "stardust";
const BUMPS = new Set(["patch", "minor", "major"]);

export async function checkChangesets(dir: string): Promise<string[]> {
  const problems: string[] = [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md").sort();

  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
    if (!match) {
      problems.push(`${file}: missing the --- front matter block`);
      continue;
    }
    const [, header = "", body = ""] = match;
    const entries = header.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (entries.length === 0) {
      problems.push(`${file}: names no package; use "${PRODUCT}": patch|minor|major`);
    }
    for (const entry of entries) {
      const pkg = /^\s*["']?([^"':]+)["']?\s*:\s*(\S+)\s*$/.exec(entry);
      if (!pkg) {
        problems.push(`${file}: cannot read "${entry.trim()}"`);
        continue;
      }
      const [, name = "", bump = ""] = pkg;
      if (name !== PRODUCT) {
        problems.push(
          `${file}: names "${name}"; changesets must name "${PRODUCT}" (internal packages are not released)`,
        );
      }
      if (!BUMPS.has(bump)) {
        problems.push(`${file}: bump "${bump}" is not patch, minor or major`);
      }
    }
    if (body.trim() === "") {
      problems.push(`${file}: has no description for the changelog`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = await checkChangesets(join(import.meta.dirname, "..", ".changeset"));
  if (problems.length > 0) {
    console.error(`invalid changesets:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("changesets ok");
}
