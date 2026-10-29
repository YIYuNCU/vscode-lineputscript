import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { decodeLpsText, encodeLpsText } from "./lps/escape";
import { ExportFormat, exportFormatExtensions, exportParsed } from "./lps/export";
import { toDisplayTree } from "./lps/formatter";
import { parseLpsDocument } from "./lps/parser";
import { createPreviewNonce, parsePreviewMessage, planReveal, renderPreviewHtml } from "./lps/preview";
import type { LpsDocument } from "./lps/types";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join("out", "src", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] }
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "lineputscript" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.lps")
    }
  };

  client = new LanguageClient("lineputscriptLanguageServer", "LinePutScript Language Server", serverOptions, clientOptions);
  context.subscriptions.push(client);
  void client.start();

  context.subscriptions.push(
    vscode.commands.registerCommand("lineputscript.escapeSelection", () => replaceSelections(encodeLpsText)),
    vscode.commands.registerCommand("lineputscript.unescapeSelection", () => replaceSelections(decodeLpsText)),
    vscode.commands.registerCommand("lineputscript.formatDocument", async () => {
      await vscode.commands.executeCommand("editor.action.formatDocument");
    }),
    vscode.commands.registerCommand("lineputscript.showParsedStructure", showParsedStructure),
    vscode.commands.registerCommand("lineputscript.openPreview", openPreview),
    vscode.commands.registerCommand("lineputscript.exportParsed", exportParsedFromActiveEditor)
  );
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
  }
}

async function replaceSelections(transform: (value: string) => string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  await editor.edit((editBuilder) => {
    for (const selection of editor.selections) {
      if (selection.isEmpty) {
        continue;
      }
      editBuilder.replace(selection, transform(editor.document.getText(selection)));
    }
  });
}

async function showParsedStructure(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const parsed = parseLpsDocument(editor.document.getText());
  const content = JSON.stringify(toDisplayTree(parsed), null, 2);
  const panel = vscode.window.createWebviewPanel(
    "lineputscriptParsedStructure",
    `Parsed ${path.basename(editor.document.fileName)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: false,
      retainContextWhenHidden: true
    }
  );
  panel.webview.html = renderJsonWebview(content);
}

async function openPreview(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // Offsets in the preview refer to this exact text, so remember the version it was built from.
  const source: PreviewSource = {
    uri: editor.document.uri,
    fileName: editor.document.fileName,
    version: editor.document.version
  };
  const parsed = parseLpsDocument(editor.document.getText());
  const panel = vscode.window.createWebviewPanel(
    "lineputscriptPreview",
    `Preview ${path.basename(source.fileName)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [],
      retainContextWhenHidden: true
    }
  );
  panel.webview.onDidReceiveMessage((raw: unknown) => {
    const message = parsePreviewMessage(raw);
    if (!message) {
      return;
    }
    switch (message.type) {
      case "export":
        void exportParsedDocument(parsed, source);
        break;
      case "copy":
        void copyPreviewValue(message.text);
        break;
      case "reveal":
        void revealInSource(parsed, source, message.start, message.end);
        break;
    }
  });
  panel.webview.html = renderPreviewHtml(parsed, { nonce: createPreviewNonce() });
}

interface ExportSource {
  uri: vscode.Uri;
  fileName: string;
}

interface PreviewSource extends ExportSource {
  /** Version of the document the preview was built from. */
  version: number;
}

async function copyPreviewValue(text: string): Promise<void> {
  try {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`已复制 ${text.length} 个字符到剪贴板`, 3000);
  } catch (error) {
    void vscode.window.showErrorMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function revealInSource(parsed: LpsDocument, source: PreviewSource, start: number, end: number): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(source.uri);
    const plan = planReveal(
      { version: source.version, text: () => parsed.text },
      { version: document.version, text: () => document.getText() },
      start,
      end
    );
    if (!plan.ok) {
      void vscode.window.showWarningMessage("预览已过期，请重新打开预览");
      return;
    }

    const visible = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
      preserveFocus: false
    });
    const range = new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    void vscode.window.showErrorMessage(`无法跳转到源码：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exportParsedFromActiveEditor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("请先打开一个 .lps 文件。");
    return;
  }

  await exportParsedDocument(
    parseLpsDocument(editor.document.getText()),
    { uri: editor.document.uri, fileName: editor.document.fileName }
  );
}

async function exportParsedDocument(parsed: LpsDocument, source: ExportSource): Promise<void> {
  const choice = await vscode.window.showQuickPick<{ label: string; description: string; format: ExportFormat }>(
    [
      { label: "JSON", description: "结构化数据（.json）", format: "json" },
      { label: "CSV", description: "每个 sub 一行的表格（.csv，UTF-8 BOM）", format: "csv" },
      { label: "文本", description: "便于阅读的纯文本（.txt）", format: "txt" }
    ],
    { placeHolder: "选择导出格式", title: "导出解析后内容" }
  );
  if (!choice) {
    return;
  }

  const extension = exportFormatExtensions[choice.format];
  const baseName = path.basename(source.fileName, path.extname(source.fileName)) || "lineputscript";
  const defaultUri = source.uri.scheme === "file"
    ? vscode.Uri.file(path.join(path.dirname(source.fileName), baseName + extension))
    : vscode.Uri.file(baseName + extension);
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { [choice.label]: [extension.slice(1)] },
    saveLabel: "导出",
    title: "导出解析后内容"
  });
  if (!target) {
    return;
  }

  try {
    const content = exportParsed(parsed, choice.format);
    const bytes = Buffer.from((choice.format === "csv" ? String.fromCharCode(0xfeff) : "") + content, "utf8");
    await vscode.workspace.fs.writeFile(target, bytes);
  } catch (error) {
    void vscode.window.showErrorMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const open = "打开文件";
  const action = await vscode.window.showInformationMessage(`已导出到 ${path.basename(target.fsPath)}`, open);
  if (action === open) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  }
}

function renderJsonWebview(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinePutScript Parsed Structure</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body><pre>${escapeHtml(content)}</pre></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
