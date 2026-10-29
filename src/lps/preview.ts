import { randomBytes } from "node:crypto";
import { decodeLpsText, hasInvalidRawLpsValue } from "./escape";
import { lineBodyText, lineRawBodyText } from "./export";
import type { LpsDocument, LpsLine, LpsRange, LpsSub } from "./types";

/** A line with more subs than this starts collapsed. */
export const PREVIEW_COLLAPSE_SUB_THRESHOLD = 20;
/** A line whose original text is longer than this many characters starts collapsed. */
export const PREVIEW_COLLAPSE_LENGTH_THRESHOLD = 2000;
/** A sub table with more rows than this starts collapsed inside an expanded line. */
export const PREVIEW_SUBS_TABLE_COLLAPSE_THRESHOLD = 100;
/** A single value longer than this many characters is shown truncated with an expand button. */
export const PREVIEW_LONG_VALUE_CHARS = 400;
/** A single value with more lines than this is shown truncated with an expand button. */
export const PREVIEW_LONG_VALUE_LINES = 8;
/** Maximum characters of info shown in a line summary. */
export const PREVIEW_SUMMARY_INFO_CHARS = 80;
/** Maximum characters of a truncated long value shown before it is expanded. */
export const PREVIEW_VALUE_SNIPPET_CHARS = 120;
/** How many extra "decode once more" layers are precomputed per value (on top of the single decode). */
export const PREVIEW_MAX_EXTRA_DECODE_LAYERS = 8;

export interface PreviewOptions {
  /** CSP nonce for the preview script. A random one is generated when omitted. */
  nonce?: string;
}

export function createPreviewNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Messages the preview webview may post to the extension. */
export type PreviewMessage =
  | { type: "export" }
  | { type: "copy"; text: string }
  | { type: "reveal"; start: number; end: number };

/** Validates an untrusted webview message; returns undefined for anything unexpected. */
export function parsePreviewMessage(message: unknown): PreviewMessage | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const { type, text, start, end } = message as Record<string, unknown>;
  if (type === "export") {
    return { type: "export" };
  }
  if (type === "copy") {
    return typeof text === "string" ? { type: "copy", text } : undefined;
  }
  if (type === "reveal") {
    return typeof start === "number" && typeof end === "number"
      && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
      ? { type: "reveal", start, end }
      : undefined;
  }
  return undefined;
}

export interface PreviewSnapshotState {
  /** Document version when the preview was created or, for the current side, right now. */
  version: number;
  /** Document text. A function so the current text is only read when versions match. */
  text: () => string;
}

export type RevealPlan = { ok: true; start: number; end: number } | { ok: false; reason: "stale" };

/**
 * Decides whether the preview's source offsets still apply to the current document.
 * Offsets are only valid when both version and text are unchanged since the preview was built.
 */
export function planReveal(
  snapshot: PreviewSnapshotState,
  current: PreviewSnapshotState,
  start: number,
  end: number
): RevealPlan {
  if (snapshot.version !== current.version) {
    return { ok: false, reason: "stale" };
  }
  const currentText = current.text();
  if (currentText !== snapshot.text()) {
    return { ok: false, reason: "stale" };
  }
  const length = currentText.length;
  const clampedStart = Math.min(start, length);
  return { ok: true, start: clampedStart, end: Math.max(clampedStart, Math.min(end, length)) };
}

/**
 * The value shown by default followed by up to `PREVIEW_MAX_EXTRA_DECODE_LAYERS`
 * further `decodeLpsText` passes. Stops as soon as a pass changes nothing, so
 * `result.length === 1` means "decoding again would not change the value".
 */
export function computeDecodeLayers(decoded: string): string[] {
  const layers = [decoded];
  while (layers.length <= PREVIEW_MAX_EXTRA_DECODE_LAYERS) {
    const previous = layers[layers.length - 1];
    const next = decodeLpsText(previous);
    if (next === previous) {
      break;
    }
    layers.push(next);
  }
  return layers;
}

