import assert from "node:assert/strict";
import { it } from "node:test";
import { isRedirect } from "@sveltejs/kit";
import { redirectToProvider } from "./provider-redirect.ts";

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a throw");
};

it("redirects to the provider on another origin", () => {
  const err = thrown(() => redirectToProvider("https://id.example.com/authorize?state=x&client_id=s"));
  assert.ok(isRedirect(err), String(err));
  assert.equal(err.status, 303);
  assert.equal(err.location, "https://id.example.com/authorize?state=x&client_id=s");
});

it("refuses addresses that are not http(s)", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
    const err = thrown(() => redirectToProvider(bad));
    assert.ok(!isRedirect(err), bad);
  }
});

it("refuses something that is not an absolute address", () => {
  assert.ok(!isRedirect(thrown(() => redirectToProvider("/login"))));
});
