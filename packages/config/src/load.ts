import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { configSchema, type RawConfig, type StardustConfig, secretRef } from "./schema.ts";

export interface ConfigIssue {
  /** Dotted path into stardust.yaml, e.g. `server.port`. Empty for the document root. */
  readonly path: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(source: string, issues: readonly ConfigIssue[]) {
    const lines = issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`);
    super(`invalid configuration in ${source}:\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface LoadConfigOptions {
  /** Environment used to resolve `{ env: NAME }` references. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Reads `{ file: PATH }` references. Defaults to reading from disk. */
  readonly readSecretFile?: (path: string) => Promise<string>;
}

/** Parses and validates YAML text. `source` is only used in error messages. */
export async function parseConfig(
  text: string,
  source: string,
  options: LoadConfigOptions = {},
): Promise<StardustConfig> {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (err) {
    throw new ConfigError(source, [{ path: "", message: `not valid YAML: ${(err as Error).message}` }]);
  }

  const parsed = configSchema.safeParse(document ?? {});
  if (!parsed.success) {
    throw new ConfigError(source, parsed.error.issues.map(toIssue));
  }

  const raw: RawConfig = parsed.data;
  const env = options.env ?? process.env;
  const readSecretFile = options.readSecretFile ?? ((path) => readFile(path, "utf8"));

  const issues: ConfigIssue[] = [];
  const databaseUrl = await resolveSecret(raw.database.url, "database.url", env, readSecretFile, issues);
  if (issues.length > 0 || databaseUrl === undefined) {
    throw new ConfigError(source, issues);
  }

  return { ...raw, database: { url: databaseUrl } };
}

/** Reads and validates a stardust.yaml file. */
export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<StardustConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(path, [{ path: "", message: `cannot read file: ${(err as Error).message}` }]);
  }
  return parseConfig(text, path, options);
}

async function resolveSecret(
  ref: z.infer<typeof secretRef>,
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  readSecretFile: (path: string) => Promise<string>,
  issues: ConfigIssue[],
): Promise<string | undefined> {
  if ("env" in ref) {
    const value = env[ref.env];
    if (value === undefined || value === "") {
      issues.push({ path, message: `environment variable ${ref.env} is not set` });
      return undefined;
    }
    return value;
  }
  try {
    const value = (await readSecretFile(ref.file)).trim();
    if (value === "") {
      issues.push({ path, message: `secret file ${ref.file} is empty` });
      return undefined;
    }
    return value;
  } catch (err) {
    issues.push({ path, message: `cannot read secret file ${ref.file}: ${(err as Error).message}` });
    return undefined;
  }
}

function toIssue(issue: z.core.$ZodIssue): ConfigIssue {
  return { path: issue.path.map(String).join("."), message: issue.message };
}

/**
 * Resolves one `{ env: NAME }` / `{ file: PATH }` reference from a plugin
 * section. `path` is the dotted config path used in the error message.
 * Throws ConfigError when the reference is malformed or cannot be resolved.
 */
export async function resolveSecretRef(ref: unknown, path: string, options: LoadConfigOptions = {}): Promise<string> {
  const parsed = secretRef.safeParse(ref);
  if (!parsed.success) {
    throw new ConfigError("configuration", [{ path, message: "must be { env: NAME } or { file: PATH }" }]);
  }
  const issues: ConfigIssue[] = [];
  const value = await resolveSecret(
    parsed.data,
    path,
    options.env ?? process.env,
    options.readSecretFile ?? ((p) => readFile(p, "utf8")),
    issues,
  );
  if (value === undefined) throw new ConfigError("configuration", issues);
  return value;
}
