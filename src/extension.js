"use strict";

const path = require("path");
const vscode = require("vscode");
const {
  analyzeJsonDocument,
  analyzeTsxDocument,
  inspectDocument,
  isLocaleJsonFile,
} = require("./i18nAnalyzer");

let diagnostics;
let output;
let refreshTimer;

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("simple-i18n-checker");
  output = vscode.window.createOutputChannel("Simple i18n Checker");
  context.subscriptions.push(diagnostics, output);

  const refresh = () => refreshOpenDocuments();
  const scheduleRefresh = () => scheduleOpenDocumentRefresh();

  context.subscriptions.push(
    vscode.commands.registerCommand("simpleI18nChecker.refresh", refresh),
    vscode.commands.registerCommand("simpleI18nChecker.debugActiveFile", debugActiveFile),
    vscode.workspace.onDidOpenTextDocument(updateDocumentDiagnostics),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isRelevantDocument(event.document)) {
        scheduleRefresh();
      } else {
        diagnostics.delete(event.document.uri);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
  );

  const jsonWatcher = vscode.workspace.createFileSystemWatcher("**/public/*/*.json");
  const tsxWatcher = vscode.workspace.createFileSystemWatcher("**/*.tsx");

  context.subscriptions.push(
    jsonWatcher,
    tsxWatcher,
    jsonWatcher.onDidCreate(refresh),
    jsonWatcher.onDidChange(refresh),
    jsonWatcher.onDidDelete(refresh),
    tsxWatcher.onDidCreate(refresh),
    tsxWatcher.onDidChange(refresh),
    tsxWatcher.onDidDelete(refresh),
  );

  refreshOpenDocuments();
}

function deactivate() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  diagnostics?.clear();
}

function refreshOpenDocuments() {
  const openDocuments = getOpenDocumentTexts();

  for (const document of vscode.workspace.textDocuments) {
    updateDocumentDiagnostics(document, openDocuments);
  }
}

function updateDocumentDiagnostics(document, openDocuments = getOpenDocumentTexts()) {
  if (document.uri.scheme !== "file") {
    return;
  }

  const workspaceRoot = getWorkspaceRoot(document.uri);

  if (!workspaceRoot) {
    return;
  }

  const text = document.getText();
  let rawDiagnostics = [];

  if (isTsxDocument(document)) {
    rawDiagnostics = analyzeTsxDocument({
      text,
      filePath: document.uri.fsPath,
      workspaceRoot,
      openDocuments,
    });
  } else if (isJsonDocument(document)) {
    if (!isLocaleJsonFile(document.uri.fsPath, workspaceRoot)) {
      diagnostics.delete(document.uri);
      return;
    }

    rawDiagnostics = analyzeJsonDocument({
      text,
      filePath: document.uri.fsPath,
      workspaceRoot,
      openDocuments,
    });
  } else {
    diagnostics.delete(document.uri);
    return;
  }

  diagnostics.set(
    document.uri,
    rawDiagnostics.map((diagnostic) => toVsCodeDiagnostic(document, diagnostic)),
  );
}

function getOpenDocumentTexts() {
  const openDocuments = new Map();

  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme === "file") {
      openDocuments.set(document.uri.fsPath, document.getText());
    }
  }

  return openDocuments;
}

function scheduleOpenDocumentRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshOpenDocuments();
  }, 150);
}

function debugActiveFile() {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showWarningMessage("Simple i18n Checker: no active editor.");
    return;
  }

  const document = editor.document;
  const workspaceRoot = getWorkspaceRoot(document.uri);
  const openDocuments = getOpenDocumentTexts();

  if (!workspaceRoot) {
    vscode.window.showWarningMessage("Simple i18n Checker: no workspace folder found.");
    return;
  }

  updateDocumentDiagnostics(document, openDocuments);

  const currentDiagnostics = diagnostics.get(document.uri) ?? [];
  const inspection = inspectDocument({
    text: document.getText(),
    filePath: document.uri.fsPath,
    workspaceRoot,
    openDocuments,
  });

  output.clear();
  output.appendLine("Simple i18n Checker Debug");
  output.appendLine(`Workspace: ${workspaceRoot}`);
  output.appendLine(`File: ${document.uri.fsPath}`);
  output.appendLine(`Language: ${document.languageId}`);
  output.appendLine(`Diagnostics: ${currentDiagnostics.length}`);
  output.appendLine("");
  output.appendLine(JSON.stringify(inspection, null, 2));
  output.show(true);
}

function toVsCodeDiagnostic(document, diagnostic) {
  const vsCodeDiagnostic = new vscode.Diagnostic(
    new vscode.Range(document.positionAt(diagnostic.start), document.positionAt(diagnostic.end)),
    diagnostic.message,
    toVsCodeSeverity(diagnostic.severity),
  );

  vsCodeDiagnostic.source = "simple-i18n-checker";
  return vsCodeDiagnostic;
}

function toVsCodeSeverity(severity) {
  if (severity === "hint") {
    return vscode.DiagnosticSeverity.Hint;
  }

  if (severity === "error") {
    return vscode.DiagnosticSeverity.Error;
  }

  return vscode.DiagnosticSeverity.Warning;
}

function getWorkspaceRoot(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isTsxDocument(document) {
  return document.languageId === "typescriptreact" || path.extname(document.uri.fsPath) === ".tsx";
}

function isJsonDocument(document) {
  return document.languageId === "json" || path.extname(document.uri.fsPath) === ".json";
}

function isRelevantDocument(document) {
  if (document.uri.scheme !== "file") {
    return false;
  }

  return isTsxDocument(document) || isJsonDocument(document);
}

module.exports = {
  activate,
  deactivate,
};
