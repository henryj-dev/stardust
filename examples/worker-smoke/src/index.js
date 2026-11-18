// A smoke test for pipeline W: answers with what the release set up.
// It counts its requests in D1 (so the migration ran) and says whether the
// secret arrived (never its value).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return new Response("not found\n", { status: 404 });
    await env.DB.prepare("INSERT INTO hits (at) VALUES (?)").bind(new Date().toISOString()).run();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM hits").first();
    const body = {
      ok: true,
      hits: row?.n ?? 0,
      secret: typeof env.SMOKE_SECRET === "string" && env.SMOKE_SECRET.length > 0,
      greeting: env.GREETING ?? null,
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  },
};
