/**
 * SOPS with age, through the sops binary.
 *
 * Plain text only ever travels through a pipe: documents go to sops on stdin
 * and come back on stdout, so no plain-text secret is written to disk. Only
 * `data` and `stringData` are encrypted — the rest of a Kubernetes Secret
 * (names, annotations) stays readable in Git, which is what lets a masked
 * read list keys without decrypting.
 */
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

export const ENCRYPTED_REGEX = "^(data|stringData)$";

export interface SopsOptions {
  /** Path of the sops binary. Defaults to `sops` on PATH. */
  bin?: string;
  /** age identity file used to decrypt. */
  ageKeyFile?: string;
  /** age recipients (public keys) to encrypt for. */
  recipients?: readonly string[];
}

const AGE_RECIPIENT = /^age1[0-9a-z]{58}$/;

function run(opts: SopsOptions, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // sops reads /dev/stdin, which must be a real pipe: on Linux, Node hands a
    // child a socket for stdin and opening /dev/stdin on it fails (ENXIO). `cat |`
    // makes the pipe. The binary and arguments are positional, never spliced in.
    const child = spawn("sh", ["-c", 'cat | "$0" "$@"', opts.bin ?? "sops", ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(opts.ageKeyFile ? { SOPS_AGE_KEY_FILE: opts.ageKeyFile } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c;
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      // stderr may quote parts of the document; report only its first line.
      else reject(new Error(`sops ${args[0]} failed (${code}): ${err.split("\n")[0]}`));
    });
    child.stdin.end(input);
  });
}

export function decrypt(document: string, opts: SopsOptions): Promise<string> {
  return run(opts, ["--decrypt", "--input-type", "yaml", "--output-type", "yaml", "/dev/stdin"], document);
}

export function encrypt(plain: string, opts: SopsOptions): Promise<string> {
  const recipients = opts.recipients ?? [];
  if (recipients.length === 0) return Promise.reject(new Error("encrypting needs at least one age recipient"));
  for (const r of recipients) {
    if (!AGE_RECIPIENT.test(r)) return Promise.reject(new Error(`"${r}" is not an age recipient`));
  }
  return run(
    opts,
    [
      "--encrypt",
      "--age",
      recipients.join(","),
      "--encrypted-regex",
      ENCRYPTED_REGEX,
      "--input-type",
      "yaml",
      "--output-type",
      "yaml",
      "/dev/stdin",
    ],
    plain,
  );
}

/**
 * Encrypts `plain` unless `current` already decrypts to the same document.
 * Encryption is not deterministic (fresh nonces every time), so comparing
 * ciphertexts would report a change on every write; the comparison is on the
 * decrypted content.
 */
export async function encryptIfChanged(
  current: string | null,
  plain: string,
  opts: SopsOptions,
): Promise<{ changed: boolean; document: string }> {
  if (current !== null) {
    const before = parse(await decrypt(current, opts)) as Record<string, unknown>;
    delete before.sops;
    if (isDeepStrictEqual(before, parse(plain))) return { changed: false, document: current };
  }
  return { changed: true, document: await encrypt(plain, opts) };
}
