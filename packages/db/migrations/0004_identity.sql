-- Users, their project roles, sessions and sign-in attempts.
-- Passwords are scrypt hashes; session tokens are stored as SHA-256 hashes,
-- so a database dump holds no usable credential.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  display_name  text NOT NULL DEFAULT '',
  password_hash text,
  oidc_issuer   text,
  oidc_subject  text,
  is_admin      boolean NOT NULL DEFAULT false,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject),
  CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL))
);

CREATE TABLE project_members (
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('maintainer', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- Failed sign-ins per username in a sliding window, for lockout.
CREATE TABLE sign_in_failures (
  username  text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_in_failures_idx ON sign_in_failures (username, failed_at);
