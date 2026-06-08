import { decodeLpsText } from "./escape";
import type { LpsDiagnostic, LpsDocument, LpsEntry, LpsLine, LpsNameUsage, LpsRange, LpsSub } from "./types";

interface LogicalLine {
  text: string;
  start: number;
  end: number;
}

const continuationNewline = ":\n|";
const continuationSoftWrap = ":\n:";

function normalizeDocumentText(text: string): string {
  return text
    .replace(/\r/g, "")
    .split(continuationNewline).join("/n")
    .split(continuationSoftWrap).join("")
    .replace(/^\n+|\n+$/g, "");
}

function buildLogicalLines(text: string): LogicalLine[] {
  const noCr = text.replace(/\r/g, "");
  const lines: LogicalLine[] = [];
  let current = "";
  let currentStart = 0;
  let index = 0;

  while (index < noCr.length) {
    if (noCr.startsWith(continuationNewline, index)) {
      current += "/n";
      index += continuationNewline.length;
      continue;
    }

    if (noCr.startsWith(continuationSoftWrap, index)) {
      index += continuationSoftWrap.length;
      continue;
    }

    const char = noCr[index];
    if (char === "\n") {
      const end = index;
      if (current.length > 0) {
        lines.push({ text: current, start: currentStart, end });
      }
      current = "";
      currentStart = index + 1;
      index++;
      continue;
    }

    if (current.length === 0) {
      currentStart = index;
    }
    current += char;
    index++;
  }

  if (current.length > 0) {
    lines.push({ text: current, start: currentStart, end: noCr.length });
  }

  return lines;
}

function range(start: number, end: number): LpsRange {
  return { start, end: Math.max(start, end) };
}

function splitOnce(value: string, separator: string): [string, string | undefined, number] {
  const index = value.indexOf(separator);
  if (index < 0) {
    return [value, undefined, -1];
  }
  return [value.slice(0, index), value.slice(index + separator.length), index];
}

function parseNameInfo(raw: string, baseOffset: number, kind: "line" | "sub"): Pick<LpsEntry, "name" | "info" | "decodedInfo" | "raw" | "range" | "nameRange" | "infoRange" | "separatorRange"> {
  const [name, info, separatorIndex] = splitOnce(raw, "#");
  const entry: Pick<LpsEntry, "name" | "info" | "decodedInfo" | "raw" | "range" | "nameRange" | "infoRange" | "separatorRange"> = {
    name,
    info: info ?? "",
    decodedInfo: decodeLpsText(info ?? ""),
    raw,
    range: range(baseOffset, baseOffset + raw.length),
    nameRange: range(baseOffset, baseOffset + name.length)
  };

  if (separatorIndex >= 0) {
    entry.separatorRange = range(baseOffset + separatorIndex, baseOffset + separatorIndex + 1);
    entry.infoRange = range(baseOffset + separatorIndex + 1, baseOffset + raw.length);
  }

  if (kind === "line" && raw.length === 0) {
    entry.nameRange = range(baseOffset, baseOffset);
  }

  return entry;
}

function pushDiagnostic(diagnostics: LpsDiagnostic[], diagnostic: LpsDiagnostic): void {
  diagnostics.push(diagnostic);
}

function validateEntry(entry: LpsEntry, diagnostics: LpsDiagnostic[]): void {
  if (entry.name.length === 0) {
    pushDiagnostic(diagnostics, {
      range: entry.nameRange,
      severity: "warning",
      code: "empty-name",
      message: `${entry.kind === "line" ? "Line" : "Sub"} name is empty.`
    });
  }

  if (entry.info.includes("#")) {
    pushDiagnostic(diagnostics, {
      range: entry.infoRange ?? entry.range,
      severity: "warning",
      code: "unescaped-id",
      message: "Info contains an unescaped #. Use /id when the value should round-trip through generated LPS text."
    });
  }

  if (entry.info.includes("///")) {
    pushDiagnostic(diagnostics, {
      range: entry.infoRange ?? entry.range,
      severity: "warning",
      code: "unescaped-comment",
      message: "Info contains ///, which starts a LinePutScript comment before parsing."
    });
  }
}

