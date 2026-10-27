/**
 * Every package an image runs from must list what its shipped code imports
 * under `dependencies`. The images install with `pnpm install --prod`, so an
 * import that resolves only through devDependencies works in tests and fails
 * in the image (this happened: a second `pnpm add -D` moved a runtime
 * dependency). The web package is bundled at build time and is not checked.
 *
 * Usage: node tools/check-runtime-deps.ts [root]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
const TEST = /(\.test|\.dbtest|\.sopstest)\.ts$|\/testing\.ts$/;
const IMPORT =
  /(?:^|[^\w.])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const packageName = (spec: string) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const problems: string[] = [];
for (const group of ["packages", "plugins"]) {
  for (const name of readdirSync(join(root, group))) {
    const dir = join(root, group, name);
    if (group === "packages" && name === "web") continue;
    let manifest: { name: string; dependencies?: Record<string, string> };
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const deps = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const file of files(join(dir, "src"))) {
      if (TEST.test(file)) continue;
      for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? "";
        if (spec.startsWith(".") || spec.startsWith("/") || builtins.has(spec)) continue;
        const pkg = packageName(spec);
        if (pkg !== manifest.name && !deps.has(pkg)) {
          problems.push(`${relative(root, file)} imports ${pkg}, which ${manifest.name} does not list in dependencies`);
        }
      }
    }
  }
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("runtime dependencies ok");
