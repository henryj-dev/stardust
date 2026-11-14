import assert from "node:assert/strict";
import { it } from "node:test";
import { ApiError, type Client } from "@stardust/sdk";
import { needsReauth, reauthFrom } from "./reauth.ts";

const form = (proof: string) => {
  const f = new FormData();
  f.set("proof", proof);
  return f;
};

it("sends a code as a code and anything else as the password", async () => {
  const sent: unknown[] = [];
  const client = { reauth: async (p: unknown) => void sent.push(p) } as unknown as Client;
  assert.equal(await reauthFrom(client, form("123456")), null);
  assert.equal(await reauthFrom(client, form("abcde-fghij")), null);
  assert.equal(await reauthFrom(client, form("my long password")), null);
  assert.deepEqual(sent, [{ code: "123456" }, { code: "abcde-fghij" }, { password: "my long password" }]);
  assert.match((await reauthFrom(client, form(""))) ?? "", /Enter your password/);
});

it("explains a refusal, and tells a single sign-on session to sign in again", async () => {
  const refuse = (status: number, message: string) =>
    ({ reauth: async () => Promise.reject(new ApiError(status, message)) }) as unknown as Client;
  assert.equal(await reauthFrom(refuse(403, "that password is not right"), form("x")), "that password is not right");
  assert.match((await reauthFrom(refuse(409, "sso"), form("x"))) ?? "", /single sign-on/);
  assert.equal(needsReauth(new ApiError(401, "confirm it is you first")), true);
  assert.equal(needsReauth(new ApiError(401, "unauthorized")), false);
});