export function rawLineLength(line: LpsLine): number {
  return Math.max(0, line.range.end - line.range.start);
}

export function shouldCollapseLine(line: LpsLine): boolean {
  return line.subs.length > PREVIEW_COLLAPSE_SUB_THRESHOLD
    || rawLineLength(line) > PREVIEW_COLLAPSE_LENGTH_THRESHOLD;
}

export function isLongPreviewValue(value: string): boolean {
  if (value.length > PREVIEW_LONG_VALUE_CHARS) {
    return true;
  }
  let lineCount = 1;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10 && ++lineCount > PREVIEW_LONG_VALUE_LINES) {
      return true;
    }
  }
  return false;
}

export function renderPreviewHtml(document: LpsDocument, options: PreviewOptions = {}): string {
  const nonce = options.nonce ?? createPreviewNonce();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(nonce)) {
    throw new Error("Invalid preview nonce.");
  }

  const diagnostics = document.diagnostics.length === 0
    ? ""
    : `<section class="diagnostics"><h2>Diagnostics</h2>${document.diagnostics.map((diagnostic) => (
      `<div class="diagnostic ${diagnostic.severity}">${escapeHtml(diagnostic.severity.toUpperCase())}: ${escapeHtml(diagnostic.message)}</div>`
    )).join("")}</section>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    [hidden] {
      display: none !important;
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
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0 -20px 16px;
      padding: 8px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--vscode-editor-background);
    }
    .toolbar input {
      flex: 1 1 160px;
      min-width: 120px;
      max-width: 320px;
      padding: 3px 6px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--border));
    }
    .toolbar .count {
      color: var(--muted);
    }
    button {
      padding: 3px 10px;
      font: inherit;
      color: var(--vscode-button-secondaryForeground, inherit);
      background: var(--vscode-button-secondaryBackground, var(--panel));
      border: 1px solid var(--border);
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--panel));
    }
    .line {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 0 0 12px;
      overflow: hidden;
      background: var(--panel);
    }
    .line-summary {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 12px;
      padding: 10px 12px;
      cursor: pointer;
      background: color-mix(in srgb, var(--accent) 10%, transparent);
    }
    .line[open] > .line-summary {
      border-bottom: 1px solid var(--border);
    }
    .line-summary .name {
      flex: 0 1 auto;
    }
    .line-summary .meta {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 0.9em;
    }
    .line-summary .snippet {
      flex: 1 1 200px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--muted);
    }
    .line-info {
      padding: 10px 12px;
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
    .long-value > summary {
      display: flex;
      align-items: baseline;
      gap: 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .long-value > summary .preview {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .long-value > summary .toggle {
      flex: 0 0 auto;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 3px;
      color: var(--vscode-textLink-foreground, inherit);
      font-size: 0.9em;
    }
    .long-value > summary .when-open,
    .long-value[open] > summary .when-closed,
    .long-value[open] > summary .preview {
      display: none;
    }
    .long-value[open] > summary .when-open {
      display: inline;
    }
    .long-body {
      max-height: 24em;
      overflow: auto;
      margin-top: 4px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .subs > summary {
      padding: 8px 12px;
      cursor: pointer;
      color: var(--muted);
      border-top: 1px solid var(--border);
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
    .badge {
      flex: 0 0 auto;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 0.85em;
    }
    .badge.warn {
      color: var(--vscode-editorWarning-foreground, inherit);
      border-color: var(--vscode-inputValidation-warningBorder, var(--border));
    }
    .invalid-lps-value {
      color: var(--vscode-editorError-foreground, inherit);
    }
    .interactive .goto {
      cursor: pointer;
      text-decoration: underline dotted;
    }
    .interactive .goto:hover {
      color: var(--vscode-textLink-activeForeground, inherit);
    }
    .vblock > button,
    .vblock > .vlevel {
      display: none;
      margin: 4px 6px 0 0;
      font-size: 0.85em;
    }
    .vblock > button {
      padding: 0 8px;
    }
    .vblock > .vlevel {
      color: var(--muted);
    }
    .js .vblock > button,
    .js .vblock > .vlevel {
      display: inline-block;
    }
    body:not(.interactive) .vblock > [data-action="copy"] {
      display: none;
    }
    mark.hit {
      color: inherit;
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
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
  <div class="toolbar" id="toolbar" hidden>
    <button type="button" id="expand-all">全部展开</button>
    <button type="button" id="collapse-all">全部折叠</button>
    <input type="search" id="filter" placeholder="按 line / sub 名或值过滤" aria-label="按 line / sub 名或值过滤">
    <span class="count" id="filter-count"></span>
    <button type="button" id="export">导出</button>
  </div>
  ${diagnostics}
  ${document.lines.map(renderLine).join("")}
  <script nonce="${nonce}">${previewScript}</script>
</body>
</html>`;
}

