# LinePutScript VS Code 插件说明

该插件为 `.lps` 文件提供 LinePutScript 编辑支持。插件工程内新增文件均按 UTF-8 保存，测试夹具包含中文内容，用于防止编码回退。

## 文件识别

- 自动识别 `.lps` 文件。
- 可在 VS Code 语言选择器中手动选择 `LinePutScript`。

## 语法高亮

插件通过 TextMate grammar 提供基础高亮：

- Line 名称：例如 `money#10500:|` 中的 `money`。
- Sub 名称：例如 `computer:|name#我的电脑:|` 中的 `name`。
- Info 值：`#` 后、`:|` 前的内容，例如 `10500`、`我的电脑`。
- Text 值：一行最后一个 `:|` 后、`///` 注释前的文本。
- 转义序列只在 Info 和 Text 中高亮；Line/Sub 名称与 C# 库一致，不做反转义，因此不高亮转义。
- 分隔符：`#` 和 `:|`。
- 注释：`///` 后的内容。
- 转义序列：`/stop`、`/id`、`/n`、`/tab`、`/com`、`/!`、`/|` 等。

常用 scope：

- `entity.name.tag.line.lineputscript`
- `variable.parameter.sub.lineputscript`
- `string.unquoted.info.lineputscript`
- `string.unquoted.text.lineputscript`
- `punctuation.separator.key-value.lineputscript`
- `punctuation.separator.entry.lineputscript`
- `comment.line.triple-slash.lineputscript`
- `constant.character.escape.lineputscript`

## 语言服务功能

- 诊断：提示缺少 `:|`、名称为空等结构问题。Info 中出现第二个 `#` 仅作提示（C# 只按第一个 `#` 切分，仍能正确读取）。
- 重复项提示（提示级，默认开启，可用 `lineputscript.diagnostics.hints` 关闭）：重复的 Line 名称、同一 Line 内重复的 Sub 名称。LPS 允许重复（列表式用法），但按字典读取（`Line_D` / `LPS_D`）时只会保留其中一个。
- Hover：显示当前 Line/Sub 的名称、反转义后的 Info、Text 和注释；多行或很长的值会压缩成单行摘要。以逗号分隔的 Info 会列出列表项（同 `Sub.GetInfos()`）。对 .NET Ticks（如 `638278272000000000`）、Unix 时间戳、布尔、整数、小数给出类型提示。
- 补全：提供当前文档已出现的 Line/Sub 名称和常用转义序列。
- 文档大纲：按 Line 展示顶层节点，Sub 作为子节点展示。
- 折叠：支持跨行逻辑行的折叠范围。
- 格式化：按现有 C# `LpsDocument.ToString()` 风格规范化文档。

## 命令

- `LinePutScript: Escape Selection`：转义选中文本。
- `LinePutScript: Unescape Selection`：反转义选中文本。
- `LinePutScript: Format Document`：格式化当前文档。
- `LinePutScript: Show Parsed Structure`：在侧边打开当前文档的解析结构 JSON。
- `LinePutScript: Open Preview`：在侧边打开预览模式，预览中会显示反转义后的 Info 和 Text，同时保留 Raw Info 便于对照。每个 Line 可以折叠，较长的 Line（子项多或内容长）默认折叠；过长的值只显示片段并可展开；工具栏提供全部展开/折叠、搜索过滤（匹配名称与解码后的值并高亮）和导出；可复制解码后的值，点击名称跳转到源码。
- `LinePutScript: Export Parsed Content`：把解析并反转义后的内容导出为 JSON、CSV（带 UTF-8 BOM，便于 Excel 打开）或可读文本。预览工具栏中的“导出”按钮效果相同。

编辑器右键菜单中只显示一个 `LinePutScript` 子菜单，所有命令都收纳在该子菜单下。`Show Parsed Structure` 使用只读 Webview 展示 JSON，不创建临时 JSON 文件，因此关闭时不会触发保存提示。

预览、悬停、导出等显示内容只做一次反转义（对应 `Sub.TextDeReplace`），并且 **`/n` 一律不解码**，原样保留（包括 `/null`、`/name` 这类以 `/n` 开头的写法）。换行会破坏“一行一条记录”的数据结构，而 C# 的顺序替换还会把 `/null` 解成“换行 + ull”，破坏内容；其余转义（`/stop`、`/id`、`/com`、`/tab`、`/r`、`/!`、`/|`、`/equ`）照常解码。存为 `/!n` 的字面 `/n` 也显示为 `/n`，不会再被解码。“反转义选中内容”命令同样保留 `/n`；“转义选中内容”仍会把真实换行写成 `/n`。需要查看嵌套存储的值（List/Dictionary 等）时，可点击值旁边的“再解一层”按钮，逐层额外解码，默认不启用。

## 与 C# 库的一致性

解析规则逐条对照 `LpsDocument.Load` / `Line.Load` / `Sub.TextDeReplace`：先删除全部 `\r`，再依次把 `:\n|` 替换为 `/n`、把 `:\n:` 删除（两次顺序替换，不是一次扫描），按 `\n` 切行并丢弃空行，行内先按第一个 `///` 切出注释，再按 `:|` 切分。所有范围（诊断、折叠、Hover、跳转）都指向原始文本，CRLF 文件也一样。

以下行为是 C# 库本身的特点，插件照搬：

- 反转义是顺序替换，`/tabs` 会解成“Tab + s”、`/idx` 解成“#x”（`/n` 例外，见上文，不解码）。
- 没有 `:|` 的行，C# 会把整行同时当作名称和 Text。插件对这种行报错，格式化时保持原样，不会像 C# `ToString()` 那样把内容复制一遍。
- 仅注释行格式化后写作 `:|///注释`。

## 开发与测试

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd test
npm.cmd run test:consistency
npm.cmd run test:fuzz
```

`npm.cmd test` 会扫描 `test/fixtures/*.lps`，包括大型 fixture。`test:consistency` 会使用 C# `LinePutScript.Core` 读取同一批 UTF-8 fixture，验证 TypeScript 行为与库输出一致。

`test:fuzz` 运行 `test/tools/diff-fuzz.js`：生成数千个边界用例（CRLF、续行与软换行组合、`///`、空名称、缺少 `:|`、各种转义前缀等），一次性交给 C# 库解析，再与 TypeScript 的解析、格式化、反转义/转义结果以及所有范围逐项比较。可用 `-- --file <path.lps>` 额外校验真实文件（例如 VPet 存档）。需要 .NET SDK。

`esbuild.js` 支持环境变量 `LPS_OUT_DIR`，用于把构建产物输出到其他目录（例如 `out/` 被 VS Code 占用无法写入，或并行构建时）。
