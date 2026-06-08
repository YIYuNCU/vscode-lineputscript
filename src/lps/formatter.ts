import type { LpsDocument, LpsEntry, LpsLine, LpsSub } from "./types";

function formatEntry(entry: LpsEntry): string {
  if (entry.info.length === 0) {
    return `${entry.name}:|`;
  }
  return `${entry.name}#${entry.info}:|`;
}

function formatSub(sub: LpsSub): string {
  return formatEntry(sub);
}

function formatLine(line: LpsLine): string {
  const info = line.info.length === 0 ? "" : `#${line.info}`;
  const comment = line.comments.length === 0 ? "" : `///${line.comments}`;
  return `${line.name}${info}:|${line.subs.map(formatSub).join("")}${line.text}${comment}`;
}

export function formatLpsDocument(document: LpsDocument): string {
  return document.lines.map(formatLine).join("\n");
}

export function toDisplayTree(document: LpsDocument): unknown {
  return {
    lineCount: document.lines.length,
    diagnostics: document.diagnostics,
    lines: document.lines.map((line) => ({
      name: line.name,
      info: line.decodedInfo,
      rawInfo: line.info,
      text: line.decodedText,
      rawText: line.text,
      comments: line.comments,
      subs: line.subs.map((sub) => ({
        name: sub.name,
        info: sub.decodedInfo,
        rawInfo: sub.info
      }))
    }))
  };
}
