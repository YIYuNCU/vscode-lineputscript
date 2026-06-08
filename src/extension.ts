import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { decodeLpsText, encodeLpsText } from "./lps/escape";
import { toDisplayTree } from "./lps/formatter";
import { parseLpsDocument } from "./lps/parser";
import { renderPreviewHtml } from "./lps/preview";

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
    vscode.commands.registerCommand("lineputscript.openPreview", openPreview)
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

  const parsed = parseLpsDocument(editor.document.getText());
  const panel = vscode.window.createWebviewPanel(
    "lineputscriptPreview",
    `Preview ${path.basename(editor.document.fileName)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: false,
      retainContextWhenHidden: true
    }
  );
  panel.webview.html = renderPreviewHtml(parsed);
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
