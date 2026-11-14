/**
 * Signs of compromise in a cloud provider's audit log. Pure: the rules see
 * one normalized record shape, whatever source produced it.
 *
 * Providers such as Cloudflare raise no alert when their configuration
 * changes, so a stolen token could create an access application unnoticed.
 * These rules fill that gap. They are few and quiet on purpose: a noisy
 * alert gets switched off, and a switched-off detection is no detection.
 *
 * Rules are built on fields observed in real records. A rule on a guessed
 * field name finds nothing, and nothing found looks exactly like nothing
 * wrong.
 */

export interface AuditRecord {
  id: string;
  /** ISO 8601 */
  when: string;
  /** e.g. "gateway_create", "access_app_update" */
  actionType: string;
  actorType: "user" | "account_token" | "system" | "unknown";
  /** A token's id (logs carry no token names), or a user's id. */
  actorId: string;
  /** Users only; empty for tokens. */
  actorEmail: string;
  actorIp: string;
  interfaceHost: string;
  resourceType: string;
  resourceId: string;
  /** Whether the action succeeded. A failed attempt is a signal too: someone probing permissions. */
  result: boolean;
}

export type FindingSeverity = "high" | "medium";

export interface AuditFinding {
  severity: FindingSeverity;
  /** Stable id of the rule: findings are deduplicated by record and rule. */
  rule:
    | "automation-token-out-of-scope"
    | "protected-area-change"
    | "unknown-account-token"
    | "failed-attempt"
    | "unclassifiable-record";
  reason: string;
  record: AuditRecord;
}

export interface DetectionConfig {
  /**
   * Your automation tokens, by token id, and the action type prefixes each
   * may touch, e.g. `{ "19941d8e…": ["gateway_"] }`. By id, because logs
   * carry no token names.
   */
  automationTokens: Readonly<Record<string, readonly string[]>>;
  /** Areas you never change through the API: any change there is reported, whoever made it. */
  alwaysAlertPrefixes: readonly string[];
}

/** Access is reported by default: a token with Zero Trust edit rights can write it, so a stolen one goes there first. */
export const DEFAULT_ALWAYS_ALERT_PREFIXES: readonly string[] = ["access_"];

const has = (actionType: string, prefixes: readonly string[]) => prefixes.some((p) => actionType.startsWith(p));
const short = (id: string) => `${id.slice(0, 8)}…`;

/** One record's findings, none or several. */
export function detect(record: AuditRecord, config: DetectionConfig): AuditFinding[] {
  const out: AuditFinding[] = [];
  const allowed = config.automationTokens[record.actorId];
  const add = (severity: FindingSeverity, rule: AuditFinding["rule"], reason: string) =>
    out.push({ severity, rule, reason, record });
  if (record.actorType === "account_token" && allowed && !has(record.actionType, allowed)) {
    add(
      "high",
      "automation-token-out-of-scope",
      `automation token ${short(record.actorId)} did '${record.actionType}', outside ${allowed.join(", ")}`,
    );
  }
  if (has(record.actionType, config.alwaysAlertPrefixes)) {
    add(
      "high",
      "protected-area-change",
      `a change where the API is never used: '${record.actionType}' by ${record.actorType} ${short(record.actorId)}`,
    );
  }
  if (record.actorType === "account_token" && !allowed) {
    add(
      "medium",
      "unknown-account-token",
      `unregistered account token ${short(record.actorId)} did '${record.actionType}'`,
    );
  }
  if (!record.result)
    add("medium", "failed-attempt", `a failed attempt: '${record.actionType}' by ${record.actorType}`);
  if (!record.actionType) {
    add("medium", "unclassifiable-record", "the record has no action type: the audit log's shape may have changed");
  }
  return out;
}

/** A batch's findings, high first, newest first. */
export function detectAll(records: readonly AuditRecord[], config: DetectionConfig): AuditFinding[] {
  const rank = (s: FindingSeverity) => (s === "high" ? 0 : 1);
  return records
    .flatMap((r) => detect(r, config))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.record.when.localeCompare(a.record.when));
}
