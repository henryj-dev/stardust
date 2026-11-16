/**
 * Where each of stardust's own tables lives once there are several regions
 * (see TableScope). A new table must be added here: a test compares this
 * list with the migrated schema. `global-auth` tables are global tables that
 * decide who may do what; they are always read from the global database.
 */
export type CoreTableScope = "global" | "global-auth" | "regional" | "each";

export const TABLE_SCOPES: Readonly<Record<string, CoreTableScope>> = {
  // Who may do what: read from the global database for every decision.
  users: "global-auth",
  sessions: "global-auth",
  api_tokens: "global-auth",
  project_members: "global-auth",
  sign_in_failures: "global-auth",
  oidc_logins: "global-auth",
  account_links: "global-auth",
  // Definitions and history every region shares.
  projects: "global",
  audit_events: "global",
  guard_used: "global",
  // What happened in this region.
  runs: "regional",
  jobs: "regional",
  schedule_runs: "regional",
  saga_runs: "regional",
  guard_events: "regional",
  // Every database keeps its own.
  schema_migrations: "each",
};