const previewScript = `(function () {
  "use strict";
  var vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var MAX_MARKS = 1000;
  var toolbar = document.getElementById("toolbar");
  var filter = document.getElementById("filter");
  var count = document.getElementById("filter-count");
  var filtering = false;
  var saved = [];
  var marksLeft = 0;
  var truncated = false;

  function toArray(list) {
    return Array.prototype.slice.call(list);
  }

  var lines = toArray(document.querySelectorAll("details.line"));
  var entries = lines.map(function (line) {
    return {
      el: line,
      name: line.getAttribute("data-name") || "",
      nameEl: line.querySelector("summary .goto"),
      subsEl: line.querySelector("details.subs"),
      own: toArray(line.querySelectorAll(".vblock")).filter(function (block) { return !block.closest("tr"); }),
      rows: toArray(line.querySelectorAll("tr[data-name]")).map(function (row) {
        return {
          el: row,
          name: row.getAttribute("data-name") || "",
          nameEl: row.querySelector(".goto"),
          blocks: toArray(row.querySelectorAll(".vblock"))
        };
      })
    };
  });

  function setAll(open) {
    lines.forEach(function (line) {
      if (line.hidden) {
        return;
      }
      line.open = open;
      toArray(line.querySelectorAll("details.subs")).forEach(function (subs) {
        subs.open = open;
      });
    });
  }

  /** The element holding the complete text of the layer a value block currently shows. */
  function fullEl(block) {
    var root = block.querySelector(".vlayer:not([hidden])") || block;
    return root.querySelector(".long-body") || root.querySelector("div.value");
  }

  function lowerOf(el) {
    if (typeof el.lpsLower !== "string") {
      el.lpsLower = el.textContent.toLowerCase();
    }
    return el.lpsLower;
  }

  function matchingValues(blocks, query) {
    var found = [];
    blocks.forEach(function (block) {
      var el = fullEl(block);
      if (el && lowerOf(el).indexOf(query) >= 0) {
        found.push(el);
      }
    });
    return found;
  }

  function highlight(el, query) {
    if (!el) {
      return;
    }
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    nodes.forEach(function (node) {
      var lower = node.nodeValue.toLowerCase();
      if (lower.length !== node.nodeValue.length) {
        return;
      }
      var consumed = 0;
      var current = node;
      var pos = lower.indexOf(query);
      while (pos >= 0) {
        if (marksLeft <= 0) {
          truncated = true;
          return;
        }
        var hit = current.splitText(pos - consumed);
        current = hit.splitText(query.length);
        var mark = document.createElement("mark");
        mark.className = "hit";
        hit.parentNode.replaceChild(mark, hit);
        mark.appendChild(hit);
        marksLeft--;
        consumed = pos + query.length;
        pos = lower.indexOf(query, consumed);
      }
    });
  }

  function clearMarks() {
    var parents = new Set();
    toArray(document.querySelectorAll("mark.hit")).forEach(function (mark) {
      var parent = mark.parentNode;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parents.add(parent);
    });
    parents.forEach(function (parent) {
      parent.normalize();
    });
  }

  function openAround(el) {
    var details = el.closest("details.long-value");
    if (details) {
      details.open = true;
    }
  }

  function applyFilter() {
    var query = filter.value.trim().toLowerCase();
    clearMarks();
    if (!query) {
      if (filtering) {
        entries.forEach(function (entry) {
          entry.el.hidden = false;
          if (entry.subsEl) {
            entry.subsEl.hidden = false;
          }
          entry.rows.forEach(function (row) {
            row.el.hidden = false;
          });
        });
        saved.forEach(function (state) {
          state.el.open = state.open;
        });
      }
      filtering = false;
      saved = [];
      count.textContent = "";
      return;
    }
    if (!filtering) {
      saved = toArray(document.querySelectorAll("details")).map(function (el) {
        return { el: el, open: el.open };
      });
      filtering = true;
    }

    marksLeft = MAX_MARKS;
    truncated = false;
    var hits = 0;
    entries.forEach(function (entry) {
      var nameHit = entry.name.indexOf(query) >= 0;
      var own = matchingValues(entry.own, query);
      var lineHit = nameHit || own.length > 0;
      var anyRow = false;
      var visibleRows = 0;

      if (lineHit) {
        hits++;
        if (nameHit) {
          highlight(entry.nameEl, query);
        }
        own.forEach(function (el) {
          highlight(el, query);
          openAround(el);
        });
      }

      entry.rows.forEach(function (row) {
        var rowNameHit = row.name.indexOf(query) >= 0;
        var values = matchingValues(row.blocks, query);
        var rowHit = rowNameHit || values.length > 0;
        row.el.hidden = !nameHit && !rowHit;
        if (!row.el.hidden) {
          visibleRows++;
        }
        if (rowHit) {
          hits++;
          anyRow = true;
          if (rowNameHit) {
            highlight(row.nameEl, query);
          }
          values.forEach(function (el) {
            highlight(el, query);
            openAround(el);
          });
        }
      });

      entry.el.hidden = !(lineHit || anyRow);
      if (entry.subsEl) {
        entry.subsEl.hidden = visibleRows === 0;
      }
      if (!entry.el.hidden) {
        entry.el.open = true;
        if (entry.subsEl) {
          entry.subsEl.open = true;
        }
      }
    });
    count.textContent = "命中 " + hits + " 项" + (truncated ? "（仅高亮前 " + MAX_MARKS + " 处）" : "");
  }

  /** Switches which pre-rendered layer of a value block is visible. No decoding happens here. */
  function setLevel(block, level) {
    var total = Number(block.getAttribute("data-layers")) || 1;
    level = Math.max(0, Math.min(total - 1, level));
    block.setAttribute("data-level", String(level));
    toArray(block.querySelectorAll(".vlayer")).forEach(function (layer) {
      layer.hidden = Number(layer.getAttribute("data-layer")) !== level;
    });
    var deeper = block.querySelector("[data-action=deeper]");
    var undo = block.querySelector("[data-action=reset]");
    var tag = block.querySelector(".vlevel");
    if (deeper) {
      deeper.hidden = level >= total - 1;
    }
    if (undo) {
      undo.hidden = level === 0;
    }
    if (tag) {
      tag.hidden = level === 0;
      tag.textContent = "已再解 " + level + " 层";
    }
    if (filtering) {
      applyFilter();
    }
  }

  function copyValue(block, button) {
    var el = fullEl(block);
    if (!el || !vscode) {
      return;
    }
    vscode.postMessage({ type: "copy", text: el.textContent });
    button.textContent = "已复制";
    setTimeout(function () { button.textContent = "复制"; }, 1200);
  }

  function gotoSource(el) {
    vscode.postMessage({
      type: "reveal",
      start: Number(el.getAttribute("data-start")),
      end: Number(el.getAttribute("data-end"))
    });
  }

  document.getElementById("expand-all").addEventListener("click", function () { setAll(true); });
  document.getElementById("collapse-all").addEventListener("click", function () { setAll(false); });
  filter.addEventListener("input", applyFilter);

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var button = target.closest("button[data-action]");
    if (button) {
      var block = button.closest(".vblock");
      if (!block) {
        return;
      }
      var action = button.getAttribute("data-action");
      var level = Number(block.getAttribute("data-level")) || 0;
      if (action === "deeper") {
        setLevel(block, level + 1);
      } else if (action === "reset") {
        setLevel(block, 0);
      } else if (action === "copy") {
        copyValue(block, button);
      }
      return;
    }
    var goto = target.closest("[data-start]");
    if (goto && vscode) {
      event.preventDefault();
      gotoSource(goto);
    }
  });

  document.addEventListener("keydown", function (event) {
    var target = event.target;
    if (event.key === "Enter" && vscode && target && target.classList && target.classList.contains("goto")) {
      event.preventDefault();
      gotoSource(target);
    }
  });

  var exportButton = document.getElementById("export");
  // The per-value buttons and name links only show once the script is running.
  document.body.classList.add("js");
  if (vscode) {
    exportButton.addEventListener("click", function () { vscode.postMessage({ type: "export" }); });
    document.body.classList.add("interactive");
    toArray(document.querySelectorAll(".goto")).forEach(function (el) {
      el.setAttribute("role", "link");
      el.setAttribute("tabindex", "0");
      el.setAttribute("title", "跳转到源码");
    });
  } else {
    exportButton.hidden = true;
  }

  toolbar.hidden = false;
})();`;

