/**
 * Unified document model (anydoc paradigm): every format parser emits these
 * nodes and a single GFM serializer renders them, so escaping/table/heading
 * behaviour is identical across formats. Mirrors Android's
 * extract/DocModel.kt, ExtractError.kt and Limits.kt.
 */

export interface TextInline {
  kind: "text";
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
}

export interface LinkInline {
  kind: "link";
  text: string;
  url: string;
}

export type Inline = TextInline | LinkInline;

export type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "bulletList"; items: Inline[][] }
  | { kind: "orderedList"; items: Inline[][] }
  /** First row is the header. Every row is a list of cells; a cell is inlines. */
  | { kind: "table"; rows: Inline[][][] }
  /**
   * Placeholder for an embedded image; the binary is not extracted.
   * attachmentRef is carried for callers that map images back to attachments;
   * the GFM renderer does not emit it (extraction never produces one).
   */
  | { kind: "image"; alt: string; attachmentRef?: string }
  | { kind: "code"; language: string; text: string };

export interface DocModel {
  blocks: Block[];
}

export function textInline(text: string, bold = false, italic = false, code = false): TextInline {
  return { kind: "text", text, bold, italic, code };
}

/** Android `plain()`: a single unstyled run, or nothing for empty input. */
export function plain(text: string): Inline[] {
  return text.length === 0 ? [] : [textInline(text)];
}

// ---- errors -----------------------------------------------------------------

/** Extraction failure taxonomy (anydoc-style) mapped to UI strings in the app layer. */
export type ExtractErrorKind =
  | "unsupported"
  | "needs_ocr"
  | "encrypted"
  | "malformed"
  | "resource_limit";

export interface ExtractError {
  kind: ExtractErrorKind;
  detail?: string;
}

export type Extraction =
  | { ok: true; markdown: string; format: string }
  | { ok: false; error: ExtractError };

/**
 * Internal control-flow error: parsers throw it to carry a classified failure
 * out to the facade. Anything else thrown becomes "malformed".
 */
export class ExtractFailure extends Error {
  readonly error: ExtractError;

  constructor(error: ExtractError) {
    super(error.detail ? `${error.kind}: ${error.detail}` : error.kind);
    this.name = "ExtractFailure";
    this.error = error;
  }
}

export function resourceLimit(what: string): never {
  throw new ExtractFailure({ kind: "resource_limit", detail: what });
}

/** A document part is missing or unreadable (Android MalformedPartException). */
export function malformedPart(detail: string): never {
  throw new ExtractFailure({ kind: "malformed", detail });
}

// ---- limits -----------------------------------------------------------------

/** Resource caps (anydoc/flyingmouse-style) guarding against hostile files. */
export const Limits = {
  /** Single attachment payload cap — see the attachment store's MAX bytes. */
  MAX_ATTACHMENT_BYTES: 50 * 1024 * 1024,

  /**
   * Total uncompressed bytes accepted from one ZIP container (zip-bomb guard).
   * Mutable so tests can shrink it instead of building 100 MB fixtures
   * (Android: `var MAX_UNZIP_TOTAL`).
   */
  MAX_UNZIP_TOTAL: 100 * 1024 * 1024,

  /** XML events accepted from one document part (billion-laughs guard). */
  MAX_XML_NODES: 200_000,

  /** Extracted text is truncated past this many characters. */
  MAX_TEXT_CHARS: 1_000_000,

  /** Image caps (flyingmouse thresholds): 50 MP / 16384 px per side. */
  MAX_IMAGE_PIXELS: 50_000_000,
  MAX_IMAGE_DIMENSION: 16384,

  imageWithinLimits(width: number, height: number): boolean {
    return (
      width >= 1 && width <= this.MAX_IMAGE_DIMENSION &&
      height >= 1 && height <= this.MAX_IMAGE_DIMENSION &&
      width * height <= this.MAX_IMAGE_PIXELS
    );
  },
};
