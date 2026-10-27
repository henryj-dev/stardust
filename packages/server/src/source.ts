import type { CompareResult } from "@stardust/plugin-source-github";

/**
 * The compare API of GitHub (or a host that mirrors its shape). A response
 * without a `files` list — Gitea's, for one — yields `files: null`, which makes
 * the caller fall back to the commits' union: more builds, never fewer.
 */
export function compareApi(apiBaseUrl: string, token: string, fetchFn: typeof fetch = fetch) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return async (repo: string, head1: string, head2: string): Promise<CompareResult> => {
    const res = await fetchFn(`${base}/repos/${repo}/compare/${head1}...${head2}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`compare returned ${res.status}`), { reason: `http_${res.status}` });
    const body = (await res.json()) as { files?: unknown };
    if (!Array.isArray(body.files)) return { files: null };
    return {
      files: body.files
        .filter((f): f is { filename: string; previous_filename?: unknown } => typeof f?.filename === "string")
        .map((f) => ({
          filename: f.filename,
          ...(typeof f.previous_filename === "string" ? { previous_filename: f.previous_filename } : {}),
        })),
    };
  };
}