function gotoRange(range: LpsRange): string {
  return `data-start="${range.start}" data-end="${range.end}"`;
}

function renderLine(line: LpsLine): string {
  const open = shouldCollapseLine(line) ? "" : " open";
  const name = line.name || (line.isCommentOnly ? "" : "(empty)");
  const nameHtml = line.isCommentOnly
    ? `<span class="name goto" ${gotoRange(line.range)}>// 注释</span>`
    : `<span class="name goto" ${gotoRange(line.range)}>${escapeHtml(name)}</span>`;
  const snippetSource = line.isCommentOnly ? line.comments : line.decodedInfo;
  const snippet = truncateInline(snippetSource, PREVIEW_SUMMARY_INFO_CHARS);
  const meta = line.isCommentOnly
    ? `${rawLineLength(line)} 字符`
    : `${line.subs.length} 个子项 · ${rawLineLength(line)} 字符`;
  const missingSeparator = !line.isCommentOnly && !line.hasSeparator
    ? `<span class="badge warn" title="该行没有 :| 分隔符；LinePutScript 会把整行同时当作名称和正文，预览和导出不显示正文">缺少 :|</span>`
    : "";

  const summary = `<summary class="line-summary">
      ${nameHtml}
      ${missingSeparator}
      <span class="meta">${escapeHtml(meta)}</span>
      ${snippet ? `<span class="snippet">${escapeHtml(snippet)}</span>` : ""}
    </summary>`;

  const info = !line.isCommentOnly && (line.decodedInfo || line.info)
    ? `<div class="line-info">${renderValueBlock("Info", line.decodedInfo, line.info)}</div>`
    : "";
  const subs = line.isCommentOnly ? "" : renderSubs(line.subs);
  const bodyText = line.isCommentOnly ? "" : lineBodyText(line);
  const text = bodyText || line.comments
    ? `<div class="text-row">
        ${bodyText ? renderValueBlock("Text", bodyText, lineRawBodyText(line)) : ""}
        ${line.comments ? `<div class="label">Comments</div>${renderLongAware(line.comments, "value", "")}` : ""}
      </div>`
    : "";

  return `<details class="line" data-name="${escapeHtml(line.name.toLowerCase())}"${open}>
    ${summary}
    ${info}${subs}${text}
  </details>`;
}

