-- Plugin schedules: one row per schedule (`<plugin>.<id>`). A worker claims
-- a run by moving `last_started_at` forward while holding a lease, in one
-- UPDATE, so across any number of workers a schedule runs at most once per
-- interval. A worker that dies mid-run leaves the lease to expire.

CREATE TABLE schedule_runs (
  name             text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'),
  holder           text,
  lease_until      timestamptz,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_error       text CHECK (length(last_error) <= 2000)
);
