export type LpsNodeKind = "line" | "sub";

export interface LpsRange {
  start: number;
  end: number;
}

export interface LpsDiagnostic {
  range: LpsRange;
  severity: "error" | "warning" | "information";
  code: string;
  message: string;
}

export interface LpsEntry {
  kind: LpsNodeKind;
  name: string;
  info: string;
  decodedInfo: string;
  raw: string;
  range: LpsRange;
  nameRange: LpsRange;
  infoRange?: LpsRange;
  separatorRange?: LpsRange;
}

export interface LpsSub extends LpsEntry {
  kind: "sub";
  index: number;
}

export interface LpsLine extends LpsEntry {
  kind: "line";
  index: number;
  isCommentOnly: boolean;
  /**
   * False when the logical line has no `:|`. The C# loader then reuses the whole
   * line as both the name and the text, so such a line is reported as an error
   * and the formatter leaves it untouched.
   */
  hasSeparator: boolean;
  /** The logical line after C# load normalization (CR removed, continuations merged). */
  source: string;
  subs: LpsSub[];
  text: string;
  decodedText: string;
  comments: string;
  textRange: LpsRange;
  commentRange?: LpsRange;
}

export interface LpsDocument {
  text: string;
  /** Text after the same normalization `LpsDocument.Load` applies in the C# library. */
  normalizedText: string;
  lines: LpsLine[];
  /** Structural problems (errors and warnings). */
  diagnostics: LpsDiagnostic[];
  /** Optional informational hints such as duplicate names; shown only when enabled. */
  hints: LpsDiagnostic[];
}

export interface LpsNameUsage {
  kind: LpsNodeKind;
  name: string;
}
