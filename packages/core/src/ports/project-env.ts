/**
 * A project's env, as plugins change it: secret values on one layer (a
 * component, or `_shared` for all of them), committed the way the env editor
 * commits them, so the components that read the layer roll out. Values are
 * never read back.
 */
export interface ProjectEnv {
  /** Sets each value, or removes it when null, in one commit. */
  setSecrets(
    project: string,
    layer: string,
    values: Record<string, string | null>,
    by: string,
  ): Promise<{ status: "committed" | "no_change"; commit: string | null }>;
}
