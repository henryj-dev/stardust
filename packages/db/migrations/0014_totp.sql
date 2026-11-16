-- Two-step sign-in for local accounts: a TOTP secret per user (sealed with
-- auth.local.totpKey when one is configured), the last step used so a code
-- works once, recovery codes as hashes, and the challenge between the
-- password and the code.
CREATE TABLE user_totp (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret       text NOT NULL,
  confirmed_at timestamptz,
  last_step    bigint
);

CREATE TABLE user_recovery_codes (
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE sign_in_challenges (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0
);

-- When the session last proved its sign-in again, for actions that cannot be undone.
ALTER TABLE sessions ADD COLUMN reauth_at timestamptz;
