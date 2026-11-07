import type { ProjectComponent, ProjectView } from "@stardust/sdk";
import type { ProjectFields } from "../project-fields.ts";

export { type ComponentFields, emptyComponent, type ProjectFields } from "../project-fields.ts";

export function projectFields(p: ProjectView): ProjectFields {
  return {
    id: p.id,
    name: p.name,
    githubRepo: p.githubRepo ?? "",
    components: p.components.map((c) => ({
      name: c.name,
      pipeline: c.pipeline,
      context: c.context ?? "",
      dockerfile: c.dockerfile ?? "",
      port: c.port === undefined ? "" : String(c.port),
      buildEnv: Object.entries(c.buildEnv ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      deployDir: c.deployDir,
    })),
  };
}

/** The same rule as the server's: lower-case letters, digits and dashes, starting with a letter. */
const PROJECT_ID = /^[a-z][a-z0-9-]{0,62}$/;
const PIPELINES = ["W", "C", "N"] as const;

const text = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
};

/** Reads the form back into fields. Components are `components.<n>.<field>`, in the order of n. */
export function readFields(form: FormData, id: string): ProjectFields {
  const indices = new Set<number>();
  for (const key of form.keys()) {
    const m = /^components\.(\d+)\./.exec(key);
    if (m) indices.add(Number(m[1]));
  }
  const components = [...indices]
    .sort((a, b) => a - b)
    .map((i) => {
      const f = (field: string) => text(form, `components.${i}.${field}`);
      // Keep the lines as typed; only the ends of the block are trimmed.
      return {
        name: f("name"),
        pipeline: f("pipeline"),
        context: f("context"),
        dockerfile: f("dockerfile"),
        port: f("port"),
        buildEnv: f("buildEnv"),
        deployDir: f("deployDir"),
      };
    });
  return { id, name: text(form, "name"), githubRepo: text(form, "githubRepo"), components };
}

export type Parsed =
  | { ok: true; name: string; githubRepo: string | null; components: ProjectComponent[] }
  | { ok: false; errors: string[] };

/**
 * Checks what the form can tell by itself and turns the text into a project.
 * The server checks the rest (names, repository, paths) and its answer is shown as it comes.
 * Fields that do not apply to a pipeline are dropped, so switching a component from C to N
 * does not send a Dockerfile the server would refuse.
 */
export function parseFields(fields: ProjectFields): Parsed {
  const errors: string[] = [];
  if (!PROJECT_ID.test(fields.id))
    errors.push("The project id must start with a letter and use only lower-case letters, digits and dashes.");
  const components = fields.components.map((c, i): ProjectComponent => {
    const at = `Component ${i + 1}${c.name ? ` (${c.name})` : ""}`;
    const pipeline = (PIPELINES as readonly string[]).includes(c.pipeline)
      ? (c.pipeline as ProjectComponent["pipeline"])
      : null;
    if (!pipeline) errors.push(`${at}: choose a pipeline.`);
    if (c.deployDir === "") errors.push(`${at}: the deploy directory is required.`);
    const out: ProjectComponent = { name: c.name, pipeline: pipeline ?? "C", deployDir: c.deployDir };
    if (c.context !== "") out.context = c.context;
    if (pipeline === "N") {
      if (c.port !== "") {
        const port = Number(c.port);
        if (!/^\d+$/.test(c.port) || port < 1 || port > 65535)
          errors.push(`${at}: the port must be a number from 1 to 65535.`);
        else out.port = port;
      }
      const env = parseBuildEnv(c.buildEnv);
      if (!env.ok) errors.push(...env.errors.map((e) => `${at}: ${e}`));
      else if (Object.keys(env.value).length > 0) out.buildEnv = env.value;
    } else if (c.dockerfile !== "") {
      out.dockerfile = c.dockerfile;
    }
    return out;
  });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    name: fields.name === "" ? fields.id : fields.name,
    githubRepo: fields.githubRepo === "" ? null : fields.githubRepo,
    components,
  };
}

/** `KEY=VALUE` lines; blank lines are skipped and a value may contain `=`. */
export function parseBuildEnv(
  textBlock: string,
): { ok: true; value: Record<string, string> } | { ok: false; errors: string[] } {
  const value: Record<string, string> = {};
  const errors: string[] = [];
  for (const [n, raw] of textBlock.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      errors.push(`build environment line ${n + 1} is not KEY=VALUE.`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key in value) errors.push(`build environment names ${key} twice.`);
    value[key] = line.slice(eq + 1).trim();
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
