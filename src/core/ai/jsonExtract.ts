/**
 * Lenient JSON extractor for LLM replies: strips a leading ``` fence and
 * crops to the outermost `{…}` / `[…]` span. Validation stays with the caller.
 */
export function extractJson(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const lines = s.split("\n");
    const body =
      lines[lines.length - 1].trim() === "```" ? lines.slice(1, -1) : lines.slice(1);
    s = body.join("\n").trim();
  }
  const start = [...s].findIndex((ch) => ch === "{" || ch === "[");
  if (start < 0) return s;
  const close = s[start] === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  return end >= start ? s.slice(start, end + 1) : s.slice(start);
}
