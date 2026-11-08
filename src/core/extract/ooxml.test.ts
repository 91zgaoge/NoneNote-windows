import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import {
  extractDocx,
  extractXlsx,
  extractPptx,
  columnIndex,
} from "./ooxml.ts";
import { renderGfm } from "./gfm.ts";
import { extractText } from "./textExtractor.ts";
import { Limits } from "./types.ts";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---- docx --------------------------------------------------------------------

const DOCX_XML =
  XML_DECL +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report &amp; Notes</w:t></w:r></w:p>' +
  '<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>emphasis</w:t><w:tab/><w:t>after tab</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>plain</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>item one</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>item two</w:t></w:r></w:p>' +
  "<w:tbl>" +
  "<w:tr><w:tc><w:p><w:r><w:t>H|1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc></w:tr>" +
  "<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>" +
  "</w:tbl>" +
  "<w:p><w:drawing/></w:p>" +
  "</w:body></w:document>";

function docxZip(xml: string): Uint8Array {
  return zipSync({ "word/document.xml": strToU8(xml) });
}

test("docx: headings, runs, bullets, tables, images render through GFM", () => {
  const md = renderGfm(extractDocx(docxZip(DOCX_XML)));
  assert.equal(
    md,
    "# Report & Notes\n\n" +
      // The w:tab lands inside the bold+italic run, like Android.
      "***emphasis after tab***\n\n" +
      "plain\n\n" +
      "- item one\n- item two\n\n" +
      "| H\\|1 | H2 |\n| --- | --- |\n| a |  |\n\n" +
      "![]()\n",
  );
});

test("docx: heading levels clamp to 1..6 and wordbreak styles map", () => {
  const xml =
    XML_DECL +
    '<w:document xmlns:w="u"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="heading 3"/></w:pPr><w:r><w:t>lowercase</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading9"/></w:pPr><w:r><w:t>too deep</w:t></w:r></w:p>' +
    "</w:body></w:document>";
  assert.equal(
    renderGfm(extractDocx(docxZip(xml))),
    "### lowercase\n\n###### too deep\n",
  );
});

test("docx: missing part is classified; facade never reaches it for unknown zips", async () => {
  // Direct call: the facade's sniff would already answer "unknown" for a zip
  // without any known member (Android behaves the same way).
  assert.throws(
    () => extractDocx(zipSync({ "word/other.xml": strToU8("<x/>") })),
    (e: Error) => e.name === "ExtractFailure" && /missing word\/document\.xml/.test(e.message),
  );
  const viaFacade = await extractText("x.docx", "", zipSync({ "word/other.xml": strToU8("<x/>") }));
  assert.deepEqual(viaFacade, {
    ok: false,
    error: { kind: "unsupported", detail: "unknown" },
  });
});

// ---- xlsx --------------------------------------------------------------------

function xlsxZip(): Uint8Array {
  return zipSync({
    "xl/workbook.xml": strToU8(
      XML_DECL +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/>' +
        '<sheet name="Data" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>' +
        "</Relationships>",
    ),
    "xl/sharedStrings.xml": strToU8(
      XML_DECL + "<sst><si><t>Name</t></si><si><t>Age</t></si><si><t>Alice</t></si></sst>",
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      XML_DECL +
        "<worksheet><sheetData>" +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c><c r="D2" t="b"><v>1</v></c></row>' +
        "</sheetData></worksheet>",
    ),
    "xl/worksheets/sheet2.xml": strToU8(
      XML_DECL +
        "<worksheet><sheetData>" +
        '<row r="1"><c r="A1" t="inlineStr"><t><is>inline</is></t></c></row>' +
        "</sheetData></worksheet>",
    ),
  });
}

test("xlsx: shared strings, sparse columns and booleans per sheet", () => {
  assert.equal(
    renderGfm(extractXlsx(xlsxZip())),
    "| Name | Age |  |  |\n| --- | --- | --- | --- |\n| Alice | 30 |  | TRUE |\n\n" +
      "| inline |\n| --- |\n",
  );
});

test("xlsx: missing workbook is classified; columnIndex matches Android", () => {
  assert.throws(
    () => extractXlsx(zipSync({ "xl/sharedStrings.xml": strToU8("<sst/>") })),
    (e: Error) => e.name === "ExtractFailure" && /missing xl\/workbook\.xml/.test(e.message),
  );
  assert.equal(columnIndex("A"), 0);
  assert.equal(columnIndex("B12"), 1);
  assert.equal(columnIndex("AA"), 26);
  assert.equal(columnIndex(""), -1);
  assert.equal(columnIndex("12"), -1);
});

// ---- pptx --------------------------------------------------------------------

test("pptx: slides sort numerically and paragraphs flatten runs", () => {
  const zip = zipSync({
    "ppt/slides/slide10.xml": strToU8(
      '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody>' +
        "<a:p><a:r><a:t>Ten</a:t></a:r></a:p>" +
        "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
    ),
    "ppt/slides/slide2.xml": strToU8(
      '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody>' +
        "<a:p><a:r><a:t>Two a</a:t></a:r><a:br/><a:r><a:t>Two b</a:t></a:r></a:p>" +
        "<a:p/>" +
        "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
    ),
    "ppt/slides/slide1.xml": strToU8(
      '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody>' +
        "<a:p><a:r><a:t>One</a:t></a:r></a:p>" +
        "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
    ),
    "ppt/notesSlides/notesSlide1.xml": strToU8("<p:notes><a:t>ignored notes</a:t></p:notes>"),
  });
  assert.equal(
    renderGfm(extractPptx(zip)),
    "One\n\nTwo a Two b\n\nTen\n",
  );
});

test("pptx: no slides is classified", async () => {
  // presentation.xml makes the sniff answer "pptx"; no slideN.xml parts left.
  const empty = await extractText(
    "x.pptx",
    "",
    zipSync({ "ppt/presentation.xml": strToU8("<p/>") }),
  );
  assert.deepEqual(empty, {
    ok: false,
    error: { kind: "malformed", detail: "no slides in ppt/" },
  });
});

// ---- zip-bomb budget -----------------------------------------------------------

test("zip budget aborts mid-entry with resource_limit", () => {
  // 1 MB of 'a' deflates to ~1 KB; inflating it must trip the 10 KB budget.
  const bomb = zipSync({ "word/document.xml": strToU8("a".repeat(1_000_000)) }, { level: 9 });
  const original = Limits.MAX_UNZIP_TOTAL;
  Limits.MAX_UNZIP_TOTAL = 10_000;
  try {
    assert.throws(() => extractDocx(bomb), (e: Error) => {
      assert.equal(e.name, "ExtractFailure");
      assert.match(e.message, /uncompressed zip size > 10000/);
      return true;
    });
  } finally {
    Limits.MAX_UNZIP_TOTAL = original;
  }
});
