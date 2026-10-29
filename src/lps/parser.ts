import { decodeLpsText } from "./escape";
import type { LpsDiagnostic, LpsDocument, LpsEntry, LpsLine, LpsNameUsage, LpsRange, LpsSub } from "./types";

const continuationNewline = ":\n|";
const continuationSoftWrap = ":\n:";
const maxDuplicateHints = 200;

/**
 * A string together with, for every character, the span of the original text it came from.
 * `starts` has one extra trailing entry equal to the original text length.
 */
interface TrackedText {
  text: string;
  starts: number[];
  ends: number[];
}

type EntryRanges = Pick<LpsEntry, "name" | "info" | "decodedInfo" | "raw" | "range" | "nameRange" | "infoRange" | "separatorRange">;

function trackOriginal(text: string): TrackedText {
  const starts = new Array<number>(text.length + 1);
  const ends = new Array<number>(text.length);
  for (let index = 0; index < text.length; index++) {
    starts[index] = index;
    ends[index] = index + 1;
  }
  starts[text.length] = text.length;
  return { text, starts, ends };
}

/** `String.Replace(search, replacement)` that keeps the original-text mapping of every character. */
function replaceTracked(source: TrackedText, search: string, replacement: string): TrackedText {
  if (!source.text.includes(search)) {
    return source;
  }

  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;

  while (index < source.text.length) {
    if (source.text.startsWith(search, index)) {
      const spanStart = source.starts[index];
      const spanEnd = source.ends[index + search.length - 1];
      for (const char of replacement) {
        chars.push(char);
        starts.push(spanStart);
        ends.push(spanEnd);
      }
      index += search.length;
      continue;
    }

    chars.push(source.text[index]);
    starts.push(source.starts[index]);
    ends.push(source.ends[index]);
    index++;
  }

  starts.push(source.starts[source.text.length]);
  return { text: chars.join(""), starts, ends };
}

/**
 * Mirrors `LpsDocument.Load` in the C# library:
 * `Replace("\r", "").Replace(":\n|", "/n").Replace(":\n:", "")`, applied in this order.
 */
function normalizeTracked(text: string): TrackedText {
  let tracked = trackOriginal(text);
  tracked = replaceTracked(tracked, "\r", "");
  tracked = replaceTracked(tracked, continuationNewline, "/n");
  tracked = replaceTracked(tracked, continuationSoftWrap, "");
  return tracked;
}

function trimNewlines(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "\n") {
    start++;
  }
  while (end > start && value[end - 1] === "\n") {
    end--;
  }
  return value.slice(start, end);
}

/** Splits like `Split('\n', RemoveEmptyEntries)`; offsets index into the normalized text. */
function splitLogicalLines(normalized: string): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start <= normalized.length) {
    let end = normalized.indexOf("\n", start);
    if (end < 0) {
      end = normalized.length;
    }
    if (end > start) {
      lines.push({ start, end });
    }
    start = end + 1;
  }
  return lines;
}

function splitOnce(value: string, separator: string): [string, string | undefined, number] {
  const index = value.indexOf(separator);
  if (index < 0) {
    return [value, undefined, -1];
  }
  return [value.slice(0, index), value.slice(index + separator.length), index];
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

  // LinePutScript only splits Name/Info at the first #, so a later # still loads and round-trips.
  // Values written by the library always use /id, which is why this is only informational.
  if (entry.info.includes("#")) {
    pushDiagnostic(diagnostics, {
      range: entry.infoRange ?? entry.range,
      severity: "information",
      code: "unescaped-id",
      message: "Info contains a raw #. It loads correctly (only the first # separates name and info), but the library writes it as /id."
    });
  }
}

/** Splits `value` on `:|` and reports each piece's `[start, end)` as indexes into `value`. */
function segmentOffsets(value: string): Array<{ value: string; start: number; end: number }> {
  const result: Array<{ value: string; start: number; end: number }> = [];
  let start = 0;

  while (start <= value.length) {
    const index = value.indexOf(":|", start);
    if (index < 0) {
      result.push({ value: value.slice(start), start, end: value.length });
      break;
    }

    result.push({ value: value.slice(start, index), start, end: index });
    start = index + 2;
  }

  return result;
}

