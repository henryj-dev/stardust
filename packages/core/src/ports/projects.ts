/**
 * Projects, as plugins read them: which components a project has and where
 * each one's manifests live. Plugins never read stardust's tables directly.
 */

export interface ComponentInfo {
  name: string;
  /** Directory in the deploy repository holding this component's manifests. */
  deployDir: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** `owner/name` on the source host. */
  githubRepo: string | null;
  components: ComponentInfo[];
}

/** The `projects` port. */
export interface ProjectCatalog {
  get(id: string): Promise<ProjectInfo | null>;
}
