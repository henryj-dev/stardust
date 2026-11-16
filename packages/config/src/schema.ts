import { z } from "zod";

/**
 * A value that must not be written into stardust.yaml in plain text.
 * It is read from an environment variable or a mounted file instead.
 */
export const secretRef = z.union([
  z.strictObject({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name") }),
  z.strictObject({ file: z.string().min(1) }),
]);

export const configSchema = z.strictObject({
  version: z.literal(1),
  /**
   * The region this installation serves: one installation, one cluster, one
   * region. Records this installation owns carry it. There is no default, so
   * two installations cannot both silently be the same region.
   */
  region: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "must be a lower-case name such as eu-west or office"),
  server: z.strictObject({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().min(1).max(65535).default(8080),
    publicUrl: z.url({ protocol: /^https?$/ }),
    /** The first administrator, created when there are no users yet. */
    bootstrapAdmin: z
      .strictObject({
        username: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "must be lower-case letters, digits, '.', '_' or '-'"),
        password: secretRef,
      })
      .optional(),
  }),
  database: z.strictObject({
    url: secretRef,
  }),
  /**
   * Signing in. Local accounts (username and password) are on unless turned
   * off; their two-step sign-in (TOTP) is off, optional or required. An OIDC
   * session's second step is the provider's. `reauthMinutes`: how recent a
   * sign-in must be for actions that cannot be undone.
   */
  auth: z
    .strictObject({
      local: z
        .strictObject({
          enabled: z.boolean().default(true),
          totp: z.enum(["off", "optional", "required"]).default("optional"),
          /** Encrypts the TOTP secrets in the database. Without it they are stored as they are. */
          totpKey: secretRef.optional(),
        })
        .default({ enabled: true, totp: "optional" }),
      reauthMinutes: z.number().int().min(1).max(1440).default(10),
    })
    .default({ local: { enabled: true, totp: "optional" }, reauthMinutes: 10 }),
  /**
   * Jobs across all workers. `maxRunning` caps how many run at once; 0 is no
   * limit. `upstreamBuilds` lists the external projects whose own code may be
   * built (otherwise they are only mirrored).
   */
  jobs: z
    .strictObject({
      maxRunning: z.number().int().min(0).max(1000).default(0),
      upstreamBuilds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)).default([]),
    })
    .default({ maxRunning: 0, upstreamBuilds: [] }),
  /** The audit log. The worker removes events older than `retentionDays`; 0 keeps them all. */
  audit: z
    .strictObject({
      retentionDays: z.number().int().min(0).max(36500).default(365),
    })
    .default({ retentionDays: 365 }),
  /**
   * Each key enables one plugin; the value is validated by that plugin. An
   * empty section (`source-github:` with nothing after it) is an empty mapping:
   * YAML reads it as null, and so does Helm when values set it to `{}`.
   */
  plugins: z
    .record(z.string(), z.unknown())
    .default({})
    .transform((plugins) =>
      Object.fromEntries(Object.entries(plugins).map(([name, section]) => [name, section ?? {}])),
    ),
});

export type RawConfig = z.infer<typeof configSchema>;

/** Configuration after secret references have been resolved to their values. */
export type StardustConfig = Omit<RawConfig, "database" | "server" | "auth"> & {
  auth: Omit<RawConfig["auth"], "local"> & {
    local: Omit<RawConfig["auth"]["local"], "totpKey"> & { totpKey?: string };
  };
  server: Omit<RawConfig["server"], "bootstrapAdmin"> & { bootstrapAdmin?: { username: string; password: string } };
  database: { url: string };
};