function renderSubs(subs: LpsSub[]): string {
  if (subs.length === 0) {
    return `<div class="text-row raw">No subs</div>`;
  }
  const open = subs.length > PREVIEW_SUBS_TABLE_COLLAPSE_THRESHOLD ? "" : " open";
  return `<details class="subs"${open}>
      <summary>子项 (${subs.length})</summary>
      <table>
        <thead>
          <tr><th>Sub</th><th>Info</th><th title="仅在与解码值不同时显示">Raw Info</th></tr>
        </thead>
        <tbody>${subs.map(renderSub).join("")}</tbody>
      </table>
    </details>`;
}

function renderSub(sub: LpsSub): string {
  const name = sub.name || "(empty)";
  return `<tr data-name="${escapeHtml(sub.name.toLowerCase())}">
    <td class="name"><span class="goto" ${gotoRange(sub.range)}>${escapeHtml(name)}</span></td>
    <td>${renderDecodedValue(sub.decodedInfo)}</td>
    <td>${sub.info === sub.decodedInfo ? "" : renderRawValue(sub.info, "")}</td>
  </tr>`;
}

function renderValueBlock(label: string, decoded: string, raw: string): string {
  return `<div class="label">${escapeHtml(label)}</div>
    ${renderDecodedValue(decoded)}
    ${raw ? renderRawValue(raw, "raw: ") : ""}`;
}

