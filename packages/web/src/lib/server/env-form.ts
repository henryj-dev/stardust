import type { EnvChangeInput } from "@stardust/sdk";

/**
 * One env change from a form: set or remove one name in one layer, as a
 * plain value or a secret. The server checks names and sizes again; this only
 * shapes the request. A secret value is passed through and never returned.
 */
export function envFormChange(
  form: FormData,
  op: "set" | "unset",
): { layer: string; name: string; change: EnvChangeInput } | { error: string; layer: string; name: string } {
  const layer = String(form.get("layer") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const expectedRevision = String(form.get("revision") ?? "");
  const secret = form.get("kind") === "secret";
  if (!layer || !expectedRevision) return { error: "The form is missing its layer; reload the page.", layer, name };
  if (!name) return { error: "Enter a name.", layer, name };
  if (op === "unset") {
    return {
      layer,
      name,
      change: secret ? { expectedRevision, unsetSecrets: [name] } : { expectedRevision, unset: [name] },
    };
  }
  const value = String(form.get("value") ?? "");
  if (secret && value === "") return { error: "Enter the secret's value.", layer, name };
  return {
    layer,
    name,
    change: secret
      ? { expectedRevision, setSecrets: { [name]: value } }
      : {
          expectedRevision,
          set: { [name]: value },
          // The person said this value is public, though its name looks like a secret's.
          ...(form.get("public") === "on" ? { plainOnPurpose: [name] } : {}),
        },
  };
}

/** The most a value may be, as the server allows. */
export const MAX_FILE_VALUE = 32 * 1024;

/**
 * A value given as a file (a key, a JSON credential, a config file): its text
 * becomes the form's value, exactly as it is, newlines included. Only UTF-8
 * text is taken, since values are stored as text, and only one of a typed
 * value and a file. Without a file the form is left as it is.
 */
export async function valueFromFile(form: FormData): Promise<{ error: string } | null> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  if (String(form.get("value") ?? "") !== "") return { error: "Give a value or a file, not both." };
  if (file.size > MAX_FILE_VALUE) return { error: `${file.name || "The file"} is larger than 32 KiB.` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return { error: `${file.name || "The file"} is not UTF-8 text.` };
  }
  if (text.includes("\u0000")) return { error: `${file.name || "The file"} is not UTF-8 text.` };
  form.set("value", text);
  form.delete("file");
  return null;
}
