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
    change: secret ? { expectedRevision, setSecrets: { [name]: value } } : { expectedRevision, set: { [name]: value } },
  };
}
