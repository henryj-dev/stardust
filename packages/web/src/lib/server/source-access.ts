import { ApiError, type Client } from "@stardust/sdk";
import type { AccessView } from "$lib/source-access";

/**
 * Asks whether stardust can read a repository. Null when there is nothing to
 * ask about, or when the source host cannot say (the server answers 404);
 * the reason otherwise, so the form shows it instead of failing the page.
 */
export async function checkAccess(client: Client, repo: string): Promise<AccessView | null> {
  const name = repo.trim();
  if (name === "") return null;
  try {
    const { readable, installation } = await client.sourceAccess(name);
    return { repo: name, readable, ...(installation ? { installation } : {}) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    if (err instanceof ApiError) return { repo: name, error: err.message };
    throw err;
  }
}
