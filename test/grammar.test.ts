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

test("grammar key patterns allow colon before the real :| separator", () => {
  const grammarPath = join(process.cwd(), "syntaxes", "lineputscript.tmLanguage.json");
  const grammar = JSON.parse(readFileSync(grammarPath, "utf8")) as {
    repository: {
      "line-name": { patterns: Array<{ match: string }> };
      "sub-name": { patterns: Array<{ match: string }> };
      "info-value": { patterns: Array<{ patterns: Array<{ match?: string }> }> };
    };
  };

  const lineNamePattern = new RegExp(grammar.repository["line-name"].patterns[0].match);
  const subNamePattern = new RegExp(grammar.repository["sub-name"].patterns[0].match);
  const infoPattern = new RegExp(grammar.repository["info-value"].patterns[0].patterns[1].match ?? "");

  assert.equal(lineNamePattern.exec("graph:idle#value:|")?.[1], "graph:idle");
  assert.equal(subNamePattern.exec(":|path:main#value:|")?.[1], "path:main");
  assert.equal(infoPattern.exec("http://example.com")?.[0], "http:");
}
);

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
    "打开预览"
  ]);
  assert.equal(zh["command.escapeSelection.title"], "转义选中内容");
});
