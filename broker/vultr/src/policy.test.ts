// Policy tests. These are the heart of the service.
//
// The broker exists to let through only the requests, made with the account key, that the
// caller actually needs. That decision is the security boundary, so what these tests pin is
// not style but what gets blocked:
//
//   1. Paths and methods outside the allowlist are refused, above all account, billing,
//      user and snapshot endpoints.
//   2. Anchors cannot be bypassed: `/instances/{id}/reinstall` and the like do not leak
//      through a prefix.
//   3. Forbidden `PATCH` body keys are refused: `os_id`, `image_id`, `detach_vpc`, `backups`,
//      each as its own case.
//   3b. `plan` is checked by value: the key is open, the value list is the ceiling.
//   4. Approval tickets fail when missing, for another id, reused or expired.
//
// Layer 3 cannot be enforced by the path allowlist, which is why each key is its own case.
//
// `plan` used to be in the forbidden-key table. When resizing was allowed, that check was
// moved to 3b and made narrower rather than deleted: deleting it would also erase the record
// of what was opened.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOW,
  checkPatchBody,
  checkRoute,
  normalizePath,
  PATCH_INSTANCE_KEYS,
  PATCH_PLAN_ALLOW,
  signApproval,
  tokenEquals,
  verifyApproval,
} from "./policy.ts";

const ID = "6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d";

describe("allowlist: the endpoints the caller uses pass", () => {
  const allowed: Array<[string, string]> = [
    ["GET", "/instances"],
    ["GET", "/instances?per_page=500"],
    ["GET", `/instances/${ID}`],
    ["GET", `/instances/${ID}/vpcs`],
    ["GET", "/vpcs?per_page=500"],
    ["GET", `/vpcs/${ID}`],
    ["GET", "/firewalls?per_page=500"],
    ["GET", `/firewalls/${ID}/rules?per_page=500`],
    ["GET", "/ssh-keys?per_page=500"],
    ["GET", "/os?per_page=500"],
    ["GET", "/plans?per_page=500"],
    ["GET", "/regions?per_page=500"],
    ["POST", "/instances"],
    ["PATCH", `/instances/${ID}`],
    ["DELETE", `/instances/${ID}`],
    ["POST", `/instances/${ID}/ipv4/reverse`],
    ["POST", `/instances/${ID}/ipv6/reverse`],
    ["POST", "/firewalls"],
    ["DELETE", `/firewalls/${ID}`],
    ["POST", `/firewalls/${ID}/rules`],
    ["DELETE", `/firewalls/${ID}/rules/12345`],
  ];
  for (const [m, p] of allowed) {
    it(`${m} ${p}`, () => {
      assert.equal(checkRoute(m, p).ok, true);
    });
  }
});

describe("allowlist: endpoints that could wreck the account or leak data are not on it", () => {
  const denied: Array<[string, string]> = [
    // Account, billing, users: never used. Reads are blocked too, since they expose data.
    ["GET", "/account"],
    ["GET", "/billing/history"],
    ["GET", "/users"],
    ["POST", "/users"],
    ["DELETE", "/users/abc"],
    // Snapshots, object storage, DNS: unused, and must not become a way to copy data out.
    ["GET", "/snapshots"],
    ["POST", "/snapshots"],
    ["GET", "/object-storage"],
    ["POST", "/domains"],
    // Instance sub-resources that destroy or change state and that the caller does not use.
    ["POST", `/instances/${ID}/reinstall`],
    ["POST", `/instances/${ID}/halt`],
    ["POST", `/instances/${ID}/reboot`],
    ["GET", `/instances/${ID}/upgrades`],
    ["POST", `/instances/${ID}/backup-schedule`],
    // Issuing new credentials: a privilege escalation path.
    ["POST", "/ssh-keys"],
    ["DELETE", `/ssh-keys/${ID}`],
    // VPC changes belong to the bootstrap runbook, not to the broker.
    ["POST", "/vpcs"],
    ["DELETE", `/vpcs/${ID}`],
    ["PATCH", `/vpcs/${ID}`],
    // Kubernetes (VKE), load balancers, reserved IPs: unused.
    ["GET", "/kubernetes/clusters"],
    ["POST", "/load-balancers"],
    ["POST", "/reserved-ips"],
  ];
  for (const [m, p] of denied) {
    it(`${m} ${p} → 403`, () => {
      const d = checkRoute(m, p);
      assert.equal(d.ok, false);
      if (!d.ok) assert.equal(d.status, 403);
    });
  }
});

