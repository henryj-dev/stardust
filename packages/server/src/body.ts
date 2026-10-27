/**
 * Reads a request body with a hard limit. Content-Length is only a claim, so
 * the stream itself is counted; a chunked request cannot get around the limit.
 */
export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

export async function readBoundedBody(
  request: Request,
  limit = MAX_WEBHOOK_BYTES,
): Promise<{ body: string } | { tooLarge: true }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
  if (!request.body) return { body: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel("payload too large");
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes) };
}
