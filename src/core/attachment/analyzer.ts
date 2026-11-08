/**
 * Background AI pass over freshly ingested attachments (P3): documents and
 * web links with an extracted text layer get a "summary + key points" note;
 * images and scanned PDFs get a visual description — but only when the user
 * opted into a vision-capable model in settings. The result is written back
 * to `Attachment.aiSummary`.
 *
 * Port of Android's ai/AttachmentAnalyzer.kt. Follows the WikiCompiler
 * failure convention: when AI is not configured or the LLM call fails,
 * everything stays silent — the attachment is simply left without a summary,
 * and analyzePending() retries the backlog later.
 *
 * Difference from Android: extraction of the text layer happens lazily here
 * (Android does it at share-ingest time), so a non-image row with an empty
 * extractedText gets its payload run through the extract facade first and
 * parseStatus transitions pending → ok / empty / failed exactly like
 * Android's ShareIngest.
 */
import type { LlmClient } from "../ai/client.ts";
import { extractText } from "../extract/textExtractor.ts";
import { PARSE_EMPTY, PARSE_FAILED } from "../types.ts";
import type { Attachment } from "../types.ts";
import type { LocalAttachment } from "./store.ts";

/** Windows types.ts lacks PARSE_OK; the literal mirrors Android's constant. */
const PARSE_OK = "ok";

/** A rasterized image ready for a vision call (OpenAI image_url data-URL form). */
export interface ImageData {
  mime: string;
  dataUrl: string;
}

/**
 * Store surface the analyzer needs. The pendingSummary() rows must mirror the
 * Android DAO query — `aiSummary === ""` and (extractedText !== "" or kind
 * "image" or mime "application/pdf") — extended with `hasPayload` rows so
 * lazily-extracted documents are swept too (Android extracts at ingest, so
 * its query never sees that state).
 */
export interface AnalyzerStore {
  get(id: string): Promise<LocalAttachment | undefined>;
  setExtractedText(id: string, text: string): Promise<void>;
  setParseStatus(id: string, status: string): Promise<void>;
  setAiSummary(id: string, summary: string): Promise<void>;
  pendingSummary(): Promise<LocalAttachment[]>;
}

export interface AttachmentAnalyzerDeps {
  attachments: AnalyzerStore;
  /** Attachment payload bytes; null when the binary is missing locally. */
  loadPayload(id: string): Promise<Uint8Array | null>;
  /**
   * The configured LLM client, or null when AI is not configured (Android's
   * `settings().aiConfigured()` gate) — a null keeps the attachment untouched.
   */
  llm(): LlmClient | null;
  visionEnabled(): boolean;
  /**
   * Supplies a downscaled, base64-ready image for a vision call; the
   * canvas-based implementation is injected by the app layer (Android:
   * VisionImagePrep). Null (the default) means vision is skipped silently.
   */
  visionPrep?: (a: Attachment, bytes: Uint8Array) => Promise<ImageData | null>;
  /** Wall clock, injectable for tests. */
  now?: () => number;
}

export const SUMMARY_SYSTEM =
  "You summarize one attachment of a personal note. Respond with plain text only: " +
  "a two-to-three sentence summary, then a short bullet list of key points. " +
  "Write in the dominant language of the provided content. No preamble.";

export const VISION_PROMPT =
  "Describe this image concisely for a personal notes archive: what it shows, " +
  "plus any readable text transcribed. Answer in the language of the visible " +
  "text, otherwise in English.";

/**
 * Fixed input budget for one summary request, in characters — the same order
 * of magnitude as one wiki extraction segment. Larger extractions are cut
 * with a trailing ellipsis instead of being delivered whole.
 */
export const SUMMARY_INPUT_CHARS = 8_000;

/**
 * Cuts [text] at [maxChars], marking the cut with an ellipsis.
 *
 * This is a fixed CHARACTER budget on purpose — it must never be keyed to
 * max_tokens: max_tokens is an output knob (the settings allow 1,048,576),
 * and keying the input budget to it sent whole PDF extractions out as
 * ~1M-token asks, retried on every launch by analyzePending.
 */
