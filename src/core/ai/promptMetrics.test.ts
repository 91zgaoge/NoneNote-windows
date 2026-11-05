import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_FIRST_BYTE_SECONDS,
  EXTENDED_FIRST_BYTE_SECONDS,
  WARN_TOKENS,
  estimate,
  estimateRequest,
  estimatedColdPrefillSeconds,
  needsExtendedTimeout,
} from "./promptMetrics.ts";

test("estimate counts ASCII at 4 chars/token and CJK at 1", () => {
  assert.equal(estimate("abcd"), 1);
  assert.equal(estimate("abcde"), 1);
  assert.equal(estimate("你好世界"), 4);
  assert.equal(estimate("a你b好"), 2);
  assert.equal(estimate("🎉"), 2); // UTF-16 surrogate pair, same as Android
});

test("request estimate adds 8 tokens of message overhead", () => {
  assert.equal(estimateRequest("abcd", "abcd"), 10);
});

test("timeout exemption is time-based, not a token threshold", () => {
  assert.equal(WARN_TOKENS, 10_000);
  assert.equal(BASE_FIRST_BYTE_SECONDS, 180);
  assert.equal(EXTENDED_FIRST_BYTE_SECONDS, 900);
  // 12k cached tokens: under 180s of cold prefill, so no exemption.
  const user12k = "x".repeat(48_000);
  assert.ok(estimatedColdPrefillSeconds("", user12k) < 180);
  assert.equal(needsExtendedTimeout("", user12k), false);
  // 500k tokens: > 180s cold prefill, so the 900s budget applies.
  const user500k = "x".repeat(2_000_000);
  assert.ok(estimatedColdPrefillSeconds("", user500k) > 180);
  assert.equal(needsExtendedTimeout("", user500k), true);
});
