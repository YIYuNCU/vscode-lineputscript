import { decodeLpsTextForPreview, hasInvalidRawLpsValue } from "./escape";
import type { LpsDocument, LpsLine, LpsSub } from "./types";

export function renderPreviewHtml(document: LpsDocument): string {
  const diagnostics = document.diagnostics.length === 0
    ? ""
    : `<section class="diagnostics"><h2>Diagnostics</h2>${document.diagnostics.map((diagnostic) => (
      `<div class="diagnostic ${diagnostic.severity}">${escapeHtml(diagnostic.severity.toUpperCase())}: ${escapeHtml(diagnostic.message)}</div>`
    )).join("")}</section>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinePutScript Preview</title>
  <style>
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, currentColor 18%, transparent);
      --muted: color-mix(in srgb, currentColor 62%, transparent);
      --panel: color-mix(in srgb, currentColor 5%, transparent);
      --accent: #2f7d7b;
    }
    body {
      margin: 0;
      padding: 20px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      margin: 0 0 16px;
      font-size: 20px;
      font-weight: 600;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 15px;
      font-weight: 600;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .pill {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 10px;
      color: var(--muted);
    }
    .line {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 0 0 12px;
      overflow: hidden;
      background: var(--panel);
    }
    .line-header {
      display: grid;
      grid-template-columns: minmax(120px, 220px) 1fr;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
    }
    .name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .value {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .raw {
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.9em;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .text-row {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
    }
    .label {
      color: var(--muted);
      font-size: 0.9em;
      margin-bottom: 4px;
    }
    .diagnostic {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    .diagnostic.error {
      border-color: var(--vscode-inputValidation-errorBorder);
    }
    .diagnostic.warning {
      border-color: var(--vscode-inputValidation-warningBorder);
    }
  </style>
</head>
<body>
  <h1>LinePutScript Preview</h1>
  <div class="summary">
    <span class="pill">${document.lines.length} lines</span>
    <span class="pill">${document.lines.reduce((count, line) => count + line.subs.length, 0)} subs</span>
    <span class="pill">${document.diagnostics.length} diagnostics</span>
  </div>
  ${diagnostics}
  ${document.lines.map(renderLine).join("")}
</body>
</html>`;
}

function renderLine(line: LpsLine): string {
  const subRows = line.subs.length === 0
    ? `<tr><td colspan="3" class="raw">No subs</td></tr>`
    : line.subs.map(renderSub).join("");
  const text = line.decodedText || line.comments
    ? `<div class="text-row">
        ${line.decodedText ? renderValueBlock("Text", line.decodedText, line.text) : ""}
        ${line.comments ? `<div class="label">Comments</div><div class="value">${escapeHtml(line.comments)}</div>` : ""}
      </div>`
    : "";

  return `<section class="line">
    <div class="line-header">
      <div>
        <div class="label">Line</div>
        <div class="name">${escapeHtml(line.name || "(empty)")}</div>
      </div>
      <div>
        ${renderValueBlock("Info", line.decodedInfo, line.info)}
      </div>
    </div>
    <table>
      <thead>
        <tr><th>Sub</th><th>Info</th><th>Raw Info</th></tr>
      </thead>
      <tbody>${subRows}</tbody>
    </table>
    ${text}
  </section>`;
}

function renderSub(sub: LpsSub): string {
  const displayInfo = decodeLpsTextForPreview(sub.decodedInfo);
  return `<tr>
    <td class="name">${escapeHtml(sub.name || "(empty)")}</td>
    <td>${renderValue(displayInfo, sub.decodedInfo)}</td>
    <td class="raw">${escapeHtml(sub.info)}${renderInvalidBadge(sub.info)}</td>
  </tr>`;
}

function renderValueBlock(label: string, decoded: string, raw: string): string {
  const displayValue = decodeLpsTextForPreview(decoded);
  return `<div class="label">${escapeHtml(label)}</div>
    ${renderValue(displayValue, decoded)}
    ${renderRaw(raw)}`;
}

function renderValue(displayValue: string, decodedOnce: string): string {
  const note = displayValue !== decodedOnce
    ? `<div class="raw">preview-decoded: applied additional display-only decoding</div>`
    : "";
  return `<div class="value">${escapeHtml(displayValue)}${renderInvalidBadge(displayValue)}</div>${note}`;
}

function renderRaw(raw: string): string {
  return raw ? `<div class="raw">raw: ${escapeHtml(raw)}${renderInvalidBadge(raw)}</div>` : "";
}

function renderInvalidBadge(raw: string): string {
  return hasInvalidRawLpsValue(raw) ? ` <span class="invalid-lps-value">invalid LPS value</span>` : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