export function capInput(text: string, maxChars: number = SUMMARY_INPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + "…";
}

/**
 * Android syncs web-link attachments with kind "link" (not in the Windows
 * AttachmentKind union); the raw JSON preserves it, so compare as string.
 * Windows records failed fetches with the "Fetch failed:" prefix (see
 * document.ts; Android's constant carries a trailing space, which this
 * shorter prefix also matches).
 */
const LINK_KIND = "link" as string;
const FAILURE_PREFIX = "Fetch failed:";

export class AttachmentAnalyzer {
  private readonly deps: AttachmentAnalyzerDeps;

  constructor(deps: AttachmentAnalyzerDeps) {
    this.deps = deps;
  }

  /**
   * Analyzes one attachment, writing the summary back on success. Returns
   * false (silently) when skipped: unknown id, already summarized, AI not
   * configured, vision gated off, or the LLM/IO call failed.
   */
  async analyze(id: string): Promise<boolean> {
    const a = await this.deps.attachments.get(id);
    if (!a) return false;
    if (a.aiSummary.trim().length > 0) return false;
    const llm = this.deps.llm();
    if (!llm) return false;
    let summary = "";
    try {
      summary = ((await this.produce(a, llm)) ?? "").trim();
    } catch {
      return false; // silent failures: the row stays unsummarized, retry later
    }
    if (summary.length === 0) return false;
    await this.deps.attachments.setAiSummary(id, summary);
    return true;
  }

  /** Retries every analyzable attachment still missing a summary. */
  async analyzePending(): Promise<void> {
    for (const a of await this.deps.attachments.pendingSummary()) {
      await this.analyze(a.id);
    }
  }

  private async produce(a0: LocalAttachment, llm: LlmClient): Promise<string | null> {
    let a: Attachment = a0;
    // Fill the text layer first: non-image rows with an empty extraction get
    // their payload run through the extract facade (Android does this during
    // share ingest; Windows does it lazily so synced rows are covered too).
    if (a.kind !== "image" && a.extractedText.trim().length === 0) {
      const bytes = await this.deps.loadPayload(a.id);
      if (bytes) {
        const r = await extractText(a.fileName, a.mime, bytes);
        if (r.ok) {
          await this.deps.attachments.setExtractedText(a.id, r.markdown);
          await this.deps.attachments.setParseStatus(
            a.id,
            r.markdown.trim().length === 0 ? PARSE_EMPTY : PARSE_OK,
          );
          a = { ...a, extractedText: r.markdown };
        } else {
          await this.deps.attachments.setParseStatus(a.id, PARSE_FAILED);
        }
      }
    }
    // A failed web fetch records only the error detail — not worth a call.
    if (a.kind === LINK_KIND && a.extractedText.startsWith(FAILURE_PREFIX)) return null;
    // Documents and web links with a text layer: summarize the extraction,
    // capped to a fixed char budget.
    if (a.kind !== "image" && a.extractedText.trim().length > 0) {
      return llm.chat(SUMMARY_SYSTEM, summaryUser(a, capInput(a.extractedText)));
    }
    // Images and scanned (needs_ocr) PDFs: only when vision is enabled.
    if (this.deps.visionEnabled() && (a.kind === "image" || a.mime === "application/pdf")) {
      const prep = this.deps.visionPrep;
      if (!prep || !llm.describeImage) return null;
      const bytes = await this.deps.loadPayload(a.id);
      if (!bytes) return null;
      const image = await prep(a, bytes);
      if (!image) return null;
      return llm.describeImage(VISION_PROMPT, image);
    }
    return null;
  }
}

function summaryUser(a: Attachment, text: string): string {
  return `FILE ${a.fileName} (${a.mime})\n---\n${text}`;
}