/**
 * Shows a parser-decoded value (decoded exactly once by the parser). Decoded
 * values may legitimately contain `:|`, so no validity badge is shown here.
 *
 * Non-empty values get a copy button. When decoding the shown value once more
 * would change it, the further layers are rendered up front as hidden siblings
 * so the script only has to toggle visibility.
 */
function renderDecodedValue(decoded: string): string {
  if (!decoded) {
    return renderLongAware(decoded, "value", "");
  }
  const copy = `<button type="button" data-action="copy">复制</button>`;
  const layers = computeDecodeLayers(decoded);
  if (layers.length === 1) {
    return `<div class="vblock">${renderLongAware(decoded, "value", "")}${copy}</div>`;
  }
  const variants = layers.map((value, index) => (
    `<div class="vlayer" data-layer="${index}"${index === 0 ? "" : " hidden"}>${renderLongAware(value, "value", "")}</div>`
  )).join("");
  const deeper = `<button type="button" data-action="deeper" title="对当前显示的值再做一次解码">再解一层</button><button type="button" data-action="reset" hidden>还原</button><span class="vlevel" hidden></span>`;
  return `<div class="vblock" data-layers="${layers.length}" data-level="0">${variants}${copy}${deeper}</div>`;
}

function renderRawValue(raw: string, prefix: string): string {
  if (!raw) {
    return "";
  }
  return `${renderLongAware(raw, "raw", prefix)}${renderInvalidBadge(raw)}`;
}

function renderLongAware(value: string, className: "value" | "raw", prefix: string): string {
  const prefixHtml = escapeHtml(prefix);
  if (!isLongPreviewValue(value)) {
    return `<div class="${className}">${prefixHtml}${escapeHtml(value)}</div>`;
  }
  const lines = value.split("\n").length;
  const stats = lines > 1 ? `${value.length} 字符 / ${lines} 行` : `${value.length} 字符`;
  const snippet = truncateInline(value, PREVIEW_VALUE_SNIPPET_CHARS);
  return `<details class="long-value ${className}">
      <summary>${prefixHtml}<span class="preview">${escapeHtml(snippet)}</span><span class="toggle when-closed">展开 (${stats})</span><span class="toggle when-open">收起</span></summary>
      <div class="long-body">${escapeHtml(value)}</div>
    </details>`;
}

/** Only meaningful for raw values: the parser splits on `:|`, so a raw value never contains it. */
function renderInvalidBadge(raw: string): string {
  return hasInvalidRawLpsValue(raw) ? ` <span class="invalid-lps-value">invalid LPS value</span>` : "";
}

function truncateInline(value: string, max: number): string {
  const flat = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const collapsed = flat.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max && flat === value) {
    return collapsed;
  }
  let cut = collapsed.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    // A literal CR in HTML source is normalized to LF by the parser; a character reference survives.
    .replace(/\r/g, "&#13;");
}
