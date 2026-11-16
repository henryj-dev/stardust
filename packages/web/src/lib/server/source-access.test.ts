import assert from "node:assert/strict";
import { it } from "node:test";
import { ApiError, type Client } from "@stardust/sdk";
import { checkAccess } from "./source-access.ts";

const client = (answer: (repo: string) => Promise<unknown>) => ({ sourceAccess: answer }) as unknown as Client;

it("asks about the repository as typed, and shows the reason when the check fails", async () => {
  const asked: string[] = [];
  const ok = client(async (repo) => {
    asked.push(repo);
    return { repo, readable: "app", installation: "all" };
  });
  assert.deepEqual(await checkAccess(ok, " acme/web "), { repo: "acme/web", readable: "app", installation: "all" });
  assert.deepEqual(asked, ["acme/web"]);
  assert.equal(await checkAccess(ok, "  "), null, "nothing to ask about");

  const mute = client(async () => {
    throw new ApiError(404, "the source host cannot say who reads a repository");
  });
  assert.equal(await checkAccess(mute, "acme/web"), null, "a host that cannot say is not an error");
  const down = client(async () => {
    throw new ApiError(502, "source host: GitHub answered 503");
  });
  assert.deepEqual(await checkAccess(down, "acme/web"), {
    repo: "acme/web",
    error: "source host: GitHub answered 503",
  });
  const broken = client(async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(checkAccess(broken, "acme/web"), TypeError);
});
