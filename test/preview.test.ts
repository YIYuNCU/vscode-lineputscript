import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { decodeLpsText } from "../src/lps/escape";
import { parseLpsDocument } from "../src/lps/parser";
import {
  PREVIEW_COLLAPSE_LENGTH_THRESHOLD,
  PREVIEW_COLLAPSE_SUB_THRESHOLD,
  PREVIEW_LONG_VALUE_CHARS,
  PREVIEW_LONG_VALUE_LINES,
  PREVIEW_MAX_EXTRA_DECODE_LAYERS,
  PREVIEW_SUBS_TABLE_COLLAPSE_THRESHOLD,
  computeDecodeLayers,
  isLongPreviewValue,
  parsePreviewMessage,
  planReveal,
  renderPreviewHtml,
  shouldCollapseLine
} from "../src/lps/preview";
import type { LpsDocument } from "../src/lps/types";

const nonce = "dGVzdC1ub25jZQ==";

interface DecodedOverrides {
  info?: string;
  text?: string;
  subs?: string[];
}

/**
 * The parser no longer decodes `/n`, so a decoded value can never contain a newline that came from the
 * file. The preview API can still receive such values (hand-built documents), so tests inject them
 * directly into the decoded fields of one line.
 */
function parseWithDecoded(source: string, overrides: DecodedOverrides, lineIndex = 0): LpsDocument {
  const document = parseLpsDocument(source);
  const line = document.lines[lineIndex];
  if (overrides.info !== undefined) {
    line.decodedInfo = overrides.info;
  }
  if (overrides.text !== undefined) {
    line.decodedText = overrides.text;
  }
  overrides.subs?.forEach((value, index) => {
    line.subs[index].decodedInfo = value;
  });
  return document;
}

function buildLine(name: string, subCount: number, info = "", subInfo = "v"): string {
  const subs = Array.from({ length: subCount }, (_, index) => `s${index}#${subInfo}`).join(":|");
  return `${name}#${info}:|${subs}${subCount > 0 ? ":|" : ""}`;
}

function lineDetailsTag(html: string, name: string): string {
  const match = new RegExp(`<details class="line" data-name="${name}"[^>]*>`).exec(html);
  assert.ok(match, `line ${name} should be rendered`);
  return match[0];
}

