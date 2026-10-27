-- Baseline schema. Status lists must match packages/core (job-status.ts);
-- packages/db/src/schema.dbtest.ts fails when they drift apart.

CREATE TABLE projects (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,62}$'),
  name         text NOT NULL,
  github_repo  text,
  pipeline_def jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  event         text NOT NULL,
  trigger       text NOT NULL,
  ref           text NOT NULL,
  sha           text NOT NULL,
  -- The definition as it was when the run started; later edits do not change a run.
  def           jsonb NOT NULL,
  -- Changed paths of a push, for path filters. NULL when not known.
  changed_paths text[],
  status        text NOT NULL DEFAULT 'running'
                CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX runs_project_created_idx ON runs (project_id, created_at DESC);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL
                   CHECK (status IN ('queued', 'running', 'success', 'failed', 'unknown', 'skipped', 'cancelled')),
  attempt          integer NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (run_id, name)
);

CREATE INDEX jobs_queued_idx ON jobs (created_at, id) WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
