-- Webhooks were removed: runs start only when someone asks for one.
-- The delivery claims went with them. projects.webhook_kind stays for now:
-- during a rolling upgrade the pods of the previous release still read it.
-- Nothing writes or reads it any more; a later migration drops it.
DROP TABLE IF EXISTS webhook_deliveries;
COMMENT ON COLUMN projects.webhook_kind IS 'unused since webhooks were removed; dropped in a later release';
