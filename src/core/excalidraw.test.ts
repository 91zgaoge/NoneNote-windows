import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ELEMENTS,
  excalidrawJson,
  excalidrawToSvg,
  parseExcalidrawJson,
  projectExcalidraw,
  validateExcalidraw,
  type ValidElement,
} from "./excalidraw.ts";

function okElements(...els: unknown[]): ValidElement[] {
  const result = validateExcalidraw(els);
  assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
  return result.elements;
}

test("validate accepts the five protocol element types and fills defaults", () => {
  const elements = okElements(
    { id: "r1", type: "rectangle", x: 10, y: 20 },
    { id: "e1", type: "ellipse", x: 200, y: 20 },
    { id: "d1", type: "diamond", x: 400, y: 20 },
    { id: "t1", type: "text", text: "Hello", containerId: "r1" },
    {
      id: "a1",
      type: "arrow",
      points: [[0, 0], [120, 0]],
      startBinding: { elementId: "r1" },
      endBinding: { elementId: "e1" },
    },
  );
  assert.equal(elements.length, 5);
  const rect = elements[0];
  assert.equal(rect.width, 100);
  assert.equal(rect.height, 50);
  assert.equal(rect.strokeColor, "#1e1e1e");
  assert.equal(rect.backgroundColor, "transparent");
  assert.deepEqual(rect.roundness, { type: 3 });
  assert.equal(rect.isDeleted, false);
  assert.equal(rect.link, null);
  const text = elements[3];
  assert.equal(text.text, "Hello");
  assert.equal(text.originalText, "Hello");
  assert.equal(text.fontSize, 20);
  assert.equal(text.containerId, "r1");
  const arrow = elements[4];
  assert.deepEqual(arrow.points, [[0, 0], [120, 0]]);
  assert.equal(arrow.endArrowhead, "arrow");
  assert.equal(arrow.startArrowhead, null);
});

test("validate rejects a missing or unknown type", () => {
  assert.deepEqual(validateExcalidraw([{ id: "x" }]), {
    ok: false,
    reason: "element 0: missing type",
  });
  assert.deepEqual(validateExcalidraw([{ type: "image" }]), {
    ok: false,
    reason: "element 0: unknown type image",
  });
  assert.deepEqual(validateExcalidraw("nope" as unknown as unknown[]), {
    ok: false,
    reason: "elements must be an array",
  });
  assert.deepEqual(validateExcalidraw([]), { ok: false, reason: "no elements" });
});

test("validate enforces bound limits", () => {
  assert.deepEqual(validateExcalidraw([{ type: "rectangle", width: 200_000 }]), {
    ok: false,
    reason: "element 0: size out of bounds",
  });
  assert.deepEqual(validateExcalidraw([{ type: "rectangle", x: 2_000_000 }]), {
    ok: false,
    reason: "element 0: coordinates out of bounds",
  });
  assert.deepEqual(validateExcalidraw([{ type: "text", text: "x".repeat(5_001) }]), {
    ok: false,
    reason: "element 0: text too long (> 5000 chars)",
  });
  assert.deepEqual(validateExcalidraw([{ type: "rectangle", x: "10" }]), {
    ok: false,
    reason: "element 0: x must be a finite number",
  });
  const many = Array.from({ length: MAX_ELEMENTS + 1 }, () => ({ type: "text", text: "x" }));
  assert.deepEqual(validateExcalidraw(many), {
    ok: false,
    reason: `too many elements (> ${MAX_ELEMENTS})`,
  });
});

test("validate rejects bad arrow bindings", () => {
  assert.deepEqual(
    validateExcalidraw([{ id: "a1", type: "arrow", startBinding: { elementId: "ghost" } }]),
    { ok: false, reason: "arrow a1: startBinding references unknown element ghost" },
  );
  assert.deepEqual(
    validateExcalidraw([{ id: "a1", type: "arrow", endBinding: { elementId: "ghost" } }]),
    { ok: false, reason: "arrow a1: endBinding references unknown element ghost" },
  );
  assert.deepEqual(
    validateExcalidraw([{ id: "a1", type: "arrow", startBinding: "rect" }]),
    { ok: false, reason: "element 0: startBinding must reference an element" },
  );
  assert.deepEqual(validateExcalidraw([{ type: "arrow", points: "nope" }]), {
    ok: false,
    reason: "element 0: points must be [x, y] pairs",
  });
  // Bindings to elements that exist are fine (including later in the array).
  const result = validateExcalidraw([
    { id: "a1", type: "arrow", startBinding: { elementId: "r1" }, endBinding: { elementId: "r2" } },
    { id: "r1", type: "rectangle" },
    { id: "r2", type: "rectangle" },
  ]);
  assert.ok(result.ok);
});

test("validate skips deleted elements", () => {
  const elements = okElements(
    { id: "d", type: "rectangle", isDeleted: true },
    { id: "k", type: "rectangle" },
  );
  assert.equal(elements.length, 1);
  assert.equal(elements[0].id, "k");
});

test("validate assigns deterministic default ids", () => {
  const elements = okElements({ type: "rectangle" }, { type: "text", text: "x" });
  assert.match(elements[0].id, /^el-/);
  assert.match(elements[1].id, /^el-/);
});