test("preview renders decoded info and text values", () => {
  const parsed = parseLpsDocument("line#hello/idworld:|sub#a/idb:|body/ntext///note");
  const html = renderPreviewHtml(parsed);

  assert.equal(parsed.lines[0].decodedInfo, "hello#world");
  assert.equal(parsed.lines[0].decodedText, "body/ntext");
  assert.match(html, /<div class="value">hello#world<\/div>/);
  assert.match(html, /a#b/);
  // `/n` is not decoded: it stays as written and never becomes a line break.
  assert.match(html, /<div class="value">body\/ntext<\/div>/);
  assert.match(html, /raw: hello\/idworld/);
  assert.match(html, /raw: body\/ntext/);
});

test("preview keeps /n and /null verbatim and does not offer a further decode layer for them", () => {
  const parsed = parseLpsDocument("Image#/null:|a#x/ny:|b#/null:|body/n///c");
  const html = renderPreviewHtml(parsed, { nonce });

  assert.equal(parsed.lines[0].decodedInfo, "/null");
  assert.equal(parsed.lines[0].subs[0].decodedInfo, "x/ny");
  assert.equal(parsed.lines[0].decodedText, "body/n");
  assert.match(html, /<div class="value">\/null<\/div>/);
  assert.match(html, /<div class="value">x\/ny<\/div>/);
  assert.match(html, /<div class="value">body\/n<\/div>/);
  assert.match(html, /<span class="snippet">\/null<\/span>/);
  // Nothing decodes further, so no layer bookkeeping, and no value was split across lines.
  assert.doesNotMatch(html, /data-action="deeper"|data-layer="1"|再解一层/);
  assert.doesNotMatch(html, /<div class="(?:value|raw)">[^<]*\n/);
  assert.doesNotMatch(html, /\d+ 行\)/);
});

test("preview decodes values only once", () => {
  const parsed = parseLpsDocument("line#a/!comb:|sub#x/!taby:|");
  const html = renderPreviewHtml(parsed);

  assert.equal(parsed.lines[0].decodedInfo, "a/comb");
  assert.match(html, /raw: a\/!comb/);
  assert.doesNotMatch(html, /preview-decoded/);
  // Layer 0 is the parser's single decode and the only visible one.
  assert.match(html, /<div class="vlayer" data-layer="0"><div class="value">a\/comb<\/div><\/div>/);
  assert.match(html, /<div class="vlayer" data-layer="1" hidden><div class="value">a,b<\/div><\/div>/);
  assert.match(html, /<div class="vlayer" data-layer="0"><div class="value">x\/taby<\/div><\/div>/);
  assert.match(html, /<div class="vlayer" data-layer="1" hidden><div class="value">x\ty<\/div><\/div>/);
});

test("/!n decodes once to /n and a further pass leaves it unchanged", () => {
  const parsed = parseLpsDocument("line#a/!nb:|sub#/!null:|");
  const html = renderPreviewHtml(parsed);

  assert.equal(parsed.lines[0].decodedInfo, "a/nb");
  assert.equal(parsed.lines[0].subs[0].decodedInfo, "/null");
  assert.match(html, /raw: a\/!nb/);
  assert.match(html, /<div class="value">a\/nb<\/div>/);
  assert.match(html, /<div class="value">\/null<\/div>/);
  assert.doesNotMatch(html, /data-action="deeper"|data-layer="1"/);
});

test("decoded values containing the line separator are not flagged", () => {
  const parsed = parseLpsDocument("line#/stop:|sub#a/stopb:|text/stop");
  const html = renderPreviewHtml(parsed);

  assert.equal(parsed.lines[0].decodedInfo, ":|");
  assert.equal(parsed.lines[0].subs[0].decodedInfo, "a:|b");
  assert.equal(parsed.lines[0].decodedText, "text:|");
  assert.match(html, /<div class="value">a:\|b<\/div>/);
  assert.doesNotMatch(html, /invalid LPS value<\/span>/);
  assert.doesNotMatch(html, /<span class="invalid-lps-value">/);
});

test("raw values that somehow contain the line separator are still flagged", () => {
  const parsed = parseLpsDocument("line#x:|sub#a/stopb:|text");
  parsed.lines[0].subs[0].info = "q:|r";
  parsed.lines[0].info = "x:|y";
  const html = renderPreviewHtml(parsed);

  assert.equal((html.match(/<span class="invalid-lps-value">invalid LPS value<\/span>/g) ?? []).length, 2);
});

test("preview escapes html in decoded values", () => {
  const parsed = parseLpsDocument("line#<tag>:|sub#\"value\":|");
  const html = renderPreviewHtml(parsed);

  assert.match(html, /&lt;tag&gt;/);
  assert.match(html, /&quot;value&quot;/);
  assert.doesNotMatch(html, /<tag>/);
});

test("preview escapes html in names, attributes, comments and summaries", () => {
  const parsed = parseLpsDocument("\"><img src=x onerror=alert(1)>#<script>alert(1)</script>:|<b onclick=x>#<i>:|<u>text</u>///<svg onload=alert(1)>");
  const html = renderPreviewHtml(parsed, { nonce });

  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /<b onclick/);
  assert.doesNotMatch(html, /<u>/);
  assert.doesNotMatch(html, /<i>/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-name="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  // Only the preview's own script tag may exist.
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
});

test("preview uses a nonce based CSP and no inline event handlers", () => {
  const html = renderPreviewHtml(parseLpsDocument(buildLine("a", 3)), { nonce });

  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-dGVzdC1ub25jZQ==';">/
  );
  assert.match(html, /<script nonce="dGVzdC1ub25jZQ==">/);
  assert.doesNotMatch(html, /script-src[^"]*'unsafe-inline'/);
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test("preview generates a distinct random nonce and rejects unsafe nonces", () => {
  const first = renderPreviewHtml(parseLpsDocument("a#b:|"));
  const second = renderPreviewHtml(parseLpsDocument("a#b:|"));
  const nonceOf = (html: string): string => /script-src 'nonce-([^']+)'/.exec(html)?.[1] ?? "";

  assert.ok(nonceOf(first).length >= 16);
  assert.notEqual(nonceOf(first), nonceOf(second));
  assert.match(first, new RegExp(`<script nonce="${nonceOf(first).replace(/[+/=]/g, "\\$&")}">`));
  assert.throws(() => renderPreviewHtml(parseLpsDocument("a#b:|"), { nonce: "x'; script-src *" }));
  assert.throws(() => renderPreviewHtml(parseLpsDocument("a#b:|"), { nonce: "" }));
});

test("preview toolbar offers expand, collapse, filter and export controls", () => {
  const html = renderPreviewHtml(parseLpsDocument("a#b:|"), { nonce });

  assert.match(html, /id="expand-all"[^>]*>全部展开</);
  assert.match(html, /id="collapse-all"[^>]*>全部折叠</);
  assert.match(html, /<input type="search" id="filter"/);
  assert.match(html, /id="export"[^>]*>导出</);
  assert.match(html, /placeholder="按 line \/ sub 名或值过滤"/);
  assert.match(html, /id="filter-count"/);
  assert.match(html, /vscode\.postMessage\(\{ type: "export" \}\)/);
  // The toolbar is hidden until the script runs, so it never shows as dead controls.
  assert.match(html, /id="toolbar" hidden/);
});

test("short lines are expanded and lines over the sub threshold are collapsed", () => {
  const document = parseLpsDocument([
    buildLine("short", PREVIEW_COLLAPSE_SUB_THRESHOLD),
    buildLine("many", PREVIEW_COLLAPSE_SUB_THRESHOLD + 1)
  ].join("\n"));
  const html = renderPreviewHtml(document, { nonce });

  assert.equal(shouldCollapseLine(document.lines[0]), false);
  assert.equal(shouldCollapseLine(document.lines[1]), true);
  assert.match(lineDetailsTag(html, "short"), / open>$/);
  assert.doesNotMatch(lineDetailsTag(html, "many"), /open/);
});

test("lines over the raw length threshold are collapsed", () => {
  const filler = "x".repeat(PREVIEW_COLLAPSE_LENGTH_THRESHOLD);
  const document = parseLpsDocument([
    `edge#${"y".repeat(PREVIEW_COLLAPSE_LENGTH_THRESHOLD - 7)}:|`,
    `long#${filler}:|`
  ].join("\n"));
  const html = renderPreviewHtml(document, { nonce });

  assert.equal(document.lines[0].range.end - document.lines[0].range.start, PREVIEW_COLLAPSE_LENGTH_THRESHOLD);
  assert.equal(shouldCollapseLine(document.lines[0]), false);
  assert.equal(shouldCollapseLine(document.lines[1]), true);
  assert.match(lineDetailsTag(html, "edge"), / open>$/);
  assert.doesNotMatch(lineDetailsTag(html, "long"), /open/);
});

test("line summary shows name, sub count, raw length and truncated info", () => {
  const info = "z".repeat(300);
  const document = parseLpsDocument(buildLine("big", 3, info));
  const html = renderPreviewHtml(document, { nonce });
  const summary = /<summary class="line-summary">([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
  const rawLength = document.lines[0].range.end - document.lines[0].range.start;

  assert.match(summary, /<span class="name goto" data-start="0" data-end="\d+">big<\/span>/);
  assert.match(summary, new RegExp(`3 个子项 · ${rawLength} 字符`));
  const snippet = /<span class="snippet">([^<]*)<\/span>/.exec(summary)?.[1] ?? "";
  assert.ok(snippet.length > 0 && snippet.length < info.length);
  assert.ok(snippet.endsWith("…"));
});

test("sub tables over the threshold are collapsed separately from the line", () => {
  const small = renderPreviewHtml(parseLpsDocument(buildLine("a", PREVIEW_COLLAPSE_SUB_THRESHOLD)), { nonce });
  const big = renderPreviewHtml(
    parseLpsDocument(buildLine("b", PREVIEW_SUBS_TABLE_COLLAPSE_THRESHOLD + 1)),
    { nonce }
  );

  assert.match(small, /<details class="subs" open>/);
  assert.match(big, /<details class="subs">/);
  assert.match(big, new RegExp(`<summary>子项 \\(${PREVIEW_SUBS_TABLE_COLLAPSE_THRESHOLD + 1}\\)</summary>`));
});

test("long values are truncated behind an expand button, short values are not", () => {
  assert.equal(isLongPreviewValue("x".repeat(PREVIEW_LONG_VALUE_CHARS)), false);
  assert.equal(isLongPreviewValue("x".repeat(PREVIEW_LONG_VALUE_CHARS + 1)), true);
  assert.equal(isLongPreviewValue("a\n".repeat(PREVIEW_LONG_VALUE_LINES - 1) + "a"), false);
  assert.equal(isLongPreviewValue("a\n".repeat(PREVIEW_LONG_VALUE_LINES) + "a"), true);

  const longText = "q".repeat(PREVIEW_LONG_VALUE_CHARS + 50);
  const html = renderPreviewHtml(parseLpsDocument(`line#short:|sub#${longText}/id:|`), { nonce });

  // Decoded value (451 chars) and raw value (453 chars) are both long, so both fold.
  assert.equal((html.match(/<details class="long-value value">/g) ?? []).length, 1);
  assert.equal((html.match(/<details class="long-value raw">/g) ?? []).length, 1);
  assert.match(html, /展开 \(451 字符\)/);
  assert.match(html, /展开 \(453 字符\)/);
  assert.match(html, /<span class="toggle when-open">收起<\/span>/);
  assert.match(html, /<div class="value">short<\/div>/);
  assert.ok(html.includes(`<div class="long-body">${longText}#</div>`));
  assert.ok(html.includes(`<div class="long-body">${longText}/id</div>`));
});

test("multi-line long values report their line count", () => {
  const lines = PREVIEW_LONG_VALUE_LINES + 2;
  const rows = Array.from({ length: lines }, (_, index) => `row${index}`);
  // The raw file text can only hold `/n`; the multi-line decoded value is injected by hand.
  const document = parseWithDecoded(`line#${rows.join("/n")}:|`, { info: rows.join("\n") });
  const html = renderPreviewHtml(document, { nonce });

  assert.match(html, new RegExp(`展开 \\(${rows.join("\n").length} 字符 / ${lines} 行\\)`));
  assert.ok(html.includes(`<div class="long-body">${rows.join("\n")}</div>`));
  // The raw value has no real line break, so it is not folded by line count.
  assert.doesNotMatch(html, /<details class="long-value raw">/);

  // Without the injected newlines the parser output is a single line and reports no line count.
  const parsedOnly = renderPreviewHtml(parseLpsDocument(`line#${rows.join("/n")}:|`), { nonce });
  assert.doesNotMatch(parsedOnly, /字符 \/ \d+ 行/);
});

test("multi-line decoded values are rendered for info, sub and text, and fold in the summary snippet", () => {
  const document = parseWithDecoded("line#i:|sub#s:|body", {
    info: "first\nsecond",
    text: "t1\nt2",
    subs: ["s1\ns2"]
  });
  const html = renderPreviewHtml(document, { nonce });

  assert.match(html, /<div class="value">first\nsecond<\/div>/);
  assert.match(html, /<div class="value">s1\ns2<\/div>/);
  assert.match(html, /<div class="value">t1\nt2<\/div>/);
  // The inline summary flattens line breaks into spaces.
  assert.match(html, /<span class="snippet">first second<\/span>/);
});

test("long multi-line sub and text values report their line count", () => {
  const lines = PREVIEW_LONG_VALUE_LINES + 1;
  const value = Array.from({ length: lines }, (_, index) => `r${index}`).join("\n");
  const document = parseWithDecoded("line#i:|sub#s:|body", { text: value, subs: [value] });
  const html = renderPreviewHtml(document, { nonce });

  assert.equal((html.match(new RegExp(`字符 / ${lines} 行\\)`, "g")) ?? []).length, 2);
  assert.equal((html.match(/<details class="long-value value">/g) ?? []).length, 2);
});

test("sub raw column only repeats the value when it differs from the decoded one", () => {
  const html = renderPreviewHtml(parseLpsDocument("line#:|same#plain:|diff#a/idb:|"), { nonce });

  assert.equal((html.match(/<div class="raw">/g) ?? []).length, 1);
  assert.match(html, /<div class="raw">a\/idb<\/div>/);
});

test("comment-only lines are rendered as a comment block", () => {
  const html = renderPreviewHtml(parseLpsDocument("///hello <b>world</b>\nline#x:|"), { nonce });

  assert.match(html, /<span class="name goto" data-start="0" data-end="\d+"[^>]*>\/\/ 注释<\/span>/);
  assert.match(html, /hello &lt;b&gt;world&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>world/);
});

function extractScript(html: string): string {
  const match = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "preview script should be present");
  return match[1];
}

test("preview script is valid JavaScript, posts the documented messages and never decodes", () => {
  const script = extractScript(renderPreviewHtml(parseLpsDocument("a#b:|"), { nonce }));

  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /type: "export"/);
  assert.match(script, /type: "copy", text: /);
  assert.match(script, /type: "reveal"/);
  assert.match(script, /el\.setAttribute\("role", "link"\)/);
  // Decoding happens on the server; the script only switches pre-rendered layers.
  assert.doesNotMatch(script, /\/stop|\/equ|\/tab|\/com|\/id|decodeLpsText/);
  // User data is only ever placed with text nodes and Range-free DOM calls.
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("preview script filters by names and decoded values, highlights with mark and restores state", () => {
  const script = extractScript(renderPreviewHtml(parseLpsDocument("a#b:|"), { nonce }));

  assert.match(script, /createElement\("mark"\)/);
  assert.match(script, /splitText\(/);
  assert.match(script, /"命中 " \+ hits \+ " 项"/);
  assert.match(script, /saved\.forEach\(function \(state\) \{\s*state\.el\.open = state\.open;/);
  assert.match(script, /closest\("details\.long-value"\)/);
});

test("rich previews keep the CSP, add no inline handlers and no extra scripts", () => {
  const parsed = parseLpsDocument([
    "<x>#a/!nb:|s#" + "q".repeat(PREVIEW_LONG_VALUE_CHARS + 10) + "/!n:|t#plain:|body/!n///c",
    "loose#info"
  ].join("\n"));
  const html = renderPreviewHtml(parsed, { nonce });

  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-dGVzdC1ub25jZQ==';">/
  );
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.ok(html.includes("&lt;x&gt;"));
});

test("computeDecodeLayers lists every further decode pass and stops when nothing changes", () => {
  assert.deepEqual(computeDecodeLayers("plain"), ["plain"]);
  assert.deepEqual(computeDecodeLayers(""), [""]);
  assert.deepEqual(computeDecodeLayers(":|"), [":|"]);
  assert.deepEqual(computeDecodeLayers("/!com"), ["/!com", "/com", ","]);
  assert.deepEqual(computeDecodeLayers("/!!!com"), ["/!!!com", "/!!com", "/!com", "/com", ","]);
  // `/n` is never decoded, so it is stable; `/!n` only loses its escape once and then stops changing.
  assert.deepEqual(computeDecodeLayers("a//nb"), ["a//nb"]);
  assert.deepEqual(computeDecodeLayers("/n"), ["/n"]);
  assert.deepEqual(computeDecodeLayers("/null"), ["/null"]);
  assert.deepEqual(computeDecodeLayers("/!n"), ["/!n", "/n"]);
  assert.deepEqual(computeDecodeLayers("/!!!n"), ["/!!!n", "/!!n", "/!n", "/n"]);
  // /r is still decoded.
  assert.deepEqual(computeDecodeLayers("/!r"), ["/!r", "/r", "\r"]);

  // Every layer is exactly one decodeLpsText pass over the previous one.
  const layers = computeDecodeLayers("/!!!com");
  for (let index = 1; index < layers.length; index++) {
    assert.equal(layers[index], decodeLpsText(layers[index - 1]));
  }
});

test("computeDecodeLayers is capped at eight extra layers", () => {
  const layers = computeDecodeLayers("/" + "!".repeat(12) + "n");

  assert.equal(PREVIEW_MAX_EXTRA_DECODE_LAYERS, 8);
  assert.equal(layers.length, 1 + PREVIEW_MAX_EXTRA_DECODE_LAYERS);
  assert.equal(layers[layers.length - 1], "/" + "!".repeat(4) + "n");
});

test("decode layers and their buttons are only rendered for values that change", () => {
  const html = renderPreviewHtml(parseLpsDocument("line#same:|a#plain:|b#x/!comy:|"), { nonce });

  assert.equal((html.match(/data-action="deeper"/g) ?? []).length, 1);
  assert.equal((html.match(/data-action="reset"/g) ?? []).length, 1);
  assert.equal((html.match(/data-layer="1"/g) ?? []).length, 1);
  // Single-layer values are plain blocks without layer bookkeeping.
  assert.equal((html.match(/<div class="vblock">/g) ?? []).length, 2);
  assert.equal((html.match(/data-layers="2"/g) ?? []).length, 1);
  assert.match(
    html,
    /<div class="vblock" data-layers="2" data-level="0">[\s\S]*?<button type="button" data-action="deeper"[^>]*>再解一层<\/button><button type="button" data-action="reset" hidden>还原<\/button>/
  );
  // No layer data at all when nothing changes.
  const plain = renderPreviewHtml(parseLpsDocument("line#same:|a#plain:|"), { nonce });
  assert.doesNotMatch(plain, /data-action="deeper"|data-layer="1"|再解一层/);
  // `/!n` and `/n` do not change when decoded again, so they get no button either.
  const stable = renderPreviewHtml(parseLpsDocument("line#a/!nb:|a#/n:|b#/null:|"), { nonce });
  assert.doesNotMatch(stable, /data-action="deeper"|data-layer="1"|再解一层/);
});

test("decode layers of a multi-line value keep the line breaks in every layer", () => {
  const document = parseWithDecoded("line#i:|", { info: "x/!comy\nz" });
  const html = renderPreviewHtml(document, { nonce });

  assert.match(html, /data-layers="3"/);
  assert.match(html, /<div class="vlayer" data-layer="0"><div class="value">x\/!comy\nz<\/div><\/div>/);
  assert.match(html, /<div class="vlayer" data-layer="1" hidden><div class="value">x\/comy\nz<\/div><\/div>/);
  assert.match(html, /<div class="vlayer" data-layer="2" hidden><div class="value">x,y\nz<\/div><\/div>/);
});

test("deep decode layers are limited to eight extra copies in the page", () => {
  const html = renderPreviewHtml(parseLpsDocument("line:|v#/" + "!".repeat(12) + "n:|"), { nonce });

  assert.match(html, /data-layers="9"/);
  assert.equal((html.match(/data-layer="\d"/g) ?? []).length, 9);
  assert.doesNotMatch(html, /data-layer="9"/);
});

test("layer values are html-escaped and a decoded carriage return survives the HTML parser", () => {
  const html = renderPreviewHtml(parseLpsDocument("line:|v#<b>/!r:|r#a/rb:|"), { nonce });

  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /<div class="vlayer" data-layer="0"><div class="value">&lt;b&gt;\/r<\/div><\/div>/);
  // The second pass turns `/r` into a CR, which must be written as a character reference too.
  assert.match(html, /<div class="vlayer" data-layer="1" hidden><div class="value">&lt;b&gt;&#13;<\/div><\/div>/);
  // A raw CR in the markup would be turned into LF by the HTML parser.
  assert.ok(html.includes("a&#13;b"));
  assert.ok(!html.includes("\r"));
});

test("every non-empty value gets a copy button next to its value; buttons only show once the script runs", () => {
  const html = renderPreviewHtml(parseLpsDocument("line#i:|s1#v1:|s2#:|body"), { nonce });

  // info, s1 and text; the empty s2 value has nothing to copy.
  assert.equal((html.match(/<button type="button" data-action="copy">/g) ?? []).length, 3);
  assert.match(html, /<div class="vblock"><div class="value">v1<\/div><button type="button" data-action="copy">复制<\/button><\/div>/);
  // CSS hides the buttons until the script adds the "js" class (and copy needs the VS Code API).
  assert.match(html, /\.vblock > button,\s*\.vblock > \.vlevel \{\s*display: none;/);
  assert.match(html, /\.js \.vblock > button/);
  assert.match(html, /body:not\(\.interactive\) \.vblock > \[data-action="copy"\]/);
});

test("line and sub names carry original-text offsets, also for CRLF documents", () => {
  const text = "first#a:|s1#x:|s2#y:|\r\nsecond#b:|t#c:|";
  const parsed = parseLpsDocument(text);
  const html = renderPreviewHtml(parsed, { nonce });

  for (const line of parsed.lines) {
    assert.ok(html.includes(`<span class="name goto" data-start="${line.range.start}" data-end="${line.range.end}"`));
    for (const sub of line.subs) {
      assert.ok(html.includes(`<span class="goto" data-start="${sub.range.start}" data-end="${sub.range.end}"`));
    }
  }
  const second = parsed.lines[1];
  assert.equal(text.slice(second.range.start, second.range.end), "second#b:|t#c:|");
  assert.equal(text.slice(second.subs[0].range.start, second.subs[0].range.end), "t#c");
});

test("a line without :| gets a warning badge and its text is not shown", () => {
  const html = renderPreviewHtml(parseLpsDocument("loose#info\nok#i:|body\n///just a comment"), { nonce });

  assert.equal((html.match(/<span class="badge warn"[^>]*>缺少 :\|<\/span>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /loose#info/);
  assert.match(html, /<div class="value">info<\/div>/);
  // Only the `ok` line has a Text block.
  assert.equal((html.match(/<div class="label">Text<\/div>/g) ?? []).length, 1);
  assert.match(html, /<div class="value">body<\/div>/);
  const looseSummary = /<summary class="line-summary">([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
  assert.match(looseSummary, />loose<\/span>/);
  assert.match(looseSummary, /缺少 :\|/);
});

test("parsePreviewMessage accepts only the documented messages", () => {
  assert.deepEqual(parsePreviewMessage({ type: "export" }), { type: "export" });
  assert.deepEqual(parsePreviewMessage({ type: "copy", text: "a\r\nb" }), { type: "copy", text: "a\r\nb" });
  assert.deepEqual(parsePreviewMessage({ type: "reveal", start: 3, end: 9, extra: 1 }), { type: "reveal", start: 3, end: 9 });
  assert.deepEqual(parsePreviewMessage({ type: "reveal", start: 4, end: 4 }), { type: "reveal", start: 4, end: 4 });

  const rejected: unknown[] = [
    undefined,
    null,
    "export",
    5,
    {},
    { type: "other" },
    { type: "copy" },
    { type: "copy", text: 1 },
    { type: "reveal" },
    { type: "reveal", start: -1, end: 2 },
    { type: "reveal", start: 5, end: 2 },
    { type: "reveal", start: 1.5, end: 2 },
    { type: "reveal", start: "1", end: 2 },
    { type: "reveal", start: 0, end: Number.POSITIVE_INFINITY },
    { type: "reveal", start: Number.NaN, end: 1 }
  ];
  for (const message of rejected) {
    assert.equal(parsePreviewMessage(message), undefined, JSON.stringify(message));
  }
});

test("planReveal only allows jumping when version and text match the preview snapshot", () => {
  const state = (version: number, text: string, onRead?: () => void) => ({
    version,
    text: () => {
      onRead?.();
      return text;
    }
  });

  assert.deepEqual(planReveal(state(3, "abcdef"), state(3, "abcdef"), 1, 4), { ok: true, start: 1, end: 4 });
  assert.deepEqual(planReveal(state(3, "abcdef"), state(3, "abcdef"), 2, 99), { ok: true, start: 2, end: 6 });
  assert.deepEqual(planReveal(state(3, "abcdef"), state(3, "abcdef"), 99, 100), { ok: true, start: 6, end: 6 });
  // The document was edited after the preview was opened.
  let reads = 0;
  assert.deepEqual(
    planReveal(state(3, "abcdef"), state(4, "abXcdef", () => reads++), 1, 4),
    { ok: false, reason: "stale" }
  );
  assert.equal(reads, 0);
  // Same version number but different text (document closed and reopened from a changed file).
  assert.deepEqual(planReveal(state(1, "abc"), state(1, "abd"), 0, 1), { ok: false, reason: "stale" });
});
