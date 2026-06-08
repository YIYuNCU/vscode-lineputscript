import assert from "node:assert/strict";
import test from "node:test";
import { TextDocument } from "vscode-languageserver-textdocument";
import { formatLpsDocument, toDisplayTree } from "../src/lps/formatter";
import { collectNames, findNodeAtOffset, parseLpsDocument } from "../src/lps/parser";

test("collects line and sub names for completion", () => {
  const parsed = parseLpsDocument("computer:|name#我的电脑:|\nmoney#10500:|");
  const names = collectNames(parsed);

  assert.deepEqual(names, [
    { kind: "line", name: "computer" },
    { kind: "sub", name: "name" },
    { kind: "line", name: "money" }
  ]);
});

test("finds the most specific node at an offset", () => {
  const text = "computer:|name#我的电脑:|";
  const parsed = parseLpsDocument(text);

  assert.equal(findNodeAtOffset(parsed, text.indexOf("computer"))?.kind, "line");
  assert.equal(findNodeAtOffset(parsed, text.indexOf("name"))?.kind, "sub");
});

test("builds display structure for parsed view command", () => {
  const parsed = parseLpsDocument("computer:|name#我的电脑:|");
  const tree = toDisplayTree(parsed) as {
    lineCount: number;
    lines: Array<{ name: string; subs: Array<{ info: string }> }>;
  };

  assert.equal(tree.lineCount, 1);
  assert.equal(tree.lines[0].name, "computer");
  assert.equal(tree.lines[0].subs[0].info, "我的电脑");
});

test("formats full document range content", () => {
  const document = TextDocument.create("file:///test.lps", "lineputscript", 1, "money#10500:|\r\ncomputer:|name#我的电脑:|\n");
  const parsed = parseLpsDocument(document.getText());

  assert.equal(formatLpsDocument(parsed), "money#10500:|\ncomputer:|name#我的电脑:|");
});
