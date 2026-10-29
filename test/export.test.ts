import assert from "node:assert/strict";
import test from "node:test";
import { escapeCsvField, exportFormatExtensions, exportParsed, lineBodyText, lineRawBodyText } from "../src/lps/export";
import { parseLpsDocument } from "../src/lps/parser";

const sample = [
  "///文件头注释",
  "吃饭#主线/n第二行:|苹果#3/com4:|香蕉#a\"b:|正文/ntext///行尾注释",
  "empty#:|",
  "你好#世界:|名字#小明:|"
].join("\n");

test("json export contains decoded values, comments and no raw fields by default", () => {
  const parsed = parseLpsDocument(sample);
  const data = JSON.parse(exportParsed(parsed, "json")) as {
    lineCount: number;
    lines: Array<{ name: string; info: string; text: string; comments: string; subs: Array<{ name: string; info: string }> }>;
  };

  assert.equal(data.lineCount, 4);
  assert.deepEqual(data.lines[0], { name: "", info: "", text: "", comments: "文件头注释", subs: [] });
  assert.deepEqual(data.lines[1], {
    name: "吃饭",
    info: "主线\n第二行",
    text: "正文\ntext",
    comments: "行尾注释",
    subs: [
      { name: "苹果", info: "3,4" },
      { name: "香蕉", info: "a\"b" }
    ]
  });
  assert.deepEqual(data.lines[2].subs, []);
  assert.equal(data.lines[3].name, "你好");
  assert.equal(data.lines[3].subs[0].info, "小明");
});