test("projectExcalidraw renders the DIAGRAM projection", () => {
  const elements = okElements(
    { id: "r1", type: "rectangle", x: 0, y: 0 },
    { id: "t1", type: "text", text: "Hello", containerId: "r1" },
    { id: "e2", type: "ellipse", x: 5, y: 5 },
    {
      id: "a1",
      type: "arrow",
      startBinding: { elementId: "r1" },
      endBinding: { elementId: "e2" },
    },
    { id: "a2", type: "arrow" },
    { id: "t2", type: "text", text: "free\nstanding" },
  );
  const projection = projectExcalidraw(elements);
  assert.equal(
    projection,
    [
      "DIAGRAM",
      "[rectangle r1] Hello",
      "[label@r1] Hello",
      "[ellipse e2] (no label)",
      "[arrow] r1 -> e2",
      "[arrow] ? -> ?",
      "[text] free standing",
    ].join("\n"),
  );
});

test("excalidrawJson produces a round-trippable .excalidraw document", () => {
  const elements = okElements(
    { id: "r1", type: "rectangle" },
    { id: "t1", type: "text", text: "Label", containerId: "r1" },
  );
  const json = excalidrawJson(elements, "My Diagram");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed.type, "excalidraw");
  assert.equal(parsed.version, 2);
  assert.equal(parsed.source, "NoneNote");
  assert.equal(parsed.title, "My Diagram");
  assert.deepEqual(parsed.appState, {});
  assert.deepEqual(parsed.files, {});
  const roundTripped = parsed.elements as ValidElement[];
  assert.equal(roundTripped.length, 2);
  assert.equal(roundTripped[0].id, "r1");
  assert.equal(roundTripped[1].text, "Label");
});

test("excalidrawToSvg projects shapes, labels and arrows deterministically", () => {
  const elements = okElements(
    { id: "r1", type: "rectangle", x: 10, y: 20, width: 100, height: 50 },
    { id: "t1", type: "text", text: "Start", containerId: "r1", fontSize: 20 },
    { id: "e1", type: "ellipse", x: 200, y: 20, width: 80, height: 60, backgroundColor: "#aabbcc" },
    { id: "d1", type: "diamond", x: 320, y: 20, width: 90, height: 40 },
    {
      id: "a1",
      type: "arrow",
      x: 110,
      y: 45,
      points: [[0, 0], [90, 0]],
      startBinding: { elementId: "r1" },
      endBinding: { elementId: "e1" },
    },
  );
  const svg = excalidrawToSvg(elements, 800, 600);
  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(
    svg.includes('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">'),
  );
  assert.ok(svg.includes('<rect x="10" y="20" width="100" height="50" fill="none" stroke="#1e1e1e" stroke-width="2"/>'));
  assert.ok(svg.includes('<ellipse cx="240" cy="50" rx="40" ry="30" fill="#aabbcc"'));
  assert.ok(svg.includes('<polygon points="365,20 410,40 365,60 320,40"'));
  // Label text bound to the rectangle is centered in the rectangle's bounds.
  assert.ok(svg.includes('<text x="60" y="45" font-size="20"'), svg);
  assert.ok(svg.includes(">Start</text>"));
  assert.ok(svg.includes('data-container-id="r1"'));
  assert.ok(svg.includes('<polyline points="110,45 200,45"'));
  assert.ok(svg.includes('marker-end="url(#arrowhead-1e1e1e)"'));
  assert.ok(svg.includes("<marker id=\"arrowhead-1e1e1e\""));
  assert.ok(svg.endsWith("</svg>"));
});

test("excalidrawToSvg escapes XML and renders multi-line text", () => {
  const elements = okElements(
    { id: "t1", type: "text", text: "a<b & \"c\"", x: 0, y: 0, width: 100, height: 40 },
    { id: "t2", type: "text", text: "Line1\nLine2", x: 0, y: 100, width: 100, height: 40 },
  );
  const svg = excalidrawToSvg(elements, 400, 300);
  assert.ok(svg.includes("a&lt;b &amp; \"c\""), svg);
  assert.ok(svg.includes("<tspan"), svg);
  assert.ok(svg.includes("Line1"), svg);
  assert.ok(svg.includes("Line2"), svg);
});

test("parseExcalidrawJson accepts arrays and full file objects", () => {
  const elementJson = JSON.stringify([{ id: "r1", type: "rectangle" }]);
  assert.ok(parseExcalidrawJson(elementJson).ok);
  assert.ok(
    parseExcalidrawJson(JSON.stringify({ type: "excalidraw", elements: [{ type: "ellipse" }] })).ok,
  );
  assert.deepEqual(parseExcalidrawJson("{not json"), { ok: false, reason: "invalid JSON" });
  assert.deepEqual(parseExcalidrawJson('{"type":"excalidraw"}'), {
    ok: false,
    reason: "no elements in file",
  });
  assert.deepEqual(parseExcalidrawJson('"just a string"'), {
    ok: false,
    reason: "invalid excalidraw document",
  });
  assert.deepEqual(parseExcalidrawJson("   "), { ok: false, reason: "empty input" });
});
