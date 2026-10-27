/**
 * Projects: the repository, the pipeline definition, and per component how to
 * build it and which deploy directory holds its manifests.
 */
import { hasControlCharacter, type JobPipeline, loadPipelineDef, type PipelineDef } from "@stardust/core";
import type { Sql } from "postgres";

export interface Component {
  name: string;
  pipeline: JobPipeline;
  /** Directory inside the source repository used as the build context. */
  context?: string;
  dockerfile?: string;
  /** Pipeline N (a Node app built without a Dockerfile of its own): the port it listens on. */
  port?: number;
  /** Pipeline N: environment during the build, e.g. which adapter to compile in. Not for secrets. */
  buildEnv?: Record<string, string>;
  /** Directory in the deploy repository holding this component's manifests. */
  deployDir: string;
}

export interface Project {
  id: string;
  name: string;
  githubRepo: string | null;
  pipelineDef: PipelineDef | null;
  components: Component[];
  metadata: Record<string, unknown>;
  webhookKind: "repo" | "workspace";
}

const ID = /^[a-z][a-z0-9-]{0,62}$/;
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+$/;

export class ProjectError extends Error {}

export function validateProject(p: Project): void {
  const problems: string[] = [];
  if (!ID.test(p.id)) problems.push(`id "${p.id}" must be lower-case letters, digits and dashes`);
  if (p.githubRepo !== null && !REPO.test(p.githubRepo))
    problems.push(`githubRepo "${p.githubRepo}" is not owner/name`);
  if (!["repo", "workspace"].includes(p.webhookKind)) problems.push("webhookKind must be repo or workspace");
  const seen = new Set<string>();
  for (const [i, c] of p.components.entries()) {
    const at = `components[${i}]`;
    if (!NAME.test(c.name)) problems.push(`${at}.name "${c.name}" is not a DNS label`);
    if (seen.has(c.name)) problems.push(`${at}.name "${c.name}" is a duplicate`);
    seen.add(c.name);
    if (!["W", "C", "N"].includes(c.pipeline)) problems.push(`${at}.pipeline must be W, C or N`);
    if (typeof c.deployDir !== "string" || !REL.test(c.deployDir))
      problems.push(`${at}.deployDir must be a relative path`);
    for (const key of ["context", "dockerfile"] as const) {
      const v = c[key];
      if (v !== undefined && !REL.test(v)) problems.push(`${at}.${key} must be a relative path`);
    }
    if (c.pipeline === "N") {
      if (c.dockerfile !== undefined)
        problems.push(`${at}.dockerfile: pipeline N builds without a Dockerfile of its own`);
      if (c.port !== undefined && !(Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535))
        problems.push(`${at}.port must be a TCP port`);
      if (c.buildEnv !== undefined) {
        if (typeof c.buildEnv !== "object" || c.buildEnv === null || Array.isArray(c.buildEnv))
          problems.push(`${at}.buildEnv must map names to values`);
        else
          for (const [k, v] of Object.entries(c.buildEnv)) {
            if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k)) problems.push(`${at}.buildEnv: "${k}" is not an UPPER_CASE_NAME`);
            if (typeof v !== "string" || hasControlCharacter(v))
              problems.push(`${at}.buildEnv.${k} must be text without control characters`);
          }
      }
    } else if (c.port !== undefined || c.buildEnv !== undefined) {
      problems.push(`${at}: port and buildEnv apply to pipeline N only`);
    }
  }
  if (p.pipelineDef !== null) {
    try {
      loadPipelineDef(p.pipelineDef);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  if (problems.length > 0) throw new ProjectError(`invalid project: ${problems.join("; ")}`);
}

export async function putProject(sql: Sql, p: Project): Promise<void> {
  validateProject(p);
  await sql`
    INSERT INTO projects (id, name, github_repo, pipeline_def, components, metadata, webhook_kind)
    VALUES (${p.id}, ${p.name}, ${p.githubRepo}, ${p.pipelineDef === null ? null : sql.json(p.pipelineDef as never)},
            ${sql.json(p.components as never)}, ${sql.json(p.metadata as never)}, ${p.webhookKind})
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, github_repo = EXCLUDED.github_repo, pipeline_def = EXCLUDED.pipeline_def,
      components = EXCLUDED.components, metadata = EXCLUDED.metadata, webhook_kind = EXCLUDED.webhook_kind,
      updated_at = now()`;
}

type ProjectRow = {
  id: string;
  name: string;
  github_repo: string | null;
  pipeline_def: PipelineDef | null;
  components: Component[];
  metadata: Record<string, unknown>;
  webhook_kind: "repo" | "workspace";
};

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  githubRepo: row.github_repo,
  pipelineDef: row.pipeline_def,
  components: row.components,
  metadata: row.metadata,
  webhookKind: row.webhook_kind,
});

export async function getProject(sql: Sql, id: string): Promise<Project | null> {
  const [row] = await sql<ProjectRow[]>`
    SELECT id, name, github_repo, pipeline_def, components, metadata, webhook_kind FROM projects WHERE id = ${id}`;
  return row ? toProject(row) : null;
}

/** Every project, or (with a user id) only the ones that user is a member of. Ordered by id. */
export async function listProjects(sql: Sql, memberOf?: string): Promise<Project[]> {
  const rows =
    memberOf === undefined
      ? await sql<ProjectRow[]>`
          SELECT id, name, github_repo, pipeline_def, components, metadata, webhook_kind FROM projects ORDER BY id`
      : await sql<ProjectRow[]>`
          SELECT p.id, p.name, p.github_repo, p.pipeline_def, p.components, p.metadata, p.webhook_kind
          FROM projects p JOIN project_members m ON m.project_id = p.id
          WHERE m.user_id = ${memberOf} ORDER BY p.id`;
  return rows.map(toProject);
}

export interface RunView {
  id: string;
  event: string;
  trigger: string;
  ref: string;
  sha: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  jobs: Array<{ name: string; status: string; attempt: number; detail: Record<string, unknown> }>;
}

export async function getRun(sql: Sql, runId: string): Promise<RunView | null> {
  const [row] = await sql<{ project_id: string }[]>`SELECT project_id FROM runs WHERE id = ${runId}`;
  if (!row) return null;
  return (await listRuns(sql, row.project_id, 1, runId))[0] ?? null;
}

export async function listRuns(sql: Sql, projectId: string, limit = 20, onlyRun?: string): Promise<RunView[]> {
  const runs = await sql<
    {
      id: string;
      event: string;
      trigger: string;
      ref: string;
      sha: string;
      status: string;
      created_at: Date;
      finished_at: Date | null;
    }[]
  >`SELECT id, event, trigger, ref, sha, status, created_at, finished_at FROM runs
    WHERE project_id = ${projectId} ${onlyRun ? sql`AND id = ${onlyRun}` : sql``}
    ORDER BY created_at DESC LIMIT ${limit}`;
  if (runs.length === 0) return [];
  const jobs = await sql<
    { run_id: string; name: string; status: string; attempt: number; detail: Record<string, unknown> }[]
  >`
    SELECT run_id, name, status, attempt, detail FROM jobs WHERE run_id IN ${sql(runs.map((r) => r.id))}
    ORDER BY created_at, name`;
  return runs.map((r) => ({
    id: r.id,
    event: r.event,
    trigger: r.trigger,
    ref: r.ref,
    sha: r.sha,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    jobs: jobs
      .filter((j) => j.run_id === r.id)
      .map((j) => ({ name: j.name, status: j.status, attempt: j.attempt, detail: j.detail })),
  }));
}