test("json export is indented with two spaces and keeps non-ASCII text readable", () => {
  const json = exportParsed(parseLpsDocument("你好#世界:|"), "json");

  assert.match(json, /^\{\n {2}"lineCount": 1,\n {2}"lines": \[\n {4}\{/);
  assert.ok(json.includes("\"世界\""));
  assert.doesNotMatch(json, /\\u/);
});

test("json export can include raw values when requested", () => {
  const parsed = parseLpsDocument("a#x/id:|s#y/com:|t/n");
  const plain = JSON.parse(exportParsed(parsed, "json")) as { lines: Array<Record<string, unknown>> };
  const withRaw = JSON.parse(exportParsed(parsed, "json", { includeRaw: true })) as {
    lines: Array<{ info: string; rawInfo: string; rawText: string; subs: Array<{ info: string; rawInfo: string }> }>;
  };

  assert.equal("rawInfo" in plain.lines[0], false);
  assert.equal("rawText" in plain.lines[0], false);
  assert.equal(withRaw.lines[0].info, "x#");
  assert.equal(withRaw.lines[0].rawInfo, "x/id");
  assert.equal(withRaw.lines[0].rawText, "t/n");
  assert.equal(withRaw.lines[0].subs[0].info, "y,");
  assert.equal(withRaw.lines[0].subs[0].rawInfo, "y/com");
});

test("json export of an empty document", () => {
  assert.deepEqual(JSON.parse(exportParsed(parseLpsDocument(""), "json")), { lineCount: 0, lines: [] });
});

test("csv export has one row per sub and one row for lines without subs", () => {
  const csv = exportParsed(parseLpsDocument(sample), "csv");
  const rows = csv.split("\r\n");

  assert.equal(rows[0], "line,lineInfo,sub,subInfo,text,comments");
  assert.ok(csv.endsWith("\r\n"));
  assert.ok(!csv.startsWith(String.fromCharCode(0xfeff)));
  assert.equal(rows[1], ",,,,,文件头注释");
  // The multi-line cells make the 吃饭 rows span several physical rows; compare as a whole.
  assert.ok(csv.includes("\r\n吃饭,\"主线\n第二行\",苹果,\"3,4\","));
});

test("csv export escapes commas, quotes and newlines per RFC 4180", () => {
  const parsed = parseLpsDocument("l#a/com,b:|s#say \"hi\":|c/nd///x,y");
  const csv = exportParsed(parsed, "csv");

  assert.equal(
    csv,
    "line,lineInfo,sub,subInfo,text,comments\r\n"
    + "l,\"a,,b\",s,\"say \"\"hi\"\"\",\"c\nd\",\"x,y\"\r\n"
  );
});

test("csv export parses back to the same cells", () => {
  const csv = exportParsed(parseLpsDocument(sample), "csv");
  const records = parseCsv(csv);

  assert.deepEqual(records[0], ["line", "lineInfo", "sub", "subInfo", "text", "comments"]);
  assert.deepEqual(records[1], ["", "", "", "", "", "文件头注释"]);
  assert.deepEqual(records[2], ["吃饭", "主线\n第二行", "苹果", "3,4", "正文\ntext", "行尾注释"]);
  assert.deepEqual(records[3], ["吃饭", "主线\n第二行", "香蕉", "a\"b", "正文\ntext", "行尾注释"]);
  assert.deepEqual(records[4], ["empty", "", "", "", "", ""]);
  assert.deepEqual(records[5], ["你好", "世界", "名字", "小明", "", ""]);
  assert.equal(records.length, 6);
});

test("csv field escaping only quotes when needed", () => {
  assert.equal(escapeCsvField("plain"), "plain");
  assert.equal(escapeCsvField("中文"), "中文");
  assert.equal(escapeCsvField("a,b"), "\"a,b\"");
  assert.equal(escapeCsvField("a\"b"), "\"a\"\"b\"");
  assert.equal(escapeCsvField("a\nb"), "\"a\nb\"");
  assert.equal(escapeCsvField("a\rb"), "\"a\rb\"");
  assert.equal(escapeCsvField(""), "");
});

test("csv export of an empty document contains only the header", () => {
  assert.equal(exportParsed(parseLpsDocument(""), "csv"), "line,lineInfo,sub,subInfo,text,comments\r\n");
});

test("txt export is readable and keeps comments and multi-line values aligned", () => {
  const txt = exportParsed(parseLpsDocument(sample), "txt");

  assert.equal(txt, [
    "/// 文件头注释",
    "",
    "[吃饭] 主线",
    "  第二行",
    "  苹果 = 3,4",
    "  香蕉 = a\"b",
    "  text: 正文",
    "    text",
    "  /// 行尾注释",
    "",
    "[empty]",
    "",
    "[你好] 世界",
    "  名字 = 小明",
    ""
  ].join("\n"));
});

test("txt export indents continuation lines of sub values and comments", () => {
  const txt = exportParsed(parseLpsDocument("a#:|s#x/ny/rz:|"), "txt");

  assert.equal(txt, "[a]\n  s = x\n    y\n    z\n");
  assert.equal(exportParsed(parseLpsDocument(""), "txt"), "");
});

test("export extensions match the formats", () => {
  assert.deepEqual(exportFormatExtensions, { json: ".json", csv: ".csv", txt: ".txt" });
  assert.throws(() => exportParsed(parseLpsDocument("a#b:|"), "xml" as never));
});

// Minimal RFC 4180 reader used to check the writer round-trips.
function parseCsv(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === "\"" && input[index + 1] === "\"") {
        field += "\"";
        index++;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\r" && input[index + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      index++;
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const looseSample = "loose#a/nb\nok#i:|s#v:|body";

test("a line without :| exports an empty text in json, csv and txt", () => {
  const parsed = parseLpsDocument(looseSample);
  assert.equal(parsed.lines[0].hasSeparator, false);
  // The parser keeps the C# quirk (text is the whole line); the exporters must not use it.
  assert.notEqual(parsed.lines[0].decodedText, "");

  const data = JSON.parse(exportParsed(parsed, "json", { includeRaw: true })) as {
    lines: Array<{ name: string; info: string; text: string; rawInfo: string; rawText: string }>;
  };
  assert.equal(data.lines[0].name, "loose");
  assert.equal(data.lines[0].info, "a\nb");
  assert.equal(data.lines[0].text, "");
  assert.equal(data.lines[0].rawInfo, "a/nb");
  assert.equal(data.lines[0].rawText, "");
  assert.equal(data.lines[1].text, "body");
  assert.equal(data.lines[1].rawText, "body");

  const records = parseCsv(exportParsed(parsed, "csv"));
  assert.deepEqual(records[1], ["loose", "a\nb", "", "", "", ""]);
  assert.deepEqual(records[2], ["ok", "i", "s", "v", "body", ""]);

  const txt = exportParsed(parsed, "txt");
  assert.equal(txt, [
    "[loose] a",
    "  b",
    "",
    "[ok] i",
    "  s = v",
    "  text: body",
    ""
  ].join("\n"));
  assert.ok(!txt.includes("loose#"));
});

test("lineBodyText and lineRawBodyText hide the text of lines without a separator", () => {
  const [loose, ok] = parseLpsDocument(looseSample).lines;

  assert.equal(lineBodyText(loose), "");
  assert.equal(lineRawBodyText(loose), "");
  assert.equal(lineBodyText(ok), "body");
  assert.equal(lineRawBodyText(ok), "body");
});
