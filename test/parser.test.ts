import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { decodeLpsText, encodeLpsText } from "../src/lps/escape";
import { formatLpsDocument } from "../src/lps/formatter";
import { parseLpsDocument } from "../src/lps/parser";

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8");

const fixtureNames = (): string[] =>
  readdirSync(join(process.cwd(), "test", "fixtures"))
    .filter((name) => name.endsWith(".lps"))
    .sort();

const normalizeLikeCSharpLoad = (text: string): string =>
  text
    .replace(/\r/g, "")
    .split(":\n|").join("/n")
    .split(":\n:").join("")
    .replace(/^\n+|\n+$/g, "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.startsWith("///") ? `:|${line}` : line)
    .join("\n");

test("parses basic lines, subs, text, comments, and UTF-8 content", () => {
  const document = parseLpsDocument(fixture("basic.lps"));

  assert.equal(document.lines.length, 3);
  assert.equal(document.lines[0].name, "money");
  assert.equal(document.lines[0].decodedInfo, "10500");
  assert.equal(document.lines[1].name, "computer");
  assert.equal(document.lines[1].subs[0].name, "name");
  assert.equal(document.lines[1].subs[0].decodedInfo, "我的电脑");
  assert.equal(document.lines[2].subs[0].decodedInfo, "第一行\n第二行");
  assert.equal(document.lines[2].decodedText, "正文\n内容");
  assert.equal(document.lines[2].comments, "注释");
});

test("matches LinePutScript escaping order", () => {
  const value = "a:|b#c,d/e|f\n\t";
  const encoded = encodeLpsText(value);

  assert.equal(encoded, "a:/!|b/idc/comd/!e/!|f/n/tab");
  assert.equal(decodeLpsText(encoded), value);
});

test("handles all decoder escape sequences", () => {
  assert.equal(decodeLpsText("/stop /equ /tab /n /r /id /com /! /|"), ":| = \t \n \r # , / |");
});

test("handles multiline continuation semantics", () => {
  const document = parseLpsDocument(fixture("multiline.lps"));

  assert.equal(document.lines.length, 2);
  assert.equal(document.lines[0].decodedText, " 这是一份文件\n 文件内容包含换行");
  assert.equal(document.lines[1].decodedText, " 这是一段 被软连接的文本");
});

test("formats all fixture documents like the C# loader", () => {
  for (const name of fixtureNames()) {
    const text = fixture(name);
    const original = parseLpsDocument(text);
    assert.equal(formatLpsDocument(original), normalizeLikeCSharpLoad(text), name);
  }
});

test("round-trips all formatted fixture documents through parser", () => {
  for (const name of fixtureNames()) {
    const original = parseLpsDocument(fixture(name));
    const formatted = formatLpsDocument(original);
    const reparsed = parseLpsDocument(formatted);

    assert.deepEqual(
      reparsed.lines.map((line) => ({
        name: line.name,
        info: line.info,
        text: line.text,
        comments: line.comments,
        subs: line.subs.map((sub) => ({ name: sub.name, info: sub.info }))
      })),
      original.lines.map((line) => ({
        name: line.name,
        info: line.info,
        text: line.text,
        comments: line.comments,
        subs: line.subs.map((sub) => ({ name: sub.name, info: sub.info }))
      }))
    );
  }
});

test("reports missing line separator", () => {
  const document = parseLpsDocument("not-a-valid-line");

  assert.equal(document.diagnostics.length, 1);
  assert.equal(document.diagnostics[0].code, "missing-line-separator");
});
