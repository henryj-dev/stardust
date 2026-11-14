import { computeProviderContract, MemoryCompute } from "../testing.ts";

computeProviderContract("memory", async () => new MemoryCompute());
