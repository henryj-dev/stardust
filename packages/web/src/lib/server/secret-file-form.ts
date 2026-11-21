/**
 * What a Secret files form asks for: add a key (generated or uploaded),
 * replace one, or delete one. An uploaded file is sent as base64 and never
 * kept or echoed by the page; the server checks everything again.
 */

export type SecretFileRequest =
  | {
      op: "add" | "replace";
      set: string;
      key: string;
      body: { generate: { bytes: number; encoding: string } } | { value: string };
    }
  | { op: "delete"; set: string; key: string };

export class SecretFileFormError extends Error {}

/** The largest upload the server takes. */
export const MAX_UPLOAD_BYTES = 256 * 1024;

export async function readSecretFileForm(form: FormData): Promise<SecretFileRequest> {
  const op = String(form.get("op") ?? "");
  const set = String(form.get("set") ?? "").trim();
  const key = String(form.get("key") ?? "").trim();
  if (!set || !key) throw new SecretFileFormError("Name the set and the key.");
  if (op === "delete") {
    if (form.get("confirm") !== "on")
      throw new SecretFileFormError("Tick the confirmation: the value is gone for good.");
    return { op, set, key };
  }
  if (op !== "add" && op !== "replace") throw new SecretFileFormError("Unknown action.");
  if (op === "replace" && form.get("confirm") !== "on") {
    throw new SecretFileFormError("Tick the confirmation: the old value is gone for good.");
  }
  if (form.get("source") === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new SecretFileFormError("Choose a file to upload.");
    if (file.size > MAX_UPLOAD_BYTES)
      throw new SecretFileFormError(`The file is larger than ${MAX_UPLOAD_BYTES} bytes.`);
    return { op, set, key, body: { value: Buffer.from(await file.arrayBuffer()).toString("base64") } };
  }
  const bytes = Number(form.get("bytes") ?? 32);
  if (!Number.isInteger(bytes)) throw new SecretFileFormError("The number of bytes must be a whole number.");
  return { op, set, key, body: { generate: { bytes, encoding: String(form.get("encoding") ?? "raw") } } };
}
