/**
 * URL detection in shared/pasted plain text — port of Android's web/Links.kt
 * regex (http/https only, trailing sentence punctuation trimmed).
 */

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Android trimEnd('.', ',', ';', '!', '?', ')', ']', '}') as a suffix regex. */
const TRAILING_PUNCT = /[.,;!?)\]}]+$/;

function trimTrailing(url: string): string {
  return url.replace(TRAILING_PUNCT, "");
}

/**
 * All http(s) URLs in [text], deduped (exact string) with first occurrence
 * order preserved. Windows-port extension of Android's firstUrl, which the
 * link flow uses to offer every candidate in a pasted text.
 */
export function findUrls(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = trimTrailing(match[0]);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** First http(s) URL in [text], or null — Android Links.firstUrl. */
export function firstUrl(text: string): string | null {
  const matches = text.match(URL_RE);
  if (matches === null || matches.length === 0) return null;
  return trimTrailing(matches[0]);
}
