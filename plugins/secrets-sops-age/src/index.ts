import { definePlugin } from "@stardust/core";

export type { SopsOptions } from "./sops.ts";
export { decrypt, ENCRYPTED_REGEX, encrypt, encryptIfChanged } from "./sops.ts";

/**
 * `plugins.secrets-sops-age` in stardust.yaml:
 *
 *   secrets-sops-age:
 *     ageKeyFile: /run/secrets/age/keys.txt   # mounted from a Secret
 *     recipients: [age1...]                   # who new secrets are encrypted for
 */
export const plugin = definePlugin({
  manifest: { name: "secrets-sops-age", description: "Encrypts secrets in Git with SOPS and age." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) {
      if (!["ageKeyFile", "recipients", "sopsBinary"].includes(key)) problems.push(`unknown key "${key}"`);
    }
    if (typeof s.ageKeyFile !== "string" || !s.ageKeyFile.startsWith("/")) {
      problems.push("ageKeyFile must be an absolute path to a mounted age identity file");
    }
    if (
      !Array.isArray(s.recipients) ||
      s.recipients.length === 0 ||
      !s.recipients.every((r) => typeof r === "string" && /^age1[0-9a-z]{58}$/.test(r))
    ) {
      problems.push("recipients must be a non-empty list of age public keys");
    }
    if (s.sopsBinary !== undefined && typeof s.sopsBinary !== "string") problems.push("sopsBinary must be a path");
    return problems;
  },
});
