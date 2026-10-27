import { type CasOptions, commitWithCas } from "./cas.ts";
import { planDirectoryRewrite } from "./image-tag.ts";
import type { CommitResult, PendingCommit, RepoIO } from "./repo.ts";

export interface BumpImage {
  /** The component's directory in the deploy repository. */
  dir: string;
  project: string;
  component: string;
  /** Full commit SHA that was built. */
  sha: string;
  digest?: string | null;
  buildRev?: string | null;
  buildRevAnnotation?: string;
}

export type BumpResult =
  | CommitResult
  /** No manifest in `dir` references the image: the coordinates are wrong. */
  | { status: "error"; kind: "no_reference"; message: string };

/**
 * The commit message stardust writes. Its format is a contract: the GitHub
 * source ignores pushes whose head commit matches it (`SELF_COMMIT_RE`), which
 * is what stops a bump from triggering another build.
 */
export function bumpMessage(project: string, component: string, shortSha: string): string {
  return `chore(${project}/${component}): image -> ${shortSha}`;
}

class NoReference extends Error {}

/** Points every manifest in `dir` that uses the component's image at the new build, in one commit. */
export async function bumpImage(repo: RepoIO, input: BumpImage, options?: CasOptions): Promise<BumpResult> {
  const shortSha = input.sha.slice(0, 7);
  try {
    return await commitWithCas(
      repo,
      async (_head, at) => {
        const names = await at.list(input.dir);
        const files = new Map<string, string>();
        for (const name of names) {
          const file = await at.read(`${input.dir}/${name}`);
          if (file) files.set(name, file.content);
        }
        const plan = planDirectoryRewrite(files, {
          project: input.project,
          component: input.component,
          shortSha,
          digest: input.digest ?? null,
          buildRev: input.buildRev ?? null,
          ...(input.buildRevAnnotation ? { buildRevAnnotation: input.buildRevAnnotation } : {}),
        });
        if (plan.referencing.length === 0) {
          throw new NoReference(`no manifest in ${input.dir} references ${input.project}/${input.component}`);
        }
        if (plan.toCommit.length === 0) return null;
        const pending: PendingCommit = new Map(plan.toCommit.map((f) => [`${input.dir}/${f.name}`, f.text]));
        return { files: pending, message: bumpMessage(input.project, input.component, shortSha) };
      },
      options,
    );
  } catch (err) {
    if (err instanceof NoReference) return { status: "error", kind: "no_reference", message: err.message };
    throw err;
  }
}
