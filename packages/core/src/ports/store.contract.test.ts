import { MemoryStore, objectStoreContract } from "../testing.ts";

objectStoreContract("memory", async () => new MemoryStore());
