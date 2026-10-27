-- Deliveries that started a run, so a re-sent copy does not start another.
CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,
  project_id  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_age_idx ON webhook_deliveries (received_at);
