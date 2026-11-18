/**
 * A stand-in for SOPS in tests: like SOPS it leaves keys readable and
 * encrypts values (here as base64, so a test can still find a plain value
 * where it must not be), and every encryption differs (a fresh nonce), so a
 * test can tell a needless re-encryption from no change.
 */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import type { EnvCodec } from "./env.ts";

type Doc = { stringData?: Record<string, string>; sops?: unknown } & Record<string, unknown>;

export function fakeCodec(): EnvCodec & { encryptions: number } {
  const codec = {
    encryptions: 0,
    async decrypt(document: string): Promise<string> {
      // Like SOPS, a file of several documents decrypts whole.
      const docs = document.split(/^---\s*$/m).filter((d) => d.trim() !== "");
      if (docs.length > 1) return (await Promise.all(docs.map((d): Promise<string> => codec.decrypt(d)))).join("---\n");
      const doc = parse(document) as Doc;
      if (!doc.sops) throw new Error("not a SOPS document");
      const { sops: _nonce, ...rest } = doc;
      const data = Object.fromEntries(
        Object.entries(rest.stringData ?? {}).map(([k, v]) => [
          k,
          Buffer.from(String(v).replace(/^ENC\[|\]$/g, ""), "base64").toString(),
        ]),
      );
      return stringify({ ...rest, stringData: data });
    },
    async encryptIfChanged(current: string | null, plain: string): Promise<{ changed: boolean; document: string }> {
      if (current !== null && isDeepStrictEqual(parse(await codec.decrypt(current)), parse(plain)))
        return { changed: false, document: current };
      codec.encryptions++;
      const docs = plain.split(/^---\s*$/m).filter((d) => d.trim() !== "");
      if (docs.length > 1) {
        const one = async (d: string): Promise<string> => (await codec.encryptIfChanged(null, d)).document;
        codec.encryptions -= docs.length;
        return { changed: true, document: (await Promise.all(docs.map(one))).join("---\n") };
      }
      const doc = parse(plain) as Doc;
      const data = Object.fromEntries(
        Object.entries(doc.stringData ?? {}).map(([k, v]) => [k, `ENC[${Buffer.from(v).toString("base64")}]`]),
      );
      return {
        changed: true,
        document: stringify({ ...doc, stringData: data, sops: { nonce: randomBytes(4).toString("hex") } }),
      };
    },
  };
  return codec;
}
