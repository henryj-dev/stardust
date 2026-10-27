-- Sign-ins in progress at an OpenID provider: used once, valid ten minutes.
CREATE TABLE oidc_logins (
  state         text PRIMARY KEY,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
