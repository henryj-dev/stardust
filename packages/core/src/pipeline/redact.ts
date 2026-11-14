/**
 * Masks credentials that a build may have printed before its log is kept.
 * The clone token never reaches the build container, so this is a second
 * line: well-known token shapes and credentials in URLs.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // GitHub tokens: personal, OAuth, app installation, user-to-server, fine-grained.
  [/\b(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, "[redacted]"],
  // Credentials in a URL: scheme://user:secret@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted]@"],
  // Authorization headers.
  [/\b(authorization:\s*(?:bearer|basic|token)\s+)[^\s'"]+/gi, "$1[redacted]"],
  // AWS access key ids.
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]"],
];

export function redactLog(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Where a job's kept build log lives in the object store. */
export function buildLogKey(projectId: string, runId: string, jobName: string): string {
  return `build-logs/${projectId}/${runId}/${jobName}.log`;
}
