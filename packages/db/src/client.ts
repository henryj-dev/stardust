import postgres, { type Options, type Sql } from "postgres";

/** Opens a connection pool. Notices are dropped; errors still throw. */
export function connect(url: string, options: Options<Record<string, never>> = {}): Sql {
  return postgres(url, { onnotice: () => {}, ...options });
}
