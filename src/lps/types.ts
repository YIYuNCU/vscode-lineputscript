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
  subs: LpsSub[];
  text: string;
  decodedText: string;
  comments: string;
  textRange: LpsRange;
  commentRange?: LpsRange;
}

export interface LpsDocument {
  text: string;
  normalizedText: string;
  lines: LpsLine[];
  diagnostics: LpsDiagnostic[];
}

export interface LpsNameUsage {
  kind: LpsNodeKind;
  name: string;
}
