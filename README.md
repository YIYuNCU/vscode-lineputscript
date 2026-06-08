# LinePutScript VS Code Extension

This extension adds editor support for LinePutScript `.lps` files.

## Features

- `.lps` language detection.
- Syntax highlighting for names, info values, text values, separators, comments, and escape sequences.
- Language Server Protocol support for diagnostics, symbols, folding, hover, completion, and formatting.
- Commands for escaping, unescaping, formatting, previewing, and viewing the parsed structure.
- Editor context commands are grouped under a single `LinePutScript` submenu.
- Preview mode displays decoded values and marks decoded values that are not valid raw LPS values.

All files in this extension project are stored as UTF-8. Chinese fixture text is intentionally included in tests to prevent encoding regressions.

Chinese documentation: [docs/zh-CN.md](docs/zh-CN.md)

## Development

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd test
npm.cmd run test:consistency
```