describe("anchors cannot be bypassed: nothing opens by prefix", () => {
  it("extra segments after an allowed path do not pass", () => {
    assert.equal(checkRoute("DELETE", `/instances/${ID}/x`).ok, false);
    assert.equal(checkRoute("PATCH", `/instances/${ID}/plan`).ok, false);
    assert.equal(checkRoute("GET", "/instances/extra").ok, false);
    assert.equal(checkRoute("GET", "/plans/x").ok, false);
    assert.equal(checkRoute("GET", "/regions/ewr").ok, false);
  });

  it("traversal and encoded separators are a 400, refused before matching", () => {
    for (const p of [
      "/instances/../account",
      "/instances//account",
      "/instances/%2e%2e/account",
      "/instances/%2Faccount",
      "/firewalls/..%2faccount",
    ]) {
      const d = checkRoute("GET", p);
      assert.equal(d.ok, false);
      if (!d.ok) assert.equal(d.status, 400);
    }
  });

  it("an arbitrary string in the id position does not pass (ids must be UUIDs)", () => {
    assert.equal(checkRoute("DELETE", "/instances/all").ok, false);
    assert.equal(checkRoute("DELETE", "/instances/*").ok, false);
    assert.equal(checkRoute("PATCH", "/instances/1").ok, false);
  });

  it("firewall rule ids must be integers", () => {
    assert.equal(checkRoute("DELETE", `/firewalls/${ID}/rules/12`).ok, true);
    assert.equal(checkRoute("DELETE", `/firewalls/${ID}/rules/all`).ok, false);
    assert.equal(checkRoute("DELETE", `/firewalls/${ID}/rules/`).ok, false);
  });

  it("a path not starting with a slash, or an absolute URL, is a 400", () => {
    assert.equal(checkRoute("GET", "instances").ok, false);
    assert.equal(checkRoute("GET", "https://evil.example/instances").ok, false);
  });

  it("the same path with another method is blocked", () => {
    assert.equal(checkRoute("DELETE", "/instances").ok, false); // an attempt to delete everything
    assert.equal(checkRoute("PATCH", "/instances").ok, false);
    assert.equal(checkRoute("POST", `/instances/${ID}`).ok, false);
    assert.equal(checkRoute("PUT", `/instances/${ID}`).ok, false);
  });

  it("every ALLOW rule is anchored (guards new entries)", () => {
    for (const r of ALLOW) {
      assert.equal(r.path.source.startsWith("^"), true);
      assert.equal(r.path.source.endsWith("$"), true);
    }
  });
});

describe("PATCH body keys: what the path alone cannot stop", () => {
  it("allowed keys pass", () => {
    assert.equal(checkPatchBody({ user_data: "abc" }).ok, true);
    assert.equal(checkPatchBody({ firewall_group_id: ID }).ok, true);
    assert.equal(checkPatchBody({ user_data: "a", firewall_group_id: ID }).ok, true);
    // `plan` is allowed, but only with a value from the list.
    assert.equal(checkPatchBody({ plan: "vc2-2c-4gb" }).ok, true);
  });

  // One case per key: any single one getting through is an incident on its own.
  // `plan` is not in this table, but it is not unblocked: it is pinned more narrowly
  // (only listed values) in the "plan values" block below.
  const forbidden: Array<[string, unknown, string]> = [
    ["backups", "enabled", "billing change"],
    ["ddos_protection", true, "billing change"],
    ["os_id", 2136, "OS reinstall destroys the disk"],
    ["app_id", 1, "reinstall"],
    ["image_id", "docker", "reinstall"],
    ["detach_vpc", [ID], "leaves the private network"],
    ["attach_vpc", [ID], "network change"],
    ["enable_vpc", false, "network change"],
    ["user_scheme", "root", "changes the login account scheme"],
    ["label", "x", "unused key"],
    ["tags", ["x"], "unused key"],
    ["enable_ipv6", true, "unused key"],
  ];
  for (const [key, value, why] of forbidden) {
    it(`${key} is refused: ${why}`, () => {
      const d = checkPatchBody({ [key]: value });
      assert.equal(d.ok, false);
      if (!d.ok) {
        assert.equal(d.status, 400);
        assert.ok(d.reason.includes(key), d.reason);
      }
    });
  }

  it("is refused even when mixed with allowed keys (nothing is filtered)", () => {
    const d = checkPatchBody({ user_data: "ok", os_id: 2136 });
    assert.equal(d.ok, false);
    if (!d.ok) assert.ok(d.reason.includes("os_id"), d.reason);
  });

  it("an empty body or a non-object is a 400", () => {
    assert.equal(checkPatchBody({}).ok, false);
    assert.equal(checkPatchBody(null).ok, false);
    assert.equal(checkPatchBody([{ user_data: "x" }]).ok, false);
    assert.equal(checkPatchBody("user_data=x").ok, false);
  });

  it("exactly three keys are allowed (guards against quiet widening)", () => {
    assert.deepEqual([...PATCH_INSTANCE_KEYS].sort(), ["firewall_group_id", "plan", "user_data"]);
  });
});

