/**
 * Minimal XML pull parser standing in for Android's XmlPullParser/kxml2 in the
 * OOXML extractors. Namespace processing is off, so element and attribute
 * names arrive prefixed; compare via `local` (the part after ':') exactly like
 * the Android code does.
 */
import { ExtractFailure, malformedPart } from "./types.ts";

export type XmlEventType = "starttag" | "endtag" | "text" | "enddoc";

/** Counts XML events so hostile documents cannot stall the parser. */
export class NodeGuard {
  private n = 0;
  private readonly max: number;

  constructor(max: number = 200_000) {
    this.max = max;
  }

  tick(): void {
    if (++this.n > this.max) {
      throw new ExtractFailure({ kind: "resource_limit", detail: `xml node count > ${this.max}` });
    }
  }
}

interface TagEvent {
  type: "starttag" | "endtag";
  name: string;
  local: string;
  attrs?: Record<string, string>;
}

interface TextEvent {
  type: "text";
  text: string;
}

type Event = TagEvent | TextEvent | { type: "enddoc" };

export class XmlPull {
  private readonly xml: string;
  private pos = 0;
  private started = false;
  private cur: Event = { type: "enddoc" };
  private pendingEnd: TagEvent | null = null;

  constructor(xml: string) {
    this.xml = xml;
  }

  /** Advances and returns the new event type; enddoc is sticky. */
  next(): XmlEventType {
    if (this.started && this.cur.type === "enddoc") return "enddoc";
    this.started = true;
    return this.advance();
  }

  private advance(): XmlEventType {
    if (this.pendingEnd) {
      this.cur = this.pendingEnd;
      this.pendingEnd = null;
      return this.cur.type;
    }
    const xml = this.xml;
    if (this.pos >= xml.length) {
      this.cur = { type: "enddoc" };
      return "enddoc";
    }
    if (xml[this.pos] !== "<") {
      const lt = xml.indexOf("<", this.pos);
      const end = lt < 0 ? xml.length : lt;
      const text = xml.slice(this.pos, end);
      this.pos = lt < 0 ? xml.length : lt;
      this.cur = { type: "text", text };
      return "text";
    }
    // Markup.
    if (xml.startsWith("<?", this.pos)) {
      this.pos = skipThrough(xml, this.pos, "?>");
      return this.advance();
    }
    if (xml.startsWith("<!--", this.pos)) {
      this.pos = skipThrough(xml, this.pos, "-->");
      return this.advance();
    }
    if (xml.startsWith("<![CDATA[", this.pos)) {
      const close = xml.indexOf("]]>", this.pos + 9);
      const stop = close < 0 ? xml.length : close;
      const text = xml.slice(this.pos + 9, stop);
      this.pos = close < 0 ? xml.length : close + 3;
      this.cur = { type: "text", text };
      return "text";
    }
    if (xml.startsWith("<!", this.pos)) {
      this.pos = skipThrough(xml, this.pos, ">");
      return this.advance();
    }
    if (xml.startsWith("</", this.pos)) {
      const gt = xml.indexOf(">", this.pos);
      if (gt < 0) throw malformedPart("unterminated end tag");
      const name = xml.slice(this.pos + 2, gt).trim();
      this.pos = gt + 1;
      this.cur = { type: "endtag", name, local: localName(name) };
      return "endtag";
    }
    // Start tag.
    const gt = scanTagEnd(xml, this.pos);
    if (gt < 0) throw malformedPart("unterminated start tag");
    const inner = xml.slice(this.pos + 1, gt);
    this.pos = gt + 1;
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const name = readName(body);
    const attrs = parseAttrs(body.slice(name.length));
    this.cur = { type: "starttag", name, local: localName(name), attrs };
    if (selfClosing) {
      this.pendingEnd = { type: "endtag", name, local: localName(name) };
    }
    return "starttag";
  }

  get type(): XmlEventType {
    return this.cur.type;
  }

  /** Full tag name of the current start/end event ("w:p"). */
  get name(): string {
    return this.cur.type === "starttag" || this.cur.type === "endtag" ? this.cur.name : "";
  }

  /** Namespace-agnostic local name of the current start/end event ("p"). */
  get local(): string {
    return this.cur.type === "starttag" || this.cur.type === "endtag" ? this.cur.local : "";
  }

  /** Raw text of the current text event. */
  get text(): string {
    return this.cur.type === "text" ? this.cur.text : "";
  }

  /** Attribute by exact prefixed name (Android getAttributeValue(null, name)). */
  attr(name: string): string | null {
    if (this.cur.type !== "starttag" || !this.cur.attrs) return null;
    const v = this.cur.attrs[name];
    return v === undefined ? null : v;
  }

  /** Attribute lookup by local name ("w:val" → "val"; Android attrLocal). */
  attrLocal(local: string): string | null {
    if (this.cur.type !== "starttag" || !this.cur.attrs) return null;
    for (const [k, v] of Object.entries(this.cur.attrs)) {
      if (localName(k) === local) return v;
    }
    return null;
  }

  /**
   * Text content of the current element: requires the current event to be a
   * start tag, consumes through the matching end tag, and leaves the parser
   * positioned on that end tag (XmlPullParser.nextText()).
   */
  nextText(): string {
    if (this.cur.type !== "starttag") throw malformedPart("nextText() outside a start tag");
    const local = this.local;
    let depth = 0;
    const parts: string[] = [];
    for (;;) {
      const ev: XmlEventType = this.advance();
      if (ev === "enddoc") throw malformedPart("document ended inside nextText()");
      if (ev === "starttag") {
        depth++;
      } else if (ev === "endtag") {
        if (depth === 0 && this.local === local) break;
        depth--;
      } else if (ev === "text") {
        parts.push(this.text);
      }
    }
    return decodeEntities(parts.join(""));
  }
}

function skipThrough(xml: string, from: number, marker: string): number {
  const at = xml.indexOf(marker, from);
  return at < 0 ? xml.length : at + marker.length;
}

/** Index of the '>' closing the start tag at `from`, honouring quotes; -1 if none. */
function scanTagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function readName(body: string): string {
  const m = /^[^\s/>]+/.exec(body);
  return m ? m[0] : "";
}

/** Namespace-agnostic local name: "w:p" → "p" (Android XmlPull.local). */
export function localName(name: string): string {
  const at = name.lastIndexOf(":");
  return at < 0 ? name : name.slice(at + 1);
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

// XML defines only the first five; the rest approximate jsoup's HTML table
// for the scraped-page path (numeric entities cover the long tail).
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  deg: "°",
  plusmn: "±",
  middot: "·",
  times: "×",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  agrave: "à",
  aacute: "á",
  egrave: "è",
  eacute: "é",
  ccedil: "ç",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  szlig: "ß",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}
