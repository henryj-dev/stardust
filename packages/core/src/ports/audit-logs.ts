/**
 * A cloud provider's audit log, read by time window. The `cloud-audit`
 * feature reads each source on a schedule and runs the detection rules
 * (core `detect`) over what it gets.
 */
import type { AuditRecord } from "../audit/detect.ts";

export interface AuditWindow {
  /** Oldest first. */
  records: AuditRecord[];
  /** True when the source stopped early (too many records): read again from the last record. */
  truncated: boolean;
}

export interface AuditLogSource {
  read(since: Date, before: Date): Promise<AuditWindow>;
}
