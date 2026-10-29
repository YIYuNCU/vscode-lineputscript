# LinePutScript VS Code Extension

This extension adds editor support for LinePutScript `.lps` files.

## Features

- `.lps` language detection.
- Syntax highlighting for names, info values, text values, separators, comments, and escape sequences.
- Language Server Protocol support for diagnostics, symbols, folding, hover, completion, and formatting.
- Commands for escaping, unescaping, formatting, previewing, and viewing the parsed structure.
- Editor context commands are grouped under a single `LinePutScript` submenu.
- Preview mode shows decoded values (decoded once, like `Sub.TextDeReplace`) next to the raw ones. Lines are collapsible, long lines start collapsed, and the toolbar offers expand/collapse all, search, copy, jump to source and export.
- Export the parsed (decoded) content as JSON, CSV or readable text.
- Hover hints for list items, .NET Ticks, Unix timestamps, booleans and numbers; informational hints for duplicate line/sub names (`lineputscript.diagnostics.hints`).
- Parsing follows the C# library exactly (checked by a differential fuzz test against `LinePutScript.Core`), including CRLF files.

All files in this extension project are stored as UTF-8. Chinese fixture text is intentionally included in tests to prevent encoding regressions.

Chinese documentation: [docs/zh-CN.md](docs/zh-CN.md)

## Development

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd test
npm.cmd run test:consistency
npm.cmd run test:fuzz
```
