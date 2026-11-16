import { MemoryRepo, repoContract } from "../testing.ts";

repoContract("MemoryRepo", async (seed) => {
  const repo = new MemoryRepo(seed);
  return { repo, pushOther: async (changes) => repo.push(changes) };
});
