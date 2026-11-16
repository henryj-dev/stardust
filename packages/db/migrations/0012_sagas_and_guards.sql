-- Sagas: multi-step work against outside systems, recorded after each step
-- so it resumes where it stopped and undoes itself when a step fails.
CREATE TABLE saga_runs (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'),
  status      text NOT NULL CHECK (status IN ('running', 'succeeded', 'compensated', 'compensation-failed')),
  state       jsonb NOT NULL,
  done        text[] NOT NULL DEFAULT '{}',
  failed_step text,
  error       text CHECK (length(error) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saga_runs_open_idx ON saga_runs (kind) WHERE status = 'running';

-- Guards' memory: ids that may be used once (approval tickets), until they
-- expire anyway, and recent events to count (reveals per minute).
CREATE TABLE guard_used (
  scope      text NOT NULL,
  id         text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, id)
);
CREATE TABLE guard_events (
  scope text NOT NULL,
  key   text NOT NULL,
  at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX guard_events_idx ON guard_events (scope, key, at);
