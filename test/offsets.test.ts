import assert from "node:assert/strict";
import test from "node:test";
import { formatLpsDocument } from "../src/lps/formatter";
import { findNodeAtOffset, parseLpsDocument } from "../src/lps/parser";

const slice = (text: string, range: { start: number; end: number }): string => text.slice(range.start, range.end);

test("ranges point into the original text for CRLF documents", () => {
  const text = "money#10500:|\r\ncomputer:|name#我的电脑:|body///note\r\nlast#1:|";
  const document = parseLpsDocument(text);

  assert.equal(document.lines.length, 3);
  assert.equal(slice(text, document.lines[0].range), "money#10500:|");
  assert.equal(slice(text, document.lines[1].nameRange), "computer");
  assert.equal(slice(text, document.lines[1].subs[0].nameRange), "name");
  assert.equal(slice(text, document.lines[1].subs[0].infoRange!), "我的电脑");
  assert.equal(slice(text, document.lines[1].textRange), "body");
  assert.equal(slice(text, document.lines[1].commentRange!), "///note");
  assert.equal(slice(text, document.lines[2].nameRange), "last");
  assert.equal(slice(text, document.lines[2].infoRange!), "1");
});

test("findNodeAtOffset works on later lines of a CRLF document", () => {
  const text = "a#1:|\r\nb#2:|\r\nc:|sub#3:|";
  const document = parseLpsDocument(text);
  const node = findNodeAtOffset(document, text.indexOf("sub"));

  assert.equal(node?.kind, "sub");
  assert.equal(node?.name, "sub");
});

test("continuation lines are merged like LpsDocument.Load and keep original ranges", () => {
  const text = "detail:| first:\n| second\nnext#1:|";
  const document = parseLpsDocument(text);

  assert.equal(document.lines.length, 2);
  assert.equal(document.lines[0].text, " first/n second");
  assert.equal(document.lines[0].decodedText, " first\n second");
  assert.equal(slice(text, document.lines[0].range), "detail:| first:\n| second");
  assert.equal(slice(text, document.lines[1].nameRange), "next");
});

test("overlapping continuation markers follow the C# replace order", () => {
  // C# replaces ":\n|" first, so ":\n:\n|" becomes ":\n/n" and the lone "\n" ends the line.
  const document = parseLpsDocument("a:|x:\n:\n|y\nb:|");

  assert.equal(document.normalizedText, "a:|x:\n/ny\nb:|");
  assert.equal(document.lines.length, 3);
  assert.equal(document.lines[0].text, "x:");
  assert.equal(document.lines[1].name, "/ny");
});

test("stray carriage returns inside a line are ignored like the C# loader", () => {
  const text = "a#1\r2:|";
  const document = parseLpsDocument(text);

  assert.equal(document.lines[0].info, "12");
  assert.equal(slice(text, document.lines[0].infoRange!), "1\r2");
});

test("a line without :| is kept as written by the formatter", () => {
  const document = parseLpsDocument("broken line\nok#1:|");

  assert.equal(document.lines[0].hasSeparator, false);
  assert.equal(formatLpsDocument(document), "broken line\nok#1:|");
});

test("comment-only lines keep the :| prefix when formatted", () => {
  const document = parseLpsDocument("///just a note\nok#1:|");

  assert.equal(document.lines[0].isCommentOnly, true);
  assert.equal(formatLpsDocument(document), ":|///just a note\nok#1:|");
  assert.equal(document.diagnostics.length, 0);
});

test("a second # in info is informational, not a warning", () => {
  const document = parseLpsDocument("a#x#y:|");

  assert.equal(document.lines[0].info, "x#y");
  assert.equal(document.diagnostics.length, 1);
  assert.equal(document.diagnostics[0].severity, "information");
});

test("duplicate names are reported as hints, not diagnostics", () => {
  const document = parseLpsDocument("a#1:|x#1:|x#2:|\na#2:|\n///a#1:|");

  assert.equal(document.diagnostics.length, 0);
  assert.deepEqual(document.hints.map((hint) => hint.code), ["duplicate-sub-name", "duplicate-line-name"]);
  assert.ok(document.hints.every((hint) => hint.severity === "information"));
});
