/**
 * The builder: turns a commit into a pushed image. stardust records the
 * digest it reports and points the deploy repository at it; a build that
 * reports no digest has failed.
 */

/** What one build makes: one component's image at one commit. */
export interface BuildRequest {
  projectId: string;
  /** `owner/name` on the source host. */
  repo: string;
  /** Full commit SHA to build. */
  sha: string;
  component: string;
  /** Path of the Dockerfile and build context inside the repository. Defaults to the root. */
  context?: string;
  dockerfile?: string;
  /**
   * "dockerfile" (default) builds the repository's Dockerfile; "node" builds a
   * Node app with the builder's own; "mirror" copies `source` as it is.
   */
  kind?: "dockerfile" | "node" | "mirror";
  /** kind "mirror": the published image, pinned by digest. */
  source?: string;
  /** False for code nobody here reviewed: the build gets no clone token and no project secret. */
  trusted?: boolean;
  /** Port the Node app listens on (kind "node"). */
  port?: number;
  /** Environment during the Node build (kind "node"). Not secret. */
  buildEnv?: Record<string, string>;
  /** Run id and job name, so the build and its log can be found again. */
  runId: string;
  jobName: string;
}

export interface BuildOutcome {
  result: "success" | "failed" | "cancelled";
  jobName: string;
  digest?: string;
  /** Why it failed, when it did. */
  reason?: string;
  /** The last lines of the build container's log. */
  logTail: string;
}

export interface BuildOptions {
  signal: AbortSignal;
  pollMs?: number;
}

export interface BuildLogQuery {
  runId: string;
  /** The job's name in the run, as the build pod's label carries it. */
  jobName: string;
  /** Keep the response open and send lines as the build prints them. */
  follow: boolean;
  signal: AbortSignal;
}

export type BuildLog =
  /** No pod: the build has not been created yet, or it was cleaned up. */
  | { state: "none" }
  /** The pod exists but the build container has not started (cloning, pulling the image). */
  | { state: "waiting" }
  | { state: "open"; pod: string; body: AsyncIterable<Uint8Array> };

export type BuildLogReader = (query: BuildLogQuery) => Promise<BuildLog>;

export interface Builder {
  /** Builds and pushes. Throws when the request itself is invalid. */
  build(request: BuildRequest, options: BuildOptions): Promise<BuildOutcome>;
  /** The build's log while the builder still has it. */
  logs?: BuildLogReader;
}

/** The `images` port: where a component's builds are pushed, known without building. */
export interface ImageNaming {
  /** `<registry>/<project>/<component>`, without a tag. */
  repository(projectId: string, component: string): string;
}
