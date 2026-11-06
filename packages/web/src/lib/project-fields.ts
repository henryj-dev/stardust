// Shared by the project form (browser) and its server code.

/** What the project form shows: every field as text, so a refused form comes back as it was typed. */
export interface ComponentFields {
  name: string;
  pipeline: string;
  context: string;
  dockerfile: string;
  port: string;
  /** One `KEY=VALUE` per line. */
  buildEnv: string;
  deployDir: string;
}

export interface ProjectFields {
  id: string;
  name: string;
  githubRepo: string;
  components: ComponentFields[];
}

/** A new component row: pipeline C until someone picks another. */
export function emptyComponent(): ComponentFields {
  return { name: "", pipeline: "C", context: "", dockerfile: "", port: "", buildEnv: "", deployDir: "" };
}
