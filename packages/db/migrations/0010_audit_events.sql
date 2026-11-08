-- Who did what, for people to read back later.
--
-- The application only inserts: an UPDATE is refused by a trigger, and rows
-- leave only by age, through the retention purge. Names are kept as text and
-- ids have no foreign keys, so a record outlives the account, token or
-- project it names. No value of a password, token or secret is ever stored:
-- `detail` carries names (of fields, keys, components), never values.

CREATE TABLE audit_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_kind     text NOT NULL CHECK (actor_kind IN ('user', 'token', 'system', 'anonymous')),
  actor_user_id  uuid,
  actor_name     text CHECK (length(actor_name) <= 200),
  actor_token_id uuid,
  action         text NOT NULL CHECK (action ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
  project_id     text,
  target         text CHECK (length(target) <= 500),
  detail         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  -- The address the server saw, and what the client said about itself. The
  -- dashboard passes on the browser's address and user agent; neither is verified.
  ip             text CHECK (length(ip) <= 100),
  forwarded_for  text CHECK (length(forwarded_for) <= 200),
  user_agent     text CHECK (length(user_agent) <= 500)
);
CREATE INDEX audit_events_project_idx ON audit_events (project_id, id DESC) WHERE project_id IS NOT NULL;
CREATE INDEX audit_events_actor_idx ON audit_events (actor_name, id DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, id DESC);
CREATE INDEX audit_events_at_idx ON audit_events (at);

CREATE FUNCTION audit_events_refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are never changed';
END
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_refuse_update();
