/**
 * Where to go after signing in: a path on this site, or "/". Browsers treat
 * "\\" like "/" and drop tabs and newlines, so "/\\evil.example" would leave
 * the site; resolving against a placeholder origin and requiring it back
 * catches every such form.
 */
export function safeNext(value: string | null): string {
  if (!value?.startsWith("/") || [...value].some((ch) => ch === "\\" || ch.charCodeAt(0) < 0x20)) return "/";
  const base = "https://stardust.invalid";
  const url = new URL(value, base);
  return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : "/";
}
