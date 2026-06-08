import assert from "node:assert/strict";
import test from "node:test";
import { parseLpsDocument } from "../src/lps/parser";
import { renderPreviewHtml } from "../src/lps/preview";

test("preview renders decoded info and text values", () => {
  const parsed = parseLpsDocument("line#hello/nworld:|sub#a/idb:|body/ntext///note");
  const html = renderPreviewHtml(parsed);

  assert.match(html, /hello\s+world/);
  assert.match(html, /a#b/);
  assert.match(html, /body\s+text/);
  assert.match(html, /raw: hello\/nworld/);
});

test("preview applies additional display-only decoding for nested escaped values", () => {
  const parsed = parseLpsDocument("line:|stringlistgetset#a:/!!/!|a,b/!idb,c/!!/!|/!!/!|c:|");
  const html = renderPreviewHtml(parsed);

  assert.match(html, /a:\|a,b#b,c\|\|c/);
  assert.doesNotMatch(html, /a:\/!\|a,b\/idb,c/);
  assert.match(html, /invalid LPS value/);
  assert.match(html, /preview-decoded/);
});

test("preview escapes html in decoded values", () => {
  const parsed = parseLpsDocument("line#<tag>:|sub#\"value\":|");
  const html = renderPreviewHtml(parsed);

  assert.match(html, /&lt;tag&gt;/);
  assert.match(html, /&quot;value&quot;/);
  assert.doesNotMatch(html, /<tag>/);
});