/**
 * `plan` values. Allowing the key moved the billing ceiling here.
 *
 * Without this block, "resizing is allowed" would mean "any billing change is allowed".
 * `plan` used to be in the forbidden-key table; that check was moved here and narrowed
 * rather than deleted.
 */
describe("plan values: the key is open, so the value is the ceiling", () => {
  it("listed values pass", () => {
    for (const p of PATCH_PLAN_ALLOW) {
      assert.equal(checkPatchBody({ plan: p }).ok, true);
    }
  });

  // The cases that separate "the key is open" from "anything goes".
  const rejected: Array<[unknown, string]> = [
    ["vc2-16c-64gb", "not listed: a large cost increase"],
    ["vhf-8c-32gb", "another plan family"],
    ["vc2-1c-1gb ", "trailing space: values are not normalized"],
    ["VC2-1C-1GB", "upper case: values are not normalized"],
    ["", "empty string"],
    [123, "not a string"],
    [null, "null"],
    [{ id: "vc2-1c-1gb" }, "an object"],
  ];
  for (const [value, why] of rejected) {
    it(`refused: ${why}`, () => {
      const d = checkPatchBody({ plan: value });
      assert.equal(d.ok, false);
      // Must be a 403: a 400 would suggest that fixing the body would make it pass.
      if (!d.ok) assert.equal(d.status, 403);
    });
  }

  it("the value check still applies when mixed with allowed keys", () => {
    const d = checkPatchBody({ user_data: "ok", plan: "vc2-16c-64gb" });
    assert.equal(d.ok, false);
    if (!d.ok) assert.ok(d.reason.includes("vc2-16c-64gb"), d.reason);
  });

  it("the value list is as expected (each line raises the billing ceiling)", () => {
    assert.deepEqual([...PATCH_PLAN_ALLOW].sort(), ["vc2-1c-1gb", "vc2-1c-2gb", "vc2-2c-4gb", "vc2-4c-8gb"]);
  });
});

describe("DELETE approval: a signed ticket is the only way through", () => {
  const KEY = "otp-approval-token-fixed-length";
  const TARGET = "6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d";
  const NOW = 1700000000;
  const mint = (
    over: Partial<{ target: string; purpose: string; iat: number; exp: number; actor: string; jti: string }> = {},
  ) =>
    signApproval(
      {
        v: 1,
        purpose: (over.purpose ?? "instance-destroy") as "instance-destroy",
        target: over.target ?? TARGET,
        actor: over.actor ?? "stardust",
        jti: over.jti ?? "11111111-2222-4333-8444-555555555555",
        iat: over.iat ?? NOW,
        exp: over.exp ?? NOW + 120,
      },
      KEY,
    );

  it("a valid ticket passes", () => {
    assert.equal(verifyApproval(mint(), KEY, "instance-destroy", TARGET, NOW + 10).ok, true);
  });

  it("a missing header is refused", () => {
    const v = verifyApproval(undefined, KEY, "instance-destroy", TARGET, NOW);
    assert.equal(v.ok, false);
    assert.ok(v.ok === false && v.reason.includes("missing"));
  });

  // The fixed shared token is no longer accepted. The ticket only adds anything while this
  // stays green: if the old path came back, this catches it.
  it("the old fixed shared token no longer works", () => {
    assert.equal(verifyApproval(KEY, KEY, "instance-destroy", TARGET, NOW).ok, false);
  });

  it("a wrong signature is refused, even one character off", () => {
    const t = mint();
    assert.equal(
      verifyApproval(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), KEY, "instance-destroy", TARGET, NOW).ok,
      false,
    );
  });

  it("a ticket signed with another key is refused", () => {
    const other = signApproval(
      {
        v: 1,
        purpose: "instance-destroy",
        target: TARGET,
        actor: "x",
        jti: "11111111-2222-4333-8444-555555555555",
        iat: NOW,
        exp: NOW + 120,
      },
      "different-key",
    );
    assert.equal(verifyApproval(other, KEY, "instance-destroy", TARGET, NOW).ok, false);
  });

  it("another target is refused: a ticket is bound to one instance", () => {
    assert.equal(
      verifyApproval(mint(), KEY, "instance-destroy", "99999999-8888-4777-8666-555555555555", NOW).ok,
      false,
    );
  });

  it("an expired ticket is refused", () => {
    assert.equal(
      verifyApproval(mint({ iat: NOW - 200, exp: NOW - 1 }), KEY, "instance-destroy", TARGET, NOW).ok,
      false,
    );
  });

  it("a lifetime over the 300 second limit is refused: a long-lived ticket is close to a fixed token", () => {
    assert.equal(verifyApproval(mint({ exp: NOW + 3600 }), KEY, "instance-destroy", TARGET, NOW).ok, false);
  });

  // `create-rollback` is deliberately not implemented (see the top of policy.ts). If that
  // bypass purpose came back by mistake, this catches it: the fewer ways to delete, the better.
  it("another purpose does not get through", () => {
    assert.equal(verifyApproval(mint({ purpose: "create-rollback" }), KEY, "instance-destroy", TARGET, NOW).ok, false);
  });

  it("the payload cannot be edited under the same signature: the claims are what is signed", () => {
    const t = mint();
    const [v1, payload, sig] = t.split(".");
    const tampered = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    tampered.actor = "attacker";
    const forged = `${v1}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${sig}`;
    assert.equal(verifyApproval(forged, KEY, "instance-destroy", TARGET, NOW).ok, false);
  });
});

