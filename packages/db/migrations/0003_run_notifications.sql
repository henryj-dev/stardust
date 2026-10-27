-- Announce every change to a run or one of its jobs on the
-- `stardust_runs` channel as "<project id> <run id>", so the server can push
-- updates to dashboards instead of polling.

CREATE FUNCTION stardust_notify_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rid uuid;
  pid text;
BEGIN
  IF TG_TABLE_NAME = 'runs' THEN
    rid := NEW.id;
    pid := NEW.project_id;
  ELSE
    rid := NEW.run_id;
    SELECT project_id INTO pid FROM runs WHERE id = rid;
  END IF;
  PERFORM pg_notify('stardust_runs', pid || ' ' || rid::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER runs_notify AFTER INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION stardust_notify_run();
CREATE TRIGGER jobs_notify AFTER INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION stardust_notify_run();
