import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("grammar declares info and text value scopes", () => {
  const grammarPath = join(process.cwd(), "syntaxes", "lineputscript.tmLanguage.json");
  const grammar = JSON.parse(readFileSync(grammarPath, "utf8")) as {
    repository: Record<string, unknown>;
  };
  const serialized = JSON.stringify(grammar);

  assert.ok(grammar.repository["info-value"]);
  assert.ok(grammar.repository["text-value"]);
  assert.match(serialized, /string\.unquoted\.info\.lineputscript/);
  assert.match(serialized, /string\.unquoted\.text\.lineputscript/);
});

// ---------------------------------------------------------------------------
// A small TextMate interpreter that is just enough for this grammar: flat `match` rules,
// `captures` with optional nested `patterns`, and `include` of repository entries.
// It runs the grammar's regexes with JS RegExp, so Oniguruma-only syntax would throw here.
// The grammar only uses constructs that mean the same in both engines (lookahead, lookbehind
// with alternatives, non-capturing groups, `^`/`$`). Known engine difference that is
// emulated: vscode-textmate re-tokenizes a capture on `line.substring(0, captureEnd)`.
// ---------------------------------------------------------------------------
interface TmRule {
  include?: string;
  match?: string;
  name?: string;
  captures?: Record<string, { name?: string; patterns?: TmRule[] }>;
  patterns?: TmRule[];
}

interface TmGrammar {
  patterns: TmRule[];
  repository: Record<string, TmRule>;
}

function loadGrammar(): TmGrammar {
  const grammarPath = join(process.cwd(), "syntaxes", "lineputscript.tmLanguage.json");
  return JSON.parse(readFileSync(grammarPath, "utf8")) as TmGrammar;
}

