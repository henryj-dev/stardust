/**
 * HTTP client for the stardust API.
 *
 * This hand-written client is a placeholder: it will be generated from the
 * server's OpenAPI document, and CI will fail when the two drift apart.
 */

export interface ClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export interface Client {
  health(): Promise<{ status: string; version: string }>;
}

export function createClient(options: ClientOptions): Client {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  return {
    async health() {
      const res = await doFetch(`${base}/healthz`);
      if (!res.ok) {
        throw new Error(`GET /healthz failed: ${res.status}`);
      }
      return (await res.json()) as { status: string; version: string };
    },
  };
}