function segmentOffsets(lineText: string, lineStart: number): Array<{ value: string; start: number; end: number }> {
  const result: Array<{ value: string; start: number; end: number }> = [];
  let start = 0;

  while (start <= lineText.length) {
    const index = lineText.indexOf(":|", start);
    if (index < 0) {
      result.push({
        value: lineText.slice(start),
        start: lineStart + start,
        end: lineStart + lineText.length
      });
      break;
    }

    result.push({
      value: lineText.slice(start, index),
      start: lineStart + start,
      end: lineStart + index
    });
    start = index + 2;
  }

  return result;
}

function parseLogicalLine(logicalLine: LogicalLine, index: number, diagnostics: LpsDiagnostic[]): LpsLine {
  const [withoutComment, comments, commentIndex] = splitOnce(logicalLine.text, "///");
  const isCommentOnly = commentIndex === 0 && withoutComment.length === 0;
  const commentRange = commentIndex >= 0
    ? range(logicalLine.start + commentIndex, logicalLine.start + logicalLine.text.length)
    : undefined;
  const segments = segmentOffsets(withoutComment, logicalLine.start);
  const lineEntry = parseNameInfo(segments[0]?.value ?? "", segments[0]?.start ?? logicalLine.start, "line");
  const textSegment = segments[segments.length - 1] ?? {
    value: "",
    start: logicalLine.end,
    end: logicalLine.end
  };

  const line: LpsLine = {
    ...lineEntry,
    kind: "line",
    index,
    isCommentOnly,
    subs: [],
    text: textSegment.value,
    decodedText: decodeLpsText(textSegment.value),
    comments: comments ?? "",
    textRange: range(textSegment.start, textSegment.end),
    commentRange,
    range: range(logicalLine.start, logicalLine.end)
  };

  if (!isCommentOnly) {
    validateEntry(line, diagnostics);
  }

  if (!isCommentOnly && !withoutComment.includes(":|")) {
    pushDiagnostic(diagnostics, {
      range: line.range,
      severity: "error",
      code: "missing-line-separator",
      message: "Line is missing the :| separator."
    });
  }

  for (let segmentIndex = 1; segmentIndex < segments.length - 1; segmentIndex++) {
    const segment = segments[segmentIndex];
    const subEntry = parseNameInfo(segment.value, segment.start, "sub");
    const sub: LpsSub = {
      ...subEntry,
      kind: "sub",
      index: segmentIndex - 1
    };
    validateEntry(sub, diagnostics);
    line.subs.push(sub);
  }

  return line;
}

export function parseLpsDocument(text: string): LpsDocument {
  const diagnostics: LpsDiagnostic[] = [];
  const logicalLines = buildLogicalLines(text);
  const lines = logicalLines.map((logicalLine, index) => parseLogicalLine(logicalLine, index, diagnostics));

  return {
    text,
    normalizedText: normalizeDocumentText(text),
    lines,
    diagnostics
  };
}

export function collectNames(document: LpsDocument): LpsNameUsage[] {
  const names: LpsNameUsage[] = [];
  for (const line of document.lines) {
    if (line.name) {
      names.push({ kind: "line", name: line.name });
    }
    for (const sub of line.subs) {
      if (sub.name) {
        names.push({ kind: "sub", name: sub.name });
      }
    }
  }
  return names;
}

export function findNodeAtOffset(document: LpsDocument, offset: number): LpsLine | LpsSub | undefined {
  for (const line of document.lines) {
    if (offset < line.range.start || offset > line.range.end) {
      continue;
    }

    for (const sub of line.subs) {
      if (offset >= sub.range.start && offset <= sub.range.end) {
        return sub;
      }
    }

    return line;
  }
  return undefined;
}
