-- Runs an operator asked for, and projects that take no webhooks at all.
-- requested_by is the username behind a manual run (null for webhook runs);
-- it is kept as text so the record outlives the account.

ALTER TABLE runs ADD COLUMN requested_by text;

ALTER TABLE projects DROP CONSTRAINT projects_webhook_kind_check;
ALTER TABLE projects ADD CONSTRAINT projects_webhook_kind_check CHECK (webhook_kind IN ('repo', 'workspace', 'off'));
