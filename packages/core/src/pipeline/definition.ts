/**
 * Pipeline definition: which jobs a project runs, when, and in what order.
 *
 * The document format is kept from the predecessor system (ADR 0003) so
 * existing definitions load unchanged. A `version` field is added; it is
 * optional and, when present, must be 1.
 *
 * Build kinds (`pipeline`):
 * - `C` — container image built from the component's Dockerfile
 * - `N` — Node.js application image built without a Dockerfile
 * - `W` — Cloudflare Workers deployment
 */

export type JobPipeline = "W" | "C" | "N";
const PIPELINES: readonly JobPipeline[] = ["W", "C", "N"];

export interface PipelineOn {
  push?: { branches?: string[]; tags?: string[] };
  pull_request?: { branches?: string[] };
  schedule?: Array<{ cron: string }>;
  workflow_dispatch?: Record<string, unknown> | true | null;
}

export interface JobDef {
  pipeline: JobPipeline;
  /** For `C`: the component to build. `W` and `N` use the project's only component. */
  component?: string;
  /** Jobs that must all succeed before this one starts. */
  needs?: string[];
  if?: {
    /** Glob patterns; on push, the job runs only if a changed path matches one. */
    paths?: string[];
  };
}

export interface PipelineDef {
  version?: 1;
  on?: PipelineOn;
  jobs: Record<string, JobDef>;
}

export class PipelineDefError extends Error {
  readonly problem: string;

  constructor(problem: string) {
    super(`invalid pipeline definition: ${problem}`);
    this.name = "PipelineDefError";
    this.problem = problem;
  }
}

/** Default definition for a project: one manually triggered job per component. */
export function pipelineDefFromComponents(
  components: ReadonlyArray<{ name: string; pipeline: JobPipeline }>,
): PipelineDef {
  const jobs: Record<string, JobDef> = {};
  for (const component of components) {
    const key = component.name.toLowerCase();
    if (jobs[key]) {
      throw new PipelineDefError(`duplicate component name "${component.name}"`);
    }
    jobs[key] = {
      pipeline: component.pipeline,
      ...(component.pipeline === "C" ? { component: component.name } : {}),
    };
  }
  return { on: { workflow_dispatch: {} }, jobs };
}

/**
 * Checks a definition: at least one job, known build kinds, `needs` that point
 * at existing jobs (not at themselves), and no cycles. Returns the first
 * problem found, in the order above.
 */
export function validatePipelineDef(def: unknown): { ok: true } | { ok: false; error: string } {
  if (!def || typeof def !== "object") return { ok: false, error: "not an object" };
  const d = def as Partial<PipelineDef>;
  if (d.version !== undefined && d.version !== 1) {
    return { ok: false, error: `unsupported version ${String(d.version)}` };
  }
  if (!d.jobs || typeof d.jobs !== "object") return { ok: false, error: "jobs is missing" };
  const jobs = d.jobs;
  const keys = Object.keys(jobs);
  if (keys.length === 0) return { ok: false, error: "jobs is empty" };

  for (const key of keys) {
    const job = jobs[key];
    if (!job || typeof job !== "object") return { ok: false, error: `job "${key}" is not an object` };
    if (!PIPELINES.includes(job.pipeline)) {
      return { ok: false, error: `job "${key}": pipeline must be W, C or N (got ${String(job.pipeline)})` };
    }
    if (job.needs !== undefined) {
      if (!Array.isArray(job.needs)) return { ok: false, error: `job "${key}": needs must be an array` };
      for (const dep of job.needs) {
        if (dep === key) return { ok: false, error: `job "${key}" needs itself` };
        if (!keys.includes(dep)) return { ok: false, error: `job "${key}" needs "${dep}", which does not exist` };
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, path: string[]): string | null => {
    if (visiting.has(key)) return `cycle: ${[...path, key].join(" -> ")}`;
    if (visited.has(key)) return null;
    visiting.add(key);
    for (const dep of jobs[key]?.needs ?? []) {
      const cycle = visit(dep, [...path, key]);
      if (cycle) return cycle;
    }
    visiting.delete(key);
    visited.add(key);
    return null;
  };
  for (const key of keys) {
    const cycle = visit(key, []);
    if (cycle) return { ok: false, error: cycle };
  }
  return { ok: true };
}

/** Validates and returns the definition, or throws `PipelineDefError`. */
export function loadPipelineDef(value: unknown): PipelineDef {
  const result = validatePipelineDef(value);
  if (!result.ok) throw new PipelineDefError(result.error);
  return value as PipelineDef;
}
