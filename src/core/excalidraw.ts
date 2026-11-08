/**
 * Excalidraw diagram support — TS port of macOS Sources/AI/Excalidraw.swift
 * (itself a Foundation port of Android's core/excalidraw/
 * ExcalidrawValidate.kt + ExcalidrawProjection.kt) for the Agent
 * {"action":"diagram"} protocol: rectangle/ellipse/diamond/text/arrow with
 * startBinding/endBinding and containerId text bindings.
 *
 * Where the Swift/Android validators are lenient (silently dropping unusable
 * elements, defaulting geometry), the Windows port validates strictly per the
 * port spec: unknown/missing types, bad geometry, dangling arrow bindings and
 * oversized scenes are rejected with a reason instead of being skipped.
 * Normalization still fills the same defaults (width 100 / height 50 /
 * strokeColor #1e1e1e / fontSize 20 / endArrowhead "arrow" / roundness
 * {type: 3} ...), so the persisted elements stay wire-compatible.
 */

export type ExcalidrawElementType =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "text"
  | "arrow";

export const EXCALIDRAW_TYPES: readonly ExcalidrawElementType[] = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
];

/**
 * Scene bounds guarding against runaway Agent output. No Android/macOS
 * equivalents (they cap nothing) — Windows port spec requires bound limits.
 */
export const MAX_ELEMENTS = 500;
export const MAX_COORD = 1_000_000;
export const MAX_DIM = 100_000;
export const MAX_TEXT_CHARS = 5_000;
export const MAX_POINTS = 1_000;

export interface ArrowBinding {
  elementId: string;
  focus?: number;
  gap?: number;
  [key: string]: unknown;
}

/** A normalized element — every Swift/Android default filled in. */
export interface ValidElement {
  id: string;
  type: ExcalidrawElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  groupIds: unknown[];
  boundElements: unknown;
  updated: number;
  link: null;
  locked: boolean;
  /** rectangle/diamond only. */
  roundness?: { type: number };
  /** text only. */
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  originalText?: string;
  lineHeight?: number;
  /** arrow only; offsets relative to (x, y). */
  points?: number[][];
  startBinding?: ArrowBinding | null;
  endBinding?: ArrowBinding | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
}

export type ValidateResult =
  | { ok: true; elements: ValidElement[] }
  | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Default id for elements without one — Android uses "el-${type.hashCode()}"
 * (JVM String.hashCode); reproduced here so default ids are deterministic and
 * identical across ports.
 */
function javaStringHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Validates and normalizes an elements array (Agent diagram action payload).
 * Rejection reasons name the offending element index or id.
 */
