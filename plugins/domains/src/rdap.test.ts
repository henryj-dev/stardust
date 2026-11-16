import assert from "node:assert/strict";
import { it } from "node:test";
import { rdapClient } from "./rdap.ts";

const doc = (extra: Record<string, unknown>) => Response.json({ objectClassName: "domain", ...extra });

function fakeRdap(log: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    log.push(url);
    if (url === "https://data.iana.org/rdap/dns.json") {
      return Response.json({
        services: [
          [["test"], ["https://rdap.registry.test/"]],
          [["dev"], ["http://insecure.test/", "https://rdap.dev.test"]],
        ],
      });
    }
    if (url === "https://rdap.registry.test/domain/example.test") {
      return doc({
        events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }],
        nameservers: [{ ldhName: "NS1.EXAMPLE.TEST" }],
        status: ["active"],
        links: [
          { rel: "related", type: "application/rdap+json", href: "https://rdap.registrar.test/domain/example.test" },
        ],
      });
    }
    if (url === "https://rdap.registrar.test/domain/example.test") {
      return doc({
        events: [{ eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" }],
        entities: [
          {
            roles: ["registrar"],
            vcardArray: [
              "vcard",
              [
                ["version", {}, "text", "4.0"],
                ["fn", {}, "text", "Example Registrar"],
              ],
            ],
          },
        ],
      });
    }
    if (url === "https://rdap.dev.test/domain/site.dev")
      return doc({ events: [{ eventAction: "expiration", eventDate: "2026-12-31T00:00:00Z" }] });
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

it("finds the TLD's server, reads the registry, and fills gaps from the registrar it links to", async () => {
  const rdap = rdapClient(fakeRdap());
  assert.deepEqual(await rdap.lookup("Example.test"), {
    registrar: "Example Registrar",
    expires: "2027-01-01T00:00:00Z",
    registered: "2020-01-01T00:00:00Z",
    nameservers: ["ns1.example.test"],
    status: ["active"],
  });
});

it("prefers an https server, reads the bootstrap once, and says when a name is unknown", async () => {
  const log: string[] = [];
  const rdap = rdapClient(fakeRdap(log));
  assert.equal((await rdap.lookup("site.dev"))?.expires, "2026-12-31T00:00:00Z");
  assert.equal(await rdap.lookup("missing.test"), null);
  assert.equal(log.filter((u) => u.endsWith("dns.json")).length, 1);
  await assert.rejects(rdap.lookup("nope.unknowntld"), /no RDAP server is known/);
  await assert.rejects(rdap.lookup("not a name"), /not a domain name/);
});
