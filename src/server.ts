import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DocumentFormattingParams,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  SymbolKind,
  TextDocumentPositionParams,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { escapeCompletions } from "./lps/escape";
import { formatLpsDocument } from "./lps/formatter";
import { buildHoverMarkdown } from "./lps/hover";
import { collectNames, findNodeAtOffset, parseLpsDocument } from "./lps/parser";
import type { LpsDiagnostic, LpsDocument, LpsLine, LpsRange, LpsSub } from "./lps/types";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let showHints = true;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["/", "#", ":"]
      },
      documentFormattingProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      hoverProvider: true
    }
  };
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
    void refreshSettings();
  }
});

connection.onDidChangeConfiguration(() => {
  void refreshSettings();
});

async function refreshSettings(): Promise<void> {
  try {
    const settings = await connection.workspace.getConfiguration("lineputscript") as { diagnostics?: { hints?: boolean } } | null;
    showHints = settings?.diagnostics?.hints !== false;
  } catch {
    showHints = true;
  }
  documents.all().forEach(validateTextDocument);
}

documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const parsed = parseLpsDocument(document.getText());
  const nameItems = dedupe(collectNames(parsed).map((usage) => ({
    label: usage.name,
    kind: usage.kind === "line" ? CompletionItemKind.Class : CompletionItemKind.Field,
    detail: usage.kind === "line" ? "Line name in current document" : "Sub name in current document"
  })));

  const escapeItems = escapeCompletions.map((item) => ({
    label: item.label,
    kind: CompletionItemKind.Constant,
    detail: item.detail
  }));

  return [...escapeItems, ...nameItems];
});

connection.onHover((params: TextDocumentPositionParams): Hover | undefined => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return undefined;
  }

  const parsed = parseLpsDocument(document.getText());
  const offset = document.offsetAt(params.position);
  const node = findNodeAtOffset(parsed, offset);
  if (!node) {
    return undefined;
  }

  return {
    contents: {
      kind: "markdown",
      value: buildHoverMarkdown(node)
    }
  };
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const parsed = parseLpsDocument(document.getText());
  return parsed.lines.map((line) => ({
    name: line.name || "(empty line)",
    detail: summarize(line.decodedInfo),
    kind: SymbolKind.Object,
    range: toProtocolRange(document, line.range),
    selectionRange: toProtocolRange(document, line.nameRange),
    children: line.subs.map((sub) => subToSymbol(document, sub))
  }));
});

connection.onFoldingRanges((params): FoldingRange[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const parsed = parseLpsDocument(document.getText());
  return parsed.lines
    .map((line) => {
      const start = document.positionAt(line.range.start).line;
      const end = document.positionAt(line.range.end).line;
      return end > start ? { startLine: start, endLine: end } : undefined;
    })
    .filter((foldingRange): foldingRange is FoldingRange => foldingRange !== undefined);
});

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const parsed = parseLpsDocument(document.getText());
  const formatted = formatLpsDocument(parsed);
  return [
    TextEdit.replace(
      {
        start: document.positionAt(0),
        end: document.positionAt(document.getText().length)
      },
      formatted
    )
  ];
});

function validateTextDocument(textDocument: TextDocument): void {
  const parsed = parseLpsDocument(textDocument.getText());
  const reported = showHints ? [...parsed.diagnostics, ...parsed.hints] : parsed.diagnostics;
  const diagnostics = reported.map((diagnostic) => toProtocolDiagnostic(textDocument, diagnostic));
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

function toProtocolDiagnostic(document: TextDocument, diagnostic: LpsDiagnostic): Diagnostic {
  return {
    severity: diagnostic.severity === "error"
      ? DiagnosticSeverity.Error
      : diagnostic.severity === "warning"
        ? DiagnosticSeverity.Warning
        : DiagnosticSeverity.Information,
    range: toProtocolRange(document, diagnostic.range),
    code: diagnostic.code,
    source: "LinePutScript",
    message: diagnostic.message
  };
}

function toProtocolRange(document: TextDocument, range: LpsRange) {
  return {
    start: document.positionAt(range.start),
    end: document.positionAt(range.end)
  };
}

function subToSymbol(document: TextDocument, sub: LpsSub): DocumentSymbol {
  return {
    name: sub.name || "(empty sub)",
    detail: summarize(sub.decodedInfo),
    kind: SymbolKind.Field,
    range: toProtocolRange(document, sub.range),
    selectionRange: toProtocolRange(document, sub.nameRange),
    children: []
  };
}

/** Outline details must stay on one line and short, even for multi-kilobyte values. */
function summarize(value: string): string {
  const flat = value.replace(/s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

function dedupe<T extends { label: string; kind: CompletionItemKind }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

documents.listen(connection);
connection.listen();
