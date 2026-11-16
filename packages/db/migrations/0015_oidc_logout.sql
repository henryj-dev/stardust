-- Single sign-on sessions remember the provider's session id (for
-- back-channel logout) and the ID token (to name the session when signing
-- out at the provider). A pending login remembers whether it asked the
-- provider to sign the person in again.
ALTER TABLE sessions ADD COLUMN oidc_sid text;
ALTER TABLE sessions ADD COLUMN oidc_id_token text;
CREATE INDEX sessions_oidc_sid_idx ON sessions (oidc_sid) WHERE oidc_sid IS NOT NULL;
ALTER TABLE oidc_logins ADD COLUMN reauth boolean NOT NULL DEFAULT false;