export function validateExcalidraw(elements: unknown[]): ValidateResult {
  if (!Array.isArray(elements)) return { ok: false, reason: "elements must be an array" };
  if (elements.length === 0) return { ok: false, reason: "no elements" };
  if (elements.length > MAX_ELEMENTS) {
    return { ok: false, reason: `too many elements (> ${MAX_ELEMENTS})` };
  }

  const kept: ValidElement[] = [];
  for (let i = 0; i < elements.length; i++) {
    const raw = elements[i];
    if (!isPlainObject(raw)) return { ok: false, reason: `element ${i}: not an object` };
    const o = raw;
    // Swift/Android: deleted elements are dropped, not an error.
    if (o.isDeleted === true || o.isDeleted === "true") continue;

    let reason: string | null = null;
    const type = o.type;
    if (typeof type !== "string" || type === "") {
      return { ok: false, reason: `element ${i}: missing type` };
    }
    if (!EXCALIDRAW_TYPES.includes(type as ExcalidrawElementType)) {
      return { ok: false, reason: `element ${i}: unknown type ${type}` };
    }

    const numOr = (key: string, fallback: number): number => {
      const v = o[key];
      if (v === undefined) return fallback;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        reason ??= `element ${i}: ${key} must be a finite number`;
        return fallback;
      }
      return v;
    };
    const strOr = (key: string, fallback: string): string => {
      const v = o[key];
      return typeof v === "string" ? v : fallback;
    };

    const x = numOr("x", 0);
    const y = numOr("y", 0);
    const width = numOr("width", 100);
    const height = numOr("height", 50);
    const angle = numOr("angle", 0);
    const strokeWidth = numOr("strokeWidth", 2);
    const roughness = numOr("roughness", 1);
    const opacity = numOr("opacity", 100);
    const seed = numOr("seed", 1);
    const version = numOr("version", 1);
    const versionNonce = numOr("versionNonce", 1);
    const updated = numOr("updated", 1);

    const id =
      typeof o.id === "string"
        ? o.id
        : typeof o.id === "number"
          ? String(o.id) // Android jsonPrimitive coerces numeric ids to strings
          : `el-${javaStringHashCode(type)}`;

    if (reason === null && (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD)) {
      reason = `element ${i}: coordinates out of bounds`;
    }
    if (
      reason === null &&
      (width < 0 || height < 0 || width > MAX_DIM || height > MAX_DIM)
    ) {
      reason = `element ${i}: size out of bounds`;
    }

    const el: ValidElement = {
      id,
      type: type as ExcalidrawElementType,
      x,
      y,
      width,
      height,
      angle,
      strokeColor: strOr("strokeColor", "#1e1e1e"),
      backgroundColor: strOr("backgroundColor", "transparent"),
      fillStyle: strOr("fillStyle", "solid"),
      strokeWidth,
      strokeStyle: strOr("strokeStyle", "solid"),
      roughness,
      opacity,
      seed,
      version,
      versionNonce,
      isDeleted: false,
      groupIds: Array.isArray(o.groupIds) ? o.groupIds : [],
      boundElements: o.boundElements !== undefined ? o.boundElements : null,
      updated,
      link: null,
      locked: false,
    };

    if (type === "text") {
      const text = typeof o.text === "string" ? o.text : "";
      if (text.length > MAX_TEXT_CHARS) {
        reason ??= `element ${i}: text too long (> ${MAX_TEXT_CHARS} chars)`;
      }
      el.text = text;
      el.fontSize = numOr("fontSize", 20);
      el.fontFamily = numOr("fontFamily", 1);
      el.textAlign = strOr("textAlign", "center");
      el.verticalAlign = strOr("verticalAlign", "middle");
      el.containerId = typeof o.containerId === "string" ? o.containerId : null;
      el.originalText = typeof o.originalText === "string" ? o.originalText : text;
      el.lineHeight = numOr("lineHeight", 1.25);
    }

    if (type === "arrow") {
      let points: number[][] = [[0, 0], [100, 0]];
      if (o.points !== undefined) {
        const pts = o.points;
        const isPoint = (p: unknown): p is number[] =>
          Array.isArray(p) &&
          p.length >= 2 &&
          typeof p[0] === "number" &&
          Number.isFinite(p[0]) &&
          typeof p[1] === "number" &&
          Number.isFinite(p[1]);
        if (!Array.isArray(pts)) {
          reason ??= `element ${i}: points must be [x, y] pairs`;
        } else if (pts.length > MAX_POINTS) {
          reason ??= `element ${i}: too many points (> ${MAX_POINTS})`;
        } else if (!pts.every(isPoint)) {
          reason ??= `element ${i}: points must be [x, y] pairs`;
        } else {
          points = pts.map((p) => [p[0], p[1]]);
        }
      }
      const binding = (side: "startBinding" | "endBinding"): ArrowBinding | null => {
        const v = o[side];
        if (v === undefined || v === null) return null;
        if (!isPlainObject(v) || typeof v.elementId !== "string") {
          reason ??= `element ${i}: ${side} must reference an element`;
          return null;
        }
        return { ...(v as Record<string, unknown>), elementId: v.elementId } as ArrowBinding;
      };
      el.points = points;
      el.startBinding = binding("startBinding");
      el.endBinding = binding("endBinding");
      el.startArrowhead = typeof o.startArrowhead === "string" ? o.startArrowhead : null;
      el.endArrowhead = typeof o.endArrowhead === "string" ? o.endArrowhead : "arrow";
    }

    if (type === "rectangle" || type === "diamond") {
      el.roundness = isPlainObject(o.roundness) ? (o.roundness as { type: number }) : { type: 3 };
    }

    if (reason !== null) return { ok: false, reason };
    kept.push(el);
  }

  // Arrow bindings must reference elements that exist in the scene.
  const ids = new Set(kept.map((e) => e.id));
  for (const el of kept) {
    if (el.type !== "arrow") continue;
    for (const side of ["startBinding", "endBinding"] as const) {
      const binding = el[side];
      if (binding !== null && binding !== undefined && !ids.has(binding.elementId)) {
        return {
          ok: false,
          reason: `arrow ${el.id}: ${side} references unknown element ${binding.elementId}`,
        };
      }
    }
  }

  return { ok: true, elements: kept };
}

