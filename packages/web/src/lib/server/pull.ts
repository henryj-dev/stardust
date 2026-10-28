import type { PullTarget } from "@stardust/sdk";

/** The pull form's choice as a target: an empty value means the default branch; null when the kind is unknown. */
export function formTarget(kind: unknown, value: unknown): PullTarget | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "") return {};
  if (kind === "branch") return { branch: v };
  if (kind === "tag") return { tag: v };
  if (kind === "sha") return { sha: v };
  return null;
}