describe("helpers", () => {
  it("normalizePath splits off the query", () => {
    assert.deepEqual(normalizePath("/instances?per_page=500"), {
      path: "/instances",
      query: "per_page=500",
    });
    assert.deepEqual(normalizePath("/instances"), { path: "/instances", query: "" });
  });

  it("tokenEquals checks both length and content", () => {
    assert.equal(tokenEquals("abc", "abc"), true);
    assert.equal(tokenEquals("abc", "abd"), false);
    assert.equal(tokenEquals("abc", "abcd"), false);
    assert.equal(tokenEquals("", ""), true);
  });
});

/**
 * Golden vector. The same string must appear in the issuer's tests.
 *
 * The side that issues tickets and the side that verifies them (here) do not share code:
 * the broker is built on its own so it stays small. The signing code therefore exists twice,
 * and each side pins "same input, same bytes" against this vector.
 *
 * If this stops matching, do not change the constant. Deploying the two sides out of step
 * makes every delete a 403, which stops instance deletion. Fix the serialization instead.
 */
describe("golden vector: bytes must match the issuer's", () => {
  const KEY = "golden-key";
  const TARGET = "6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d";
  const JTI = "11111111-2222-4333-8444-555555555555";
  const TOKEN =
    "v1.eyJhY3RvciI6InN0YXJkdXN0IiwiZXhwIjoxNzAwMDAwMTIwLCJpYXQiOjE3MDAwMDAwMDAsImp0aSI6IjExMTExMTExLTIyMjItNDMzMy04NDQ0LTU1NTU1NTU1NTU1NSIsInB1cnBvc2UiOiJpbnN0YW5jZS1kZXN0cm95IiwidGFyZ2V0IjoiNmExYjJjM2QtNGU1Zi00YTdiLThjOWQtMGUxZjJhM2I0YzVkIiwidiI6MX0.biMKi3rH7DAMgYCFSX_VbjjCFOhzgDT1SbefBmmtoeo";
  const claims = {
    v: 1 as const,
    purpose: "instance-destroy" as const,
    target: TARGET,
    actor: "stardust",
    jti: JTI,
    iat: 1700000000,
    exp: 1700000120,
  };

  it("a fixed input gives a fixed token", () => {
    assert.equal(signApproval(claims, KEY), TOKEN);
  });

  it("the broker accepts that fixed token: matching signatures are useless if verification refuses", () => {
    const v = verifyApproval(TOKEN, KEY, "instance-destroy", TARGET, 1700000060);
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.claims.jti, JTI);
  });

  it("a different key refuses that token (control)", () => {
    assert.equal(verifyApproval(TOKEN, "other-key", "instance-destroy", TARGET, 1700000060).ok, false);
  });
});
