-- How people sign in, as administrators set it on the dashboard. One row.
-- A null column follows stardust.yaml; a value there takes precedence over it.
CREATE TABLE sign_in_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Create an account when someone the provider signs in has none (identity-oidc autoCreate).
  auto_create boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