/**
 * Parses a raw JSON payload — an elements array or a full .excalidraw file
 * object — then validates it (Swift ExcalidrawValidate.parse shape).
 */
export function parseExcalidrawJson(raw: string): ValidateResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty input" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (Array.isArray(parsed)) return validateExcalidraw(parsed);
  if (isPlainObject(parsed)) {
    const elements = parsed.elements;
    if (!Array.isArray(elements)) return { ok: false, reason: "no elements in file" };
    return validateExcalidraw(elements);
  }
  return { ok: false, reason: "invalid excalidraw document" };
}

/**
 * Turns Excalidraw elements into compact reading-order / graph text for wiki
 * and embeddings — coordinates are summarized, not dumped
 * (ExcalidrawProjection.project).
 */
export function projectExcalidraw(elements: ValidElement[]): string {
  const byId = new Map<string, ValidElement>();
  for (const el of elements) byId.set(el.id, el);
  let out = "DIAGRAM\n";
  for (const el of elements) {
    const type: string = el.type;
    switch (type) {
      case "text": {
        const text = (el.text ?? "").replace(/\n/g, " ");
        const container = el.containerId ?? null;
        out += container !== null ? `[label@${container}] ${text}\n` : `[text] ${text}\n`;
        break;
      }
      case "rectangle":
      case "ellipse":
      case "diamond": {
        const label = boundText(byId, el.id);
        out += `[${type} ${el.id}] ${label === "" ? "(no label)" : label}\n`;
        break;
      }
      case "arrow":
      case "line": {
        const start = el.startBinding?.elementId ?? "?";
        const end = el.endBinding?.elementId ?? "?";
        out += `[${type}] ${start} -> ${end}\n`;
        break;
      }
      default:
        out += `[${type}]\n`;
    }
  }
  return out.trimEnd();
}

/** A shape's label is the text element whose containerId points at it. */
function boundText(byId: Map<string, ValidElement>, shapeId: string): string {
  for (const el of byId.values()) {
    if (el.type !== "text" || el.containerId !== shapeId) continue;
    return (el.text ?? "").replace(/\n/g, " ");
  }
  return "";
}

/**
 * Minimal valid .excalidraw JSON document for persistence. Windows-port note:
 * Android/macOS persist source "https://nonenote.app" and appState
 * {viewBackgroundColor: "#ffffff"}; the port spec fixes source "NoneNote"
 * with an empty appState plus the note title.
 */
export function excalidrawJson(elements: ValidElement[], title: string): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "NoneNote",
    title,
    elements,
    appState: {},
    files: {},
  });
}

