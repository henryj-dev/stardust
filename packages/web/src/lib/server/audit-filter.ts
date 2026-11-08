import type { AuditFilter } from "@stardust/sdk";

/** Filter fields the audit pages take from their URL; the server checks the values. */
const FIELDS = ["actor", "action", "project", "since", "until", "before"] as const;

/**
 * The audit filter in a page's URL. Empty fields are dropped. Dates from a
 * `datetime-local` input have no zone; they are read as UTC so the same link
 * shows the same events to everyone.
 */
export function auditFilterFrom(url: URL, options: { project: boolean }): AuditFilter {
  const filter: AuditFilter = {};
  for (const field of FIELDS) {
    if (field === "project" && !options.project) continue;
    const raw = url.searchParams.get(field)?.trim();
    if (!raw) continue;
    filter[field] = (field === "since" || field === "until") && /T\d\d:\d\d(:\d\d)?$/.test(raw) ? `${raw}Z` : raw;
  }
  return filter;
}

/** The link to the next (older) page: the same filter with the cursor. */
export function olderLink(url: URL, next: string | null): string | null {
  if (!next) return null;
  const params = new URLSearchParams(url.searchParams);
  params.set("before", next);
  return `${url.pathname}?${params}`;
}
