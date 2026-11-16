import { dnsProviderContract, MemoryDns } from "../testing.ts";

dnsProviderContract("memory", "example.test", async () => new MemoryDns(["example.test"]));
dnsProviderContract(
  "memory with views",
  "example.test",
  async () => new MemoryDns(["example.test"], ["internal", "external"]),
);