// ---------- read-only SVG projection ----------

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function xmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(s: string): string {
  return xmlText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function markerId(color: string): string {
  return "arrowhead-" + color.replace(/[^A-Za-z0-9]/g, "");
}

function paint(el: ValidElement): string {
  const fill = el.backgroundColor === "transparent" ? "none" : xmlAttr(el.backgroundColor);
  let s = ` fill="${fill}" stroke="${xmlAttr(el.strokeColor)}" stroke-width="${fmt(el.strokeWidth)}"`;
  if (el.strokeStyle === "dashed") s += ` stroke-dasharray="8 6"`;
  if (el.opacity < 100) s += ` opacity="${fmt(el.opacity / 100)}"`;
  return s;
}

function textNode(el: ValidElement, byId: Map<string, ValidElement>): string {
  const container =
    el.containerId !== null && el.containerId !== undefined
      ? byId.get(el.containerId)
      : undefined;
  const box = container ?? el;
  const cx = box.x + box.width / 2;
  const fontSize = el.fontSize ?? 20;
  const lineHeight = (el.lineHeight ?? 1.25) * fontSize;
  const lines = (el.text ?? "").split("\n");
  const startY = box.y + box.height / 2 - ((lines.length - 1) * lineHeight) / 2;
  const anchor =
    el.textAlign === "left" ? "start" : el.textAlign === "right" ? "end" : "middle";
  let s =
    `<text x="${fmt(cx)}" y="${fmt(startY)}" font-size="${fmt(fontSize)}"` +
    ` fill="${xmlAttr(el.strokeColor)}" text-anchor="${anchor}" dominant-baseline="middle"`;
  if (container !== undefined) s += ` data-container-id="${xmlAttr(el.containerId!)}"`;
  s += ">";
  if (lines.length === 1) {
    s += xmlText(lines[0]);
  } else {
    s += lines
      .map(
        (line, i) =>
          `<tspan x="${fmt(cx)}" dy="${i === 0 ? 0 : fmt(lineHeight)}">${xmlText(line)}</tspan>`,
      )
      .join("");
  }
  s += "</text>";
  return s;
}

/**
 * Deterministic read-only SVG projection for the viewer: rectangles,
 * ellipses and diamonds as stroked shapes, text with font-size, arrows as
 * polylines with a colored arrowhead marker; label text is centered in the
 * shape it binds to via containerId. Pragmatic rendering, not an Excalidraw
 * clone.
 */
export function excalidrawToSvg(
  elements: ValidElement[],
  width: number,
  height: number,
): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}"` +
      ` viewBox="0 0 ${fmt(width)} ${fmt(height)}">`,
  );

  // One arrowhead marker per distinct arrow stroke color, in element order.
  const markerColors: string[] = [];
  for (const el of elements) {
    if (el.type !== "arrow") continue;
    const hasHead =
      (el.endArrowhead !== null && el.endArrowhead !== undefined && el.endArrowhead !== "none") ||
      (el.startArrowhead !== null &&
        el.startArrowhead !== undefined &&
        el.startArrowhead !== "none");
    if (hasHead && !markerColors.includes(el.strokeColor)) markerColors.push(el.strokeColor);
  }
  if (markerColors.length > 0) {
    lines.push("<defs>");
    for (const color of markerColors) {
      lines.push(
        `<marker id="${xmlAttr(markerId(color))}" viewBox="0 0 10 10" refX="9" refY="5"` +
          ` markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
          `<path d="M 0 0 L 10 5 L 0 10 z" fill="${xmlAttr(color)}"/></marker>`,
      );
    }
    lines.push("</defs>");
  }

  const byId = new Map(elements.map((el) => [el.id, el]));
  for (const el of elements) {
    switch (el.type) {
      case "rectangle":
        lines.push(
          `<rect x="${fmt(el.x)}" y="${fmt(el.y)}" width="${fmt(el.width)}"` +
            ` height="${fmt(el.height)}"${paint(el)}/>`,
        );
        break;
      case "ellipse":
        lines.push(
          `<ellipse cx="${fmt(el.x + el.width / 2)}" cy="${fmt(el.y + el.height / 2)}"` +
            ` rx="${fmt(el.width / 2)}" ry="${fmt(el.height / 2)}"${paint(el)}/>`,
        );
        break;
      case "diamond": {
        const mx = el.x + el.width / 2;
        const my = el.y + el.height / 2;
        lines.push(
          `<polygon points="${fmt(mx)},${fmt(el.y)} ${fmt(el.x + el.width)},${fmt(my)}` +
            ` ${fmt(mx)},${fmt(el.y + el.height)} ${fmt(el.x)},${fmt(my)}"${paint(el)}/>`,
        );
        break;
      }
      case "text":
        lines.push(textNode(el, byId));
        break;
      case "arrow": {
        const points = el.points ?? [[0, 0], [100, 0]];
        const abs = points.map(([dx, dy]) => `${fmt(el.x + dx)},${fmt(el.y + dy)}`).join(" ");
        let s = `<polyline points="${abs}" fill="none"${paint(el)}`;
        if (el.endArrowhead !== null && el.endArrowhead !== "none") {
          s += ` marker-end="url(#${markerId(el.strokeColor)})"`;
        }
        if (el.startArrowhead !== null && el.startArrowhead !== undefined && el.startArrowhead !== "none") {
          s += ` marker-start="url(#${markerId(el.strokeColor)})"`;
        }
        lines.push(s + "/>");
        break;
      }
    }
  }
  lines.push("</svg>");
  return lines.join("\n");
}
