import assert from "node:assert/strict";
import { it } from "node:test";
import { combineUserData, plannedRecords, renderCloudInit } from "./naming.ts";

const dns = { provider: "cloudflare", zone: "example.com", internalSuffix: "internal.example.com" };
const addresses = { mainIp: "192.0.2.10", ipv6: "2001:db8::10", internalIp: "10.10.0.10" };

it("gives a host in the zone its public records, an internal name, and a reverse name that resolves back", () => {
  assert.deepEqual(plannedRecords("Web-1.Example.com", addresses, dns), {
    records: [
      { name: "web-1.example.com", type: "A", content: "192.0.2.10" },
      { name: "web-1.example.com", type: "AAAA", content: "2001:db8::10" },
      { name: "web-1.internal.example.com", type: "A", content: "10.10.0.10" },
    ],
    ptr: "web-1.example.com",
  });
});

it("gives a host outside the zone no public record, and so no reverse name", () => {
  const { records, ptr } = plannedRecords("mx.elsewhere.org", addresses, dns);
  assert.deepEqual(records, [{ name: "mx.internal.example.com", type: "A", content: "10.10.0.10" }]);
  assert.equal(ptr, null, "a reverse name that does not resolve back fails mail checks");
});

it("writes nothing without DNS settings or addresses, and fills in only the hostname", () => {
  assert.deepEqual(plannedRecords("web-1.example.com", addresses, undefined), { records: [], ptr: null });
  assert.deepEqual(plannedRecords("web-1.example.com", { mainIp: null, ipv6: null, internalIp: null }, dns), {
    records: [],
    ptr: null,
  });
  assert.equal(renderCloudInit("hostname: {{hostname}}\nkey: {{key}}\n", "web-1"), "hostname: web-1\nkey: {{key}}\n");
});

it("joins several parts of user data as cloud-init multipart, typing each by its first line", () => {
  assert.equal(combineUserData([]), undefined);
  assert.equal(combineUserData(["#cloud-config\n", " "]), "#cloud-config\n");
  const joined = combineUserData(["#cloud-config\nhostname: a\n", "#!/bin/sh\necho hi"], "b") ?? "";
  assert.match(joined, /^Content-Type: multipart\/mixed; boundary="b"\n/);
  assert.match(
    joined,
    /--b\nContent-Type: text\/cloud-config; charset="utf-8"\nMIME-Version: 1.0\n\n#cloud-config\nhostname: a\n/,
  );
  assert.match(
    joined,
    /--b\nContent-Type: text\/x-shellscript; charset="utf-8"\nMIME-Version: 1.0\n\n#!\/bin\/sh\necho hi\n--b--\n$/,
  );
});
