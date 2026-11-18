# worker-smoke

A Cloudflare Worker small enough to read in a minute, for checking that
pipeline W releases end to end: the D1 migration in `migrations/` is applied,
a secret is uploaded with `wrangler secret bulk`, and the Worker is deployed.

`GET /` records a hit in D1 and answers with the number of hits, whether
`SMOKE_SECRET` is set (never its value) and the plain `GREETING` variable.

The Worker's configuration is the operator's, not this directory's (see
`docs/configuration.md`, "Pipeline W"). An example `wrangler.jsonc` for the
ConfigMap `wrangler-<project>-<component>`, with paths relative to this
directory:

```jsonc
{
  "name": "stardust-worker-smoke",
  "main": "src/index.js",
  "compatibility_date": "2026-11-01",
  "workers_dev": true,
  "vars": { "GREETING": "hello from stardust" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "stardust-worker-smoke",
      "database_id": "<the D1 database id>",
      "migrations_dir": "migrations"
    }
  ]
}
```

and `secrets.json` for the optional Secret of the same name:

```json
{ "SMOKE_SECRET": "<any value>" }
```

Register it as a component with pipeline `W` and context
`examples/worker-smoke`.
