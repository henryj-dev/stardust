-- How each component is built and where its manifests live, and what a
-- finished job left behind (its build Job, the image digest, why it failed).

ALTER TABLE projects
  ADD COLUMN components   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(components) = 'array'),
  ADD COLUMN metadata     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  ADD COLUMN webhook_kind text  NOT NULL DEFAULT 'repo' CHECK (webhook_kind IN ('repo', 'workspace'));

ALTER TABLE jobs
  ADD COLUMN detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object');
