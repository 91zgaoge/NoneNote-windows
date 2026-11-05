/**
 * Rough prompt-size accounting shared by the wiki compiler (progress warning)
 * and the client (timeout exemption). Same constants as Android's
 * `ai/PromptMetrics.kt` and macOS's `Sources/AI/PromptMetrics.swift`.
 */
export const WARN_TOKENS = 10_000;
export const COLD_TOKENS_PER_SEC = 2_500;
export const BASE_FIRST_BYTE_SECONDS = 180;
export const EXTENDED_FIRST_BYTE_SECONDS = 900;

/** ASCII runs at 4 chars/token, everything else at 1 char/token. */
export function estimate(text: string): number {
  let ascii = 0;
  let other = 0;
  // UTF-16 code units, matching Android's `for (c in text)` (an emoji counts
  // as two "other" units there); iOS/macOS use scalars, this stays Android-first.
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x80) ascii++;
    else other++;
  }
  return Math.floor(ascii / 4) + other;
}

/** System + user + chat-message overhead (4 tokens per message, 8 total). */
export function estimateRequest(system: string, user: string): number {
  return estimate(system) + estimate(user) + 8;
}

export function estimatedColdPrefillSeconds(system: string, user: string): number {
  return estimateRequest(system, user) / COLD_TOKENS_PER_SEC;
}

/** Only a cold prefill slower than the base budget earns the extended timeout. */
export function needsExtendedTimeout(system: string, user: string): boolean {
  return estimatedColdPrefillSeconds(system, user) > BASE_FIRST_BYTE_SECONDS;
}
