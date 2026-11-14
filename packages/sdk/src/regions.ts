/**
 * One client over several regions' stardust, for a dashboard that shows them
 * together and keeps no state of its own.
 *
 * - What every region shares (accounts, the project list, users) is read from
 *   the home region, or from the next one that answers: each region keeps
 *   copies of it.
 * - What belongs to a project (its runs, env, changes) goes to the region
 *   that owns it, learned from the project itself. A change sent elsewhere is
 *   refused there with the owner's name, and is sent on to it once.
 * - A region that cannot be reached fails what belongs to it, and only that:
 *   nothing is sent somewhere else instead.
 */
import { ApiError } from "./errors.ts";

export interface RegionOptions {
  /** Base URL of each region's API, by region name. */
  readonly urls: Readonly<Record<string, string>>;
  /** The region asked first for what every region shares. */
  readonly home: string;
}

const PROJECT = /^\/api\/v1\/(?:projects|plugins\/[^/]+\/projects)\/([^/?]+)/;
const PROJECT_ITSELF = /^\/api\/v1\/projects\/([^/?]+)(?:\?.*)?$/;

/** A fetch that sends each request to the right region. `base` is what the client prefixes paths with. */
export function regionFetch(doFetch: typeof fetch, base: string, regions: RegionOptions): typeof fetch {
  const urls = Object.fromEntries(Object.entries(regions.urls).map(([k, v]) => [k, v.replace(/\/+$/, "")]));
  if (!urls[regions.home]) throw new Error(`the home region ${regions.home} has no URL`);
  const order = [regions.home, ...Object.keys(urls).filter((r) => r !== regions.home)];
  const owners = new Map<string, string>();

  const send = async (region: string, path: string, init?: RequestInit) => {
    try {
      return await doFetch(`${urls[region]}${path}`, init);
    } catch (err) {
      throw new ApiError(
        503,
        `region ${region} cannot be reached (${(err as Error).message}): only what belongs to it is affected`,
      );
    }
  };
  /** What every region shares: the home region, else the next that answers. */
  const shared = async (path: string, init?: RequestInit) => {
    let last: unknown;
    for (const region of order) {
      try {
        return { region, res: await doFetch(`${urls[region]}${path}`, init) };
      } catch (err) {
        last = err;
      }
    }
    throw new ApiError(503, `no region can be reached (${(last as Error)?.message ?? "no answer"})`);
  };
  const learn = (project: { id?: unknown; metadata?: { region?: unknown } } | undefined) => {
    if (typeof project?.id === "string") {
      const r = project.metadata?.region;
      owners.set(project.id, typeof r === "string" && urls[r] ? r : regions.home);
    }
  };
  const ownerOf = async (id: string, init?: RequestInit) => {
    const known = owners.get(id);
    if (known) return known;
    const { res } = await shared(`/api/v1/projects/${id}`, { headers: init?.headers ?? {} });
    if (res.ok) learn((await res.json()) as { id: string; metadata?: { region?: unknown } });
    return owners.get(id) ?? regions.home;
  };

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const full = String(input);
    const path = full.startsWith(base) ? full.slice(base.length) : new URL(full).pathname + new URL(full).search;
    const method = (init?.method ?? "GET").toUpperCase();

    // The project list: shared, but each project's last run is its owner's.
    if (method === "GET" && /^\/api\/v1\/projects(?:\?.*)?$/.test(path)) {
      const answered = (
        await Promise.all(
          order.map(async (region) =>
            send(region, path, init).then(
              (res) => ({ region, res }),
              () => null,
            ),
          ),
        )
      ).filter((a): a is { region: string; res: Response } => a?.res.ok === true);
      if (answered.length === 0) throw new ApiError(503, "no region can be reached");
      const lists = await Promise.all(
        answered.map(async (a) => ({
          region: a.region,
          projects: ((await a.res.json()) as { projects: Array<Record<string, unknown>> }).projects,
        })),
      );
      const first = lists[0]?.projects ?? [];
      const merged = first.map((p) => {
        const owner =
          typeof (p.metadata as { region?: unknown } | undefined)?.region === "string"
            ? (p.metadata as { region: string }).region
            : regions.home;
        const fromOwner = lists.find((l) => l.region === owner)?.projects.find((q) => q.id === p.id);
        return fromOwner ?? { ...p, lastRun: null, regionUnreachable: owner !== lists[0]?.region };
      });
      return Response.json({ projects: merged });
    }

    const id = PROJECT.exec(path)?.[1];
    if (!id) {
      // Shared reads may come from any region; shared changes go home, which writes the primary.
      return method === "GET" ? (await shared(path, init)).res : send(regions.home, path, init);
    }
    if (method === "GET" && PROJECT_ITSELF.test(path)) {
      const { res } = await shared(path, init);
      if (res.ok) learn((await res.clone().json()) as { id: string; metadata?: { region?: unknown } });
      return res;
    }
    const owner = await ownerOf(decodeURIComponent(id), init);
    const res = await send(owner, path, init);
    if (res.status === 409) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { region?: unknown } | null;
      const named = typeof body?.region === "string" ? body.region : null;
      if (named && named !== owner && urls[named]) {
        owners.set(decodeURIComponent(id), named);
        return send(named, path, init);
      }
    }
    return res;
  }) as typeof fetch;
}

/** `name=https://…,name=https://…` → URLs by region. */
export function parseRegions(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = entry.indexOf("=");
    const name = entry.slice(0, i).trim();
    const url = entry.slice(i + 1).trim();
    if (i <= 0 || !/^[a-z][a-z0-9-]{0,62}$/.test(name) || !/^https?:\/\/\S+$/.test(url)) {
      throw new Error(`not a region: "${entry}" (write name=https://…)`);
    }
    out[name] = url;
  }
  return out;
}
