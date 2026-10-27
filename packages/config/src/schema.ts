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
  /** Each key enables one plugin; the value is validated by that plugin. */
  plugins: z.record(z.string(), z.unknown()).default({}),
});

export type RawConfig = z.infer<typeof configSchema>;

/** Configuration after secret references have been resolved to their values. */
export type StardustConfig = Omit<RawConfig, "database" | "server"> & {
  server: Omit<RawConfig["server"], "bootstrapAdmin"> & { bootstrapAdmin?: { username: string; password: string } };
  database: { url: string };
};