export function parseLpsDocument(text: string): LpsDocument {
  const diagnostics: LpsDiagnostic[] = [];
  const tracked = normalizeTracked(text);
  const normalized = tracked.text;

  /** Maps an index range of the normalized text back to the original document text. */
  const range = (start: number, end: number): LpsRange => {
    if (end > start) {
      return { start: tracked.starts[start], end: Math.max(tracked.starts[start], tracked.ends[end - 1]) };
    }
    // Inside a line an empty range sits right after the previous character, not before the next one;
    // this matters when removed text (\r, soft-wrap markers) lies between them.
    // At the start of a line it sits before the first character of that line instead.
    const insideLine = start > 0 && normalized[start - 1] !== "\n";
    const position = insideLine ? tracked.ends[start - 1] : tracked.starts[start];
    return { start: position, end: position };
  };

  const parseNameInfo = (raw: string, base: number): EntryRanges => {
    const [name, info, separatorIndex] = splitOnce(raw, "#");
    const entry: EntryRanges = {
      name,
      info: info ?? "",
      decodedInfo: decodeLpsText(info ?? ""),
      raw,
      range: range(base, base + raw.length),
      nameRange: range(base, base + name.length)
    };

    if (separatorIndex >= 0) {
      entry.separatorRange = range(base + separatorIndex, base + separatorIndex + 1);
      entry.infoRange = range(base + separatorIndex + 1, base + raw.length);
    }

    return entry;
  };

  const lines = splitLogicalLines(normalized).map((logical, index): LpsLine => {
    const lineText = normalized.slice(logical.start, logical.end);
    const [withoutComment, comments, commentIndex] = splitOnce(lineText, "///");
    const isCommentOnly = commentIndex === 0;
    const hasSeparator = withoutComment.includes(":|");
    const segments = segmentOffsets(withoutComment);
    const first = segments[0];
    const last = segments[segments.length - 1];
    const at = (offset: number): number => logical.start + offset;

    const line: LpsLine = {
      ...parseNameInfo(first.value, at(first.start)),
      kind: "line",
      index,
      isCommentOnly,
      hasSeparator,
      source: lineText,
      subs: [],
      text: last.value,
      decodedText: decodeLpsText(last.value),
      comments: comments ?? "",
      textRange: range(at(last.start), at(last.end)),
      commentRange: commentIndex >= 0 ? range(at(commentIndex), logical.end) : undefined
    };
    line.range = range(logical.start, logical.end);

    if (!isCommentOnly) {
      validateEntry(line, diagnostics);
      if (!hasSeparator) {
        pushDiagnostic(diagnostics, {
          range: line.range,
          severity: "error",
          code: "missing-line-separator",
          message: "Line is missing the :| separator."
        });
      }
    }

    for (let segmentIndex = 1; segmentIndex < segments.length - 1; segmentIndex++) {
      const segment = segments[segmentIndex];
      const sub: LpsSub = {
        ...parseNameInfo(segment.value, at(segment.start)),
        kind: "sub",
        index: segmentIndex - 1
      };
      validateEntry(sub, diagnostics);
      line.subs.push(sub);
    }

    return line;
  });

  const document: LpsDocument = {
    text,
    normalizedText: trimNewlines(normalized),
    lines,
    diagnostics,
    hints: []
  };
  document.hints = collectDuplicateHints(document);
  return document;
}

/**
 * Informational duplicate-name hints. Duplicates are legal (list-style Line/Sub),
 * but they are lost when the file is read as a dictionary (`Line_D` / `LPS_D`).
 */
export function collectDuplicateHints(document: LpsDocument): LpsDiagnostic[] {
  const hints: LpsDiagnostic[] = [];
  const firstLineByName = new Map<string, LpsLine>();

  for (const line of document.lines) {
    if (hints.length >= maxDuplicateHints) {
      break;
    }

    if (!line.isCommentOnly && line.name) {
      const first = firstLineByName.get(line.name);
      if (first) {
        hints.push({
          range: line.nameRange,
          severity: "information",
          code: "duplicate-line-name",
          message: `Line name "${line.name}" is already used by line ${first.index + 1}. Dictionary-style readers (Line_D / LPS_D) keep only one of them.`
        });
      } else {
        firstLineByName.set(line.name, line);
      }
    }

    const seenSubs = new Set<string>();
    for (const sub of line.subs) {
      if (!sub.name) {
        continue;
      }
      if (seenSubs.has(sub.name)) {
        hints.push({
          range: sub.nameRange,
          severity: "information",
          code: "duplicate-sub-name",
          message: `Sub name "${sub.name}" appears more than once in line "${line.name || "(empty)"}". Dictionary-style readers keep only one of them.`
        });
        if (hints.length >= maxDuplicateHints) {
          break;
        }
      } else {
        seenSubs.add(sub.name);
      }
    }
  }

  return hints;
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
