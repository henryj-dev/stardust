/**
 * Calls to the Vultr API, through the broker when there is one.
 *
 * A Vultr API key opens the whole account, and Vultr has no narrower keys.
 * So the key can live in a broker (broker/vultr) that only lets through the
 * calls stardust makes; stardust then holds a token for the broker only.
 *
 * Falling back to the key directly is allowed only when the broker cannot be
 * reached at all (refused, unresolved, timed out), and only when a key was
 * configured for that. Any HTTP answer from the broker is final: a 403 is
 * the allowlist saying no, and retrying it with the key would run exactly
 * what the broker refused; a 401 is a misconfiguration a fallback would hide;
 * a 502 is Vultr failing, which a second try would not fix.
 */

const VULTR_API = "https://api.vultr.com/v2";

/** An HTTP answer came back. Never a reason to fall back. */
export class VultrHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(path: string, status: number, body: string) {
    super(`Vultr ${path} answered ${status}: ${body.slice(0, 300)}`);
    this.name = "VultrHttpError";
    this.status = status;
    this.body = body;
  }
}

export type FallbackDecision =
  | { fallback: true; reason: string }
  | { fallback: false; rethrow: true }
  | { fallback: false; rethrow: false; reason: string };

/**
 * What to do when a call through the broker failed: retry directly (only a
 * transport failure, only with a key), rethrow (any HTTP answer), or fail
 * saying a fallback was needed but no key was configured.
 */
export function decideFallback(err: unknown, hasDirectKey: boolean): FallbackDecision {
  if (err instanceof VultrHttpError) return { fallback: false, rethrow: true };
  const message = err instanceof Error ? err.message : String(err);
  if (!hasDirectKey)
    return {
      fallback: false,
      rethrow: false,
      reason: `the broker cannot be reached and no direct key is configured: ${message}`,
    };
  return { fallback: true, reason: message };
}

export interface VultrClientOptions {
  /** The broker's base URL and its token. */
  broker?: { url: string; token: string };
  /** The account key, for calling Vultr directly (no broker, or the broker unreachable). */
  apiKey?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Told about every fallback: each one bypassed the broker's allowlist. */
  onFallback?: (call: string, reason: string) => void;
}

export interface VultrRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export function vultrClient(options: VultrClientOptions) {
  if (!options.broker && !options.apiKey) throw new Error("cloud-vultr needs a broker or an API key");
  const fetchFn = options.fetch ?? fetch;
  const once = async <T>(base: string, token: string, req: VultrRequest): Promise<T> => {
    const res = await fetchFn(`${base.replace(/\/+$/, "")}${req.path}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        ...req.headers,
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new VultrHttpError(req.path, res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  };
  return {
    async request<T>(req: VultrRequest): Promise<T> {
      const direct = options.apiKey;
      if (!options.broker) return once<T>(options.apiBaseUrl ?? VULTR_API, direct ?? "", req);
      try {
        return await once<T>(options.broker.url, options.broker.token, req);
      } catch (err) {
        const d = decideFallback(err, Boolean(direct));
        if (!d.fallback) {
          if (d.rethrow) throw err;
          throw new Error(`Vultr ${req.path}: ${d.reason}`);
        }
        options.onFallback?.(`${req.method} ${req.path}`, d.reason);
        return once<T>(options.apiBaseUrl ?? VULTR_API, direct ?? "", req);
      }
    },
  };
}

export type VultrClient = ReturnType<typeof vultrClient>;
