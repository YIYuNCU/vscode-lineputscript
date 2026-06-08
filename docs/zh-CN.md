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

- 诊断：提示缺少 `:|`、未转义的可疑字符等结构问题。
- Hover：显示当前 Line/Sub 的名称、反转义后的 Info、Text 和注释。
- 补全：提供当前文档已出现的 Line/Sub 名称和常用转义序列。
- 文档大纲：按 Line 展示顶层节点，Sub 作为子节点展示。
- 折叠：支持跨行逻辑行的折叠范围。
- 格式化：按现有 C# `LpsDocument.ToString()` 风格规范化文档。

## 命令

- `LinePutScript: Escape Selection`：转义选中文本。
- `LinePutScript: Unescape Selection`：反转义选中文本。
- `LinePutScript: Format Document`：格式化当前文档。
- `LinePutScript: Show Parsed Structure`：在侧边打开当前文档的解析结构 JSON。
- `LinePutScript: Open Preview`：在侧边打开预览模式，预览中会显示反转义后的 Info 和 Text，同时保留 Raw Info 便于对照。

编辑器右键菜单中只显示一个 `LinePutScript` 子菜单，所有命令都收纳在该子菜单下。`Show Parsed Structure` 使用只读 Webview 展示 JSON，不创建临时 JSON 文件，因此关闭时不会触发保存提示。

预览模式会对显示内容做额外的只读反转义，适合查看嵌套转义值。若反转义后的显示值仍包含 `:|`，预览会标记 `invalid LPS value`，提示该显示值不能直接作为未转义 LPS 值写回。

## 开发与测试

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd test
npm.cmd run test:consistency
```

`npm.cmd test` 会扫描 `test/fixtures/*.lps`，包括大型 fixture。`test:consistency` 会使用 C# `LinePutScript.Core` 读取同一批 UTF-8 fixture，验证 TypeScript 行为与库输出一致。