function flattenRules(grammar: TmGrammar, rules: TmRule[], keepFastPath = true): TmRule[] {
  const result: TmRule[] = [];
  for (const rule of rules) {
    if (rule.include) {
      const target = grammar.repository[rule.include.replace(/^#/, "")];
      assert.ok(target, `unknown include ${rule.include}`);
      result.push(...flattenRules(grammar, target.patterns ?? [target], keepFastPath));
    } else if (rule.match !== undefined) {
      result.push(rule);
    }
  }
  // Rules marked as fast paths come first in each group; `keepFastPath=false` drops every rule
  // whose fast-path twin shares its captures' scope names (used to check both paths agree).
  return keepFastPath ? result : result.filter((rule) => !isFastPath(rule));
}

function isFastPath(rule: TmRule): boolean {
  const infoCapture = rule.captures?.["3"];
  const textCapture = rule.captures?.["1"];
  if (infoCapture?.name?.includes("string.unquoted.info")) {
    return infoCapture.patterns === undefined;
  }
  if (textCapture?.name === "string.unquoted.text.lineputscript") {
    return textCapture.patterns === undefined;
  }
  return false;
}

interface Piece {
  text: string;
  scope: string;
}

function tokenize(grammar: TmGrammar, line: string, keepFastPath = true): Piece[] {
  const scopes: string[][] = Array.from({ length: line.length }, () => []);
  tokenizeRange(grammar, flattenRules(grammar, grammar.patterns, keepFastPath), line + "\n", 0, line.length, scopes, keepFastPath);
  const pieces: Piece[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const scope = scopes[index].join(" ").replace(/\.lineputscript/g, "");
    const last = pieces[pieces.length - 1];
    if (last && last.scope === scope) {
      last.text += line[index];
    } else {
      pieces.push({ text: line[index], scope });
    }
  }
  return pieces;
}

function tokenizeRange(
  grammar: TmGrammar,
  rules: TmRule[],
  text: string,
  start: number,
  end: number,
  scopes: string[][],
  keepFastPath: boolean
): void {
  const regexes = rules.map((rule) => new RegExp(rule.match ?? "", "dgm"));
  let position = start;
  while (position < end) {
    let best: { rule: TmRule; match: RegExpExecArray } | undefined;
    regexes.forEach((regex, index) => {
      regex.lastIndex = position;
      const match = regex.exec(text);
      if (match && match.index < end && (!best || match.index < best.match.index)) {
        best = { rule: rules[index], match };
      }
    });
    if (!best) {
      return;
    }
    const { rule, match } = best as { rule: TmRule; match: RegExpExecArray };
    const matchEnd = match.index + match[0].length;
    assert.ok(matchEnd > position, `zero-length match from ${rule.match}`);
    const indices = match.indices as unknown as Array<[number, number] | undefined>;
    if (rule.name) {
      for (let index = match.index; index < matchEnd; index += 1) {
        scopes[index].push(...rule.name.split(" "));
      }
    }
    for (const [group, capture] of Object.entries(rule.captures ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const range = indices[Number(group)];
      if (!range || range[0] === range[1]) {
        continue;
      }
      for (let index = range[0]; index < range[1]; index += 1) {
        scopes[index].push(...(capture.name ? capture.name.split(" ") : []));
      }
      if (capture.patterns) {
        // vscode-textmate re-tokenizes a capture on the line prefix that ends at the capture.
        tokenizeRange(grammar, flattenRules(grammar, capture.patterns, keepFastPath), text.slice(0, range[1]), range[0], range[1], scopes, keepFastPath);
      }
    }
    position = matchEnd;
  }
}

/** Compact view: "text|scope" pairs. */
function view(pieces: Piece[]): string[] {
  return pieces.map((piece) => `${piece.text}|${piece.scope}`);
}

const LINE = "entity.name.tag.line";
const SUB = "variable.parameter.sub";
const INFO = "meta.info string.unquoted.info";
const TEXT = "string.unquoted.text";
const ESC = "constant.character.escape";
const KV = "meta.info punctuation.separator.key-value";
const SEP = "punctuation.separator.entry";
const COMMENT = "comment.line.triple-slash";

test("grammar key patterns allow colon before the real :| separator", () => {
  const grammar = loadGrammar();
  const lineNamePattern = new RegExp(grammar.repository["line-name"].patterns?.[0].match ?? "");
  const subNamePattern = new RegExp(grammar.repository["sub-name"].patterns?.[0].match ?? "");

  assert.equal(lineNamePattern.exec("graph:idle#value:|")?.[1], "graph:idle");
  assert.equal(subNamePattern.exec("k:|path:main#value:|")?.[1], "path:main");
  assert.deepEqual(view(tokenize(grammar, "a#http://example.com:|")), [
    `a|${LINE}`,
    `#|${KV}`,
    `http://example.com|${INFO}`,
    `:||${SEP}`
  ]);
});

test("grammar does not treat escape-looking text in line and sub names as escapes", () => {
  const grammar = loadGrammar();

  assert.deepEqual(view(tokenize(grammar, "a/n/id#v:|s/n/stop#w:|t")), [
    `a/n/id|${LINE}`,
    `#|${KV}`,
    `v|${INFO}`,
    `:||${SEP}`,
    `s/n/stop|${SUB}`,
    `#|${KV}`,
    `w|${INFO}`,
    `:||${SEP}`,
    `t|${TEXT}`
  ]);
  // Same without info, and a name made only of slashes and colons.
  assert.deepEqual(view(tokenize(grammar, "/n:|/id:|")), [`/n|${LINE}`, `:||${SEP}`, `/id|${SUB}`, `:||${SEP}`]);
  assert.deepEqual(view(tokenize(grammar, "a:b/c:|")), [`a:b/c|${LINE}`, `:||${SEP}`]);
});

test("grammar highlights escapes only inside info and text values", () => {
  const grammar = loadGrammar();

  assert.deepEqual(view(tokenize(grammar, "k#a/nb/id/stop/!|c:|s#/com/equ:|x/tab/r/!y/|z")), [
    `k|${LINE}`,
    `#|${KV}`,
    `a|${INFO}`,
    `/n|${INFO} ${ESC}`,
    `b|${INFO}`,
    `/id/stop/!||${INFO} ${ESC}`,
    `c|${INFO}`,
    `:||${SEP}`,
    `s|${SUB}`,
    `#|${KV}`,
    `/com/equ|${INFO} ${ESC}`,
    `:||${SEP}`,
    `x|${TEXT}`,
    `/tab/r/!|${TEXT} ${ESC}`,
    `y|${TEXT}`,
    `/||${TEXT} ${ESC}`,
    `z|${TEXT}`
  ]);
  // The C# decoder replaces "/n" anywhere, so "/null" and "/name" start with the /n escape.
  assert.deepEqual(view(tokenize(grammar, "k#/null:|/name")), [
    `k|${LINE}`,
    `#|${KV}`,
    `/n|${INFO} ${ESC}`,
    `ull|${INFO}`,
    `:||${SEP}`,
    `/n|${TEXT} ${ESC}`,
    `ame|${TEXT}`
  ]);
  // A lone slash, "//" and an unknown escape stay plain value text.
  assert.deepEqual(view(tokenize(grammar, "k#a/b//c/x:|")), [`k|${LINE}`, `#|${KV}`, `a/b//c/x|${INFO}`, `:||${SEP}`]);
});

test("grammar cuts info, text and names at the first ///", () => {
  const grammar = loadGrammar();

  assert.deepEqual(view(tokenize(grammar, "k#a/n///c:|d")), [
    `k|${LINE}`,
    `#|${KV}`,
    `a|${INFO}`,
    `/n|${INFO} ${ESC}`,
    `///c:|d|${COMMENT}`
  ]);
  assert.deepEqual(view(tokenize(grammar, "k:|s#v:|t/n///c/n")), [
    `k|${LINE}`,
    `:||${SEP}`,
    `s|${SUB}`,
    `#|${KV}`,
    `v|${INFO}`,
    `:||${SEP}`,
    `t|${TEXT}`,
    `/n|${TEXT} ${ESC}`,
    `///c/n|${COMMENT}`
  ]);
  // A :| after /// belongs to the comment, so the entry before it is the text.
  assert.deepEqual(view(tokenize(grammar, "k:|t///x:|y")), [`k|${LINE}`, `:||${SEP}`, `t|${TEXT}`, `///x:|y|${COMMENT}`]);
  assert.deepEqual(view(tokenize(grammar, "name///c#d:|")), [`name|${LINE}`, `///c#d:||${COMMENT}`]);
  assert.deepEqual(view(tokenize(grammar, "k:|s///c:|t")), [`k|${LINE}`, `:||${SEP}`, `s|${TEXT}`, `///c:|t|${COMMENT}`]);
  // "////" starts the comment at its first slash.
  assert.deepEqual(view(tokenize(grammar, "k#a////b")), [`k|${LINE}`, `#|${KV}`, `a|${INFO}`, `////b|${COMMENT}`]);
});

test("grammar handles comment-only lines, missing separators, empty names and empty subs", () => {
  const grammar = loadGrammar();

  assert.deepEqual(view(tokenize(grammar, "///only a comment")), [`///only a comment|${COMMENT}`]);
  assert.deepEqual(view(tokenize(grammar, "")), []);
  assert.deepEqual(view(tokenize(grammar, "no separator here")), [`no separator here|${LINE}`]);
  assert.deepEqual(view(tokenize(grammar, "name#info only")), [`name|${LINE}`, `#|${KV}`, `info only|${INFO}`]);
  // Empty line name with info, and with nothing at all.
  assert.deepEqual(view(tokenize(grammar, "#info:|")), [`#|${KV}`, `info|${INFO}`, `:||${SEP}`]);
  assert.deepEqual(view(tokenize(grammar, ":|text")), [`:||${SEP}`, `text|${TEXT}`]);
  // Empty subs and empty info.
  assert.deepEqual(view(tokenize(grammar, "a:|:|:|")), [`a|${LINE}`, `:|:|:||${SEP}`]);
  assert.deepEqual(view(tokenize(grammar, "a#:|#x:|")), [`a|${LINE}`, `#|${KV}`, `:||${SEP}`, `#|${KV}`, `x|${INFO}`, `:||${SEP}`]);
  // Only the first # separates name and info; later # characters are info content, or plain text.
  assert.deepEqual(view(tokenize(grammar, "a#b#c:|d#e#f:|g#h")), [
    `a|${LINE}`,
    `#|${KV}`,
    `b#c|${INFO}`,
    `:||${SEP}`,
    `d|${SUB}`,
    `#|${KV}`,
    `e#f|${INFO}`,
    `:||${SEP}`,
    `g#h|${TEXT}`
  ]);
  // Colons that are not followed by | stay inside values and names.
  assert.deepEqual(view(tokenize(grammar, "a:#b:c:|d:e:|f:g|h")), [
    `a:|${LINE}`,
    `#|${KV}`,
    `b:c|${INFO}`,
    `:||${SEP}`,
    `d:e|${SUB}`,
    `:||${SEP}`,
    `f:g|h|${TEXT}`
  ]);
});

test("grammar treats continuation lines as value text without inventing a line name", () => {
  const grammar = loadGrammar();

  // ":\n|" and ":\n:" joins: the second physical line starts with | or a lone :.
  assert.deepEqual(view(tokenize(grammar, "| more/ntext")), [
    `||`,
    ` more|${TEXT}`,
    `/n|${TEXT} ${ESC}`,
    `text|${TEXT}`
  ]);
  assert.deepEqual(view(tokenize(grammar, ": soft wrapped")), [`:|`, ` soft wrapped|${TEXT}`]);
  assert.deepEqual(view(tokenize(grammar, "| tail:|sub#1:|end")), [
    `||`,
    ` tail|${SUB}`,
    `:||${SEP}`,
    `sub|${SUB}`,
    `#|${KV}`,
    `1|${INFO}`,
    `:||${SEP}`,
    `end|${TEXT}`
  ]);
});

/** Independent model of Line.Load: split off the first ///, split by :|, split name/info at the first #. */
function modelCategories(line: string): string {
  const categories = new Array<string>(line.length).fill("?");
  const commentStart = line.indexOf("///");
  const bodyEnd = commentStart < 0 ? line.length : commentStart;
  for (let index = bodyEnd; index < line.length; index += 1) {
    categories[index] = "C";
  }
  const body = line.slice(0, bodyEnd);
  const entries: Array<[number, number]> = [];
  let start = 0;
  for (;;) {
    const found = body.indexOf(":|", start);
    if (found < 0) {
      entries.push([start, body.length]);
      break;
    }
    entries.push([start, found]);
    categories[found] = "P";
    categories[found + 1] = "P";
    start = found + 2;
  }
  const escapes = /\/(?:stop|equ|tab|n|r|id|com|!\||!|\|)/g;
  const markValue = (from: number, to: number, plain: string, escaped: string): void => {
    categories.fill(plain, from, to);
    escapes.lastIndex = 0;
    const value = body.slice(from, to);
    let match: RegExpExecArray | null;
    while ((match = escapes.exec(value))) {
      categories.fill(escaped, from + match.index, from + match.index + match[0].length);
    }
  };
  entries.forEach(([from, to], index) => {
    if (index === entries.length - 1 && entries.length > 1) {
      markValue(from, to, "T", "t");
      return;
    }
    const hash = body.slice(from, to).indexOf("#");
    const nameEnd = hash < 0 ? to : from + hash;
    categories.fill(index === 0 ? "N" : "S", from, nameEnd);
    if (hash >= 0) {
      categories[nameEnd] = "K";
      markValue(nameEnd + 1, to, "I", "i");
    }
  });
  return categories.join("");
}

function grammarCategories(pieces: Piece[]): string {
  return pieces
    .map((piece) => {
      let category = "?";
      if (piece.scope.includes("comment.line")) category = "C";
      else if (piece.scope.includes("constant.character.escape")) category = piece.scope.includes("string.unquoted.text") ? "t" : "i";
      else if (piece.scope.includes("entity.name.tag.line")) category = "N";
      else if (piece.scope.includes("variable.parameter.sub")) category = "S";
      else if (piece.scope.includes("punctuation.separator.entry")) category = "P";
      else if (piece.scope.includes("punctuation.separator.key-value")) category = "K";
      else if (piece.scope.includes("string.unquoted.info")) category = "I";
      else if (piece.scope.includes("string.unquoted.text")) category = "T";
      return category.repeat(piece.text.length);
    })
    .join("");
}

test("grammar agrees with a model of Line.Load on generated lines, with and without the fast path", () => {
  const grammar = loadGrammar();
  const fragments = [
    "a", "b", "#", ":", "|", ":|", "/", "//", "///", "/n", "/stop", "/id", "/!", "/!|", "/|", "n", "s", " ", "\u65e5",
    "/tab", "/com", "/equ", "/r", "/na", "x#y", "k:|", "v#1:|"
  ];
  let seed = 20240607;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let checked = 0;
  for (let round = 0; round < 4000; round += 1) {
    let line = "";
    const count = 1 + Math.floor(random() * 14);
    for (let index = 0; index < count; index += 1) {
      line += fragments[Math.floor(random() * fragments.length)];
    }
    if (line.startsWith("|") || /^:(?!\|)/.test(line)) {
      continue; // continuation lines are covered by their own test
    }
    checked += 1;
    const full = tokenize(grammar, line);
    assert.equal(grammarCategories(full), modelCategories(line), `categories for ${JSON.stringify(line)}`);
    assert.deepEqual(tokenize(grammar, line, false), full, `slow path for ${JSON.stringify(line)}`);
  }
  assert.ok(checked > 3000);
});

test("grammar patterns stay linear on very long lines", () => {
  const grammar = loadGrammar();
  const long = (text: string): string => text.repeat(Math.ceil(16000 / text.length));
  const lines = [
    // A save-file style line: hundreds of subs, with and without escapes.
    "pet#hp:|" + "key#value1:|".repeat(600) + "tail",
    "pet#hp:|" + "key#v/nalue/id1:|".repeat(500) + "tail/n",
    long("abc:def/g "),
    long("a#"),
    "k#" + long(":x"),
    "k#" + long("/"),
    "k:|" + long("/"),
    "k:|" + long("#"),
    "k:|" + long("word /x # : | "),
    long(":|"),
    long("#:|"),
    long("s#v:|") + "///" + long("x:|")
  ];
  const started = Date.now();
  for (const line of lines) {
    const pieces = tokenize(grammar, line);
    assert.equal(pieces.map((piece) => piece.text).join(""), line);
  }
  // Catastrophic backtracking would take minutes; a linear grammar needs well under a second.
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started}ms`);
});

test("published extension keeps runtime dependencies and activates every command", () => {
  const ignorePath = join(process.cwd(), ".vscodeignore");
  const packagePath = join(process.cwd(), "package.json");
  const ignore = readFileSync(ignorePath, "utf8");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
    activationEvents: string[];
    contributes: {
      commands: Array<{ command: string }>;
      menus: Record<string, Array<{ command?: string; submenu?: string }>>;
      submenus: Array<{ id: string; label: string }>;
    };
  };

  assert.match(ignore, /^node_modules\/\*\*$/m);
  assert.match(ignore, /^\*\.vsix$/m);
  assert.match(ignore, /^package-lock\.json$/m);
  assert.match(ignore, /^out\/test\/\*\*$/m);
  assert.ok(existsSync(join(process.cwd(), "out", "src", "extension.js")));
  assert.ok(existsSync(join(process.cwd(), "out", "src", "server.js")));

  for (const command of manifest.contributes.commands) {
    assert.ok(
      manifest.activationEvents.includes(`onCommand:${command.command}`) || manifest.activationEvents.includes("onLanguage:lineputscript"),
      `${command.command} must activate the extension`
    );
  }

  assert.ok(manifest.contributes.submenus.some((submenu) => submenu.id === "lineputscript"));
  assert.ok(manifest.contributes.menus["editor/context"].some((item) => item.submenu === "lineputscript"));

  const submenuCommands = new Set((manifest.contributes.menus.lineputscript ?? []).map((item) => item.command));
  for (const command of manifest.contributes.commands) {
    assert.ok(submenuCommands.has(command.command), `${command.command} must be in the LinePutScript submenu`);
  }

  const topLevelContextCommands = manifest.contributes.menus["editor/context"]
    .filter((item) => item.command?.startsWith("lineputscript."));
  assert.equal(topLevelContextCommands.length, 0);
});

test("package manifest exposes Chinese command titles directly", () => {
  const packagePath = join(process.cwd(), "package.json");
  const zhPath = join(process.cwd(), "package.nls.zh-cn.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
    description: string;
    contributes: {
      commands: Array<{ title: string }>;
    };
  };
  const zh = JSON.parse(readFileSync(zhPath, "utf8")) as Record<string, string>;
  const titles = manifest.contributes.commands.map((command) => command.title);

  assert.equal(manifest.description, "为 LinePutScript .lps 文件提供语言支持。");
  assert.deepEqual(titles, [
    "转义选中内容",
    "反转义选中内容",
    "格式化文档",
    "显示解析结构",
    "打开预览",
    "导出解析后内容"
  ]);
  assert.equal(zh["command.escapeSelection.title"], "转义选中内容");
  assert.equal(zh["command.exportParsed.title"], "导出解析后内容");
});
