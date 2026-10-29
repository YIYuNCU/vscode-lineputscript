import type { LpsDocument, LpsLine } from "./types";

export type ExportFormat = "json" | "csv" | "txt";

export interface ExportOptions {
  /** Also emit the undecoded info/text (`rawInfo`, `rawText`) in JSON output. Defaults to false. */
  includeRaw?: boolean;
}

export const exportFormatExtensions: Record<ExportFormat, string> = {
  json: ".json",
  csv: ".csv",
  txt: ".txt"
};

/**
 * Decoded body text of a line. A line without `:|` has no body: the C# loader
 * reuses the whole line as the text there, which is not real content.
 */
export function lineBodyText(line: LpsLine): string {
  return line.hasSeparator ? line.decodedText : "";
}

/** Undecoded counterpart of {@link lineBodyText}. */
export function lineRawBodyText(line: LpsLine): string {
  return line.hasSeparator ? line.text : "";
}

export const csvHeader = ["line", "lineInfo", "sub", "subInfo", "text", "comments"] as const;

/**
 * Exports the parsed document. All values are the parser-decoded values
 * (decoded exactly once). Comment-only lines are kept with an empty name and
 * their comment text in `comments`. Lines without `:|` export an empty text.
 */
export function exportParsed(document: LpsDocument, format: ExportFormat, options: ExportOptions = {}): string {
  switch (format) {
    case "json":
      return exportJson(document, options);
    case "csv":
      return exportCsv(document);
    case "txt":
      return exportText(document);
    default:
      throw new Error(`Unsupported export format: ${String(format)}`);
  }
}

function exportJson(document: LpsDocument, options: ExportOptions): string {
  const includeRaw = options.includeRaw === true;
  const lines = document.lines.map((line) => ({
    name: line.name,
    info: line.decodedInfo,
    text: lineBodyText(line),
    comments: line.comments,
    ...(includeRaw ? { rawInfo: line.info, rawText: lineRawBodyText(line) } : {}),
    subs: line.subs.map((sub) => ({
      name: sub.name,
      info: sub.decodedInfo,
      ...(includeRaw ? { rawInfo: sub.info } : {})
    }))
  }));
  return JSON.stringify({ lineCount: document.lines.length, lines }, null, 2);
}

function exportCsv(document: LpsDocument): string {
  const rows: string[][] = [[...csvHeader]];
  for (const line of document.lines) {
    if (line.subs.length === 0) {
      rows.push([line.name, line.decodedInfo, "", "", lineBodyText(line), line.comments]);
      continue;
    }
    for (const sub of line.subs) {
      rows.push([line.name, line.decodedInfo, sub.name, sub.decodedInfo, lineBodyText(line), line.comments]);
    }
  }
  return rows.map((row) => row.map(escapeCsvField).join(",")).join("\r\n") + "\r\n";
}

export function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function exportText(document: LpsDocument): string {
  const blocks = document.lines.map(renderTextLine);
  return blocks.length === 0 ? "" : blocks.join("\n\n") + "\n";
}

function renderTextLine(line: LpsLine): string {
  const out: string[] = [];
  if (line.isCommentOnly) {
    out.push(`/// ${indentContinuation(line.comments, "    ")}`);
    return out.join("\n");
  }

  out.push(`[${line.name}]${line.decodedInfo ? ` ${indentContinuation(line.decodedInfo, "  ")}` : ""}`);
  for (const sub of line.subs) {
    out.push(`  ${sub.name} = ${indentContinuation(sub.decodedInfo, "    ")}`);
  }
  const bodyText = lineBodyText(line);
  if (bodyText) {
    out.push(`  text: ${indentContinuation(bodyText, "    ")}`);
  }
  if (line.comments) {
    out.push(`  /// ${indentContinuation(line.comments, "      ")}`);
  }
  return out.join("\n");
}

/** Normalizes line breaks to \n and indents every continuation line. */
function indentContinuation(value: string, indent: string): string {
  return value.split(/\r\n|\r|\n/).join(`\n${indent}`);
}
