/**
 * The database, as plugins see it: parameterised SQL and transactions. The
 * composition root wraps its PostgreSQL client in this; a plugin never
 * builds SQL by splicing values into text.
 */

export interface Database {
  /** Runs one statement with `$1, $2, …` parameters and returns its rows. */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs `work` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<R>(work: (tx: Database) => Promise<R>): Promise<R>;
}
