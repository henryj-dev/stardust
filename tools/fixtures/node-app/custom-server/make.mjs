// Stands in for a framework build: writes build/index.js, and records what the
// build environment held so the test can see it arrived as plain values.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync("build", { recursive: true });
const seen = {
  MARK: process.env.MARK ?? null,
  TRICKY: process.env.TRICKY ?? null,
  // Install scripts must not run (--ignore-scripts): the fixture's postinstall would leave this.
  postinstallRan: existsSync("/tmp/postinstall-ran"),
};
writeFileSync(
  "build/index.js",
  `import { createServer } from "node:http";
createServer((_, res) => res.end(JSON.stringify({ entry: "build/index.js", seen: ${JSON.stringify(seen)} }))).listen(process.env.PORT);
`,
);
