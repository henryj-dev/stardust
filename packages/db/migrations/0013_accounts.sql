-- One-time links an administrator hands to someone: an invitation to set a
-- first password, or a reset. Only the token's SHA-256 is stored; a link is
-- used once and expires.
CREATE TABLE account_links (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX account_links_user_idx ON account_links (user_id);

-- How a session was started, so a sensitive action can ask again the same way.
ALTER TABLE sessions ADD COLUMN via text NOT NULL DEFAULT 'password' CHECK (via IN ('password', 'oidc'));
