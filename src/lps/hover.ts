import { decodeLpsText } from "./escape";
import { describeValue } from "./valueHints";
import type { LpsLine, LpsSub } from "./types";

const maxInlineLength = 200;
const maxListItems = 10;

/** Same as `Sub.GetInfos()`: split the raw info on `,` (an escaped comma is `/com`), drop empties, decode each. */
export function splitInfoList(rawInfo: string): string[] {
  return rawInfo.split(",").filter((item) => item.length > 0).map(decodeLpsText);
}

/** Renders `value` as one inline Markdown code span: newlines shown as ↵, long values truncated. */
export function inlineCode(value: string): string {
  let text = value.replace(/\r?\n/g, "↵").replace(/\t/g, "⇥");
  if (text.length > maxInlineLength) {
    text = `${text.slice(0, maxInlineLength)}… (共 ${value.length} 字符)`;
  }
  if (text.length === 0) {
    return "(空)";
  }

  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
}

export function buildHoverMarkdown(node: LpsLine | LpsSub): string {
  const lines = [
    `**${node.kind === "line" ? "Line" : "Sub"}** ${inlineCode(node.name || "(empty)")}`,
    "",
    `Info: ${inlineCode(node.decodedInfo)}`
  ];

  for (const hint of describeValue(node.decodedInfo)) {
    lines.push("", `_${hint}_`);
  }

  const items = splitInfoList(node.info);
  if (node.info.includes(",") && items.length > 1) {
    const shown = items.slice(0, maxListItems).map((item) => inlineCode(item)).join(" , ");
    lines.push("", `列表项 (${items.length}): ${shown}${items.length > maxListItems ? " …" : ""}`);
  }

  if (node.kind === "line") {
    lines.push("", `Subs: ${node.subs.length}`);
    if (node.decodedText) {
      lines.push("", `Text: ${inlineCode(node.decodedText)}`);
    }
    if (node.comments) {
      lines.push("", `Comments: ${inlineCode(node.comments)}`);
    }
  }

  return lines.join("\n");
}
