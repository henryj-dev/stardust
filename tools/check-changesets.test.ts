import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkChangesets } from "./check-changesets.ts";

async function problemsFor(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "changesets-"));
  try {
    await writeFile(join(dir, "config.json"), "{}");
    await writeFile(join(dir, "README.md"), "# not a changeset\n");
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(dir, name), text);
    }
    return await checkChangesets(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("checkChangesets", () => {
  it("accepts an empty directory and a valid changeset", async () => {
    assert.deepEqual(await problemsFor({}), []);
    assert.deepEqual(await problemsFor({ "a.md": '---\n"stardust": minor\n---\n\nAdd a thing.\n' }), []);
  });

  const rejected: [string, string, RegExp][] = [
    ["an internal package", '---\n"@stardust/core": patch\n---\n\nx\n', /names "@stardust\/core"/],
    ["an unknown bump", '---\n"stardust": huge\n---\n\nx\n', /bump "huge"/],
    ["no package", "---\n\n---\n\nx\n", /names no package/],
    ["no description", '---\n"stardust": patch\n---\n\n', /no description/],
    ["no front matter", "just text\n", /front matter/],
  ];
  for (const [label, text, expected] of rejected) {
    it(`rejects ${label}`, async () => {
      const problems = await problemsFor({ "x.md": text });
      assert.equal(problems.length, 1, problems.join("\n"));
      assert.match(problems[0] ?? "", expected);
    });
  }
});
