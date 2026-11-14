CREATE TABLE vultr_broker_approval_replays (
  jti UUID PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('instance-destroy', 'create-rollback')),
  target UUID NOT NULL,
  actor TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'consumed')),
  claim_token UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX vultr_broker_approval_replays_expires_idx
  ON vultr_broker_approval_replays (expires_at);

-- Apply grants separately to the deployment-specific login role. It needs only
-- SELECT, INSERT, UPDATE, DELETE on this table; it must not receive schema DDL privileges.
