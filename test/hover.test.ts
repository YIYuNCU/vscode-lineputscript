import assert from "node:assert/strict";
import test from "node:test";
import { buildHoverMarkdown, inlineCode, splitInfoList } from "../src/lps/hover";
import { parseLpsDocument } from "../src/lps/parser";
import { describeValue, formatDotNetTicks } from "../src/lps/valueHints";

test("converts .NET ticks from a real VPet save to a date", () => {
  assert.equal(formatDotNetTicks("638278272000000000"), "2023-08-17 00:00:00");
  assert.equal(formatDotNetTicks("621355968000000000"), "1970-01-01 00:00:00");
});

test("does not treat small or oversized numbers as ticks", () => {
  assert.equal(formatDotNetTicks("419318326884368"), undefined);
  assert.equal(formatDotNetTicks("9999999999999999999"), undefined);
  assert.equal(formatDotNetTicks("12abc"), undefined);
});

test("describes common value shapes", () => {
  assert.match(describeValue("638278272000000000")[0], /Ticks.*2023-08-17 00:00:00/);
  assert.match(describeValue("1768121659892")[0], /Unix 毫秒.*2026-01-11/);
  assert.match(describeValue("1700000000")[0], /Unix 秒.*2023-11-14/);
  assert.deepEqual(describeValue("True"), ["布尔值"]);
  assert.deepEqual(describeValue("788"), ["整数"]);
  assert.deepEqual(describeValue("419318326884368"), ["整数 419,318,326,884,368"]);
  assert.deepEqual(describeValue("637.1773436164934"), ["小数"]);
  assert.deepEqual(describeValue("喵娘"), []);
  assert.deepEqual(describeValue(""), []);
});

test("hover keeps multi-line and backtick values on one code span", () => {
  assert.equal(inlineCode("a\nb"), "` a↵b `");
  assert.equal(inlineCode("a`b"), "`` a`b ``");
  assert.equal(inlineCode(""), "(空)");
  assert.match(inlineCode("x".repeat(500)), /共 500 字符/);
});

test("hover for a line shows decoded info, hint, sub count and text", () => {
  const line = parseLpsDocument("birthday#638278272000000000:|sub#1:|正文/n第二行///注释").lines[0];
  const markdown = buildHoverMarkdown(line);

  assert.match(markdown, /\*\*Line\*\* ` birthday `/);
  assert.match(markdown, /2023-08-17 00:00:00/);
  assert.match(markdown, /Subs: 1/);
  assert.match(markdown, /Text: ` 正文\/n第二行 `/);
  assert.match(markdown, /Comments: ` 注释 `/);
});

test("hover lists comma separated info items like Sub.GetInfos", () => {
  assert.deepEqual(splitInfoList("item1,,item2/com3"), ["item1", "item2,3"]);

  const sub = parseLpsDocument("line:|goods#item1,item2,item3:|").lines[0].subs[0];
  assert.ok(buildHoverMarkdown(sub).includes("列表项 (3): ` item1 ` , ` item2 ` , ` item3 `"));
});
