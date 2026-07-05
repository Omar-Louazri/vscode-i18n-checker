"use strict";

const path = require("path");
const vscode = require("vscode");
const {
  analyzeJsonDocument,
  analyzeTsxDocument,
  findDictionaryFile,
  findJsonKeyLocation,
  findTranslationKeyAtOffset,
  findUnusedTranslationKeysRemovalEdits,
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
    vscode.languages.registerDefinitionProvider(
      [{ language: "typescriptreact", scheme: "file" }, { pattern: "**/*.tsx", scheme: "file" }],
      { provideDefinition },
    ),
    vscode.languages.registerCodeActionsProvider(
      [{ language: "json", scheme: "file" }, { pattern: "**/public/*/*.json", scheme: "file" }],
      { provideCodeActions },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
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

function provideCodeActions(document, _range, context) {
  if (!isJsonDocument(document)) {
    return [];
  }

  const workspaceRoot = getWorkspaceRoot(document.uri);

  if (!workspaceRoot) {
    return [];
  }

  const actions = [];
  const openDocuments = getOpenDocumentTexts();
  const dictionaryPublicPaths = getDictionaryPublicPaths();
  const analysisCache = {};
  const selectedTargets = context.diagnostics
    .filter(isUnusedTranslationKeyDiagnostic)
    .map(getUnusedTranslationKeyTarget)
    .filter(Boolean);
  const allUnusedDiagnostics = (diagnostics.get(document.uri) ?? context.diagnostics).filter(
    isUnusedTranslationKeyDiagnostic,
  );
  const allUnusedTargets = allUnusedDiagnostics.map(getUnusedTranslationKeyTarget).filter(Boolean);
  const addedBulkActionKeys = new Set();

  for (const target of selectedTargets) {
    const createDeleteAction = (title, keyPaths, diagnostics, isPreferred = false) => {
      const deletionEdits = findUnusedTranslationKeysRemovalEdits({
        workspaceRoot,
        namespace: target.namespace,
        keyPaths,
        openDocuments,
        dictionaryPublicPaths,
        cache: analysisCache,
      });

      if (!deletionEdits.length) {
        return null;
      }

      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = diagnostics;
      action.edit = createDeleteWorkspaceEdit(deletionEdits);
      action.isPreferred = isPreferred;
      return action;
    };

    const diagnostic = context.diagnostics.find(
      (candidate) =>
        isUnusedTranslationKeyDiagnostic(candidate) &&
        getUnusedTranslationKeyTarget(candidate)?.namespace === target.namespace &&
        getUnusedTranslationKeyTarget(candidate)?.keyPath === target.keyPath,
    );

    const singleAction = createDeleteAction(
      `Delete "${target.keyPath}" from all ${target.namespace}.json dictionaries`,
      [target.keyPath],
      diagnostic ? [diagnostic] : [],
      true,
    );

    if (singleAction) {
      actions.push(singleAction);
    }

    const parentPath = getParentKeyPath(target.keyPath);
    const namespaceTargets = allUnusedTargets.filter((candidate) => candidate.namespace === target.namespace);
    const namespaceDiagnostics = allUnusedDiagnostics.filter((candidate) => {
      const candidateTarget = getUnusedTranslationKeyTarget(candidate);
      return candidateTarget?.namespace === target.namespace;
    });

    if (parentPath) {
      const parentActionKey = `${target.namespace}\0${parentPath}`;

      if (!addedBulkActionKeys.has(parentActionKey)) {
        addedBulkActionKeys.add(parentActionKey);

        const parentTargets = namespaceTargets.filter((candidate) =>
          candidate.keyPath.startsWith(`${parentPath}.`),
        );
        const parentDiagnostics = allUnusedDiagnostics.filter((candidate) => {
          const candidateTarget = getUnusedTranslationKeyTarget(candidate);
          return (
            candidateTarget?.namespace === target.namespace &&
            candidateTarget.keyPath.startsWith(`${parentPath}.`)
          );
        });
        const parentAction = createDeleteAction(
          `Delete all "${parentPath}.*" from all ${target.namespace}.json dictionaries`,
          parentTargets.map((candidate) => candidate.keyPath),
          parentDiagnostics,
        );

        if (parentAction) {
          actions.push(parentAction);
        }
      }
    }

    const namespaceActionKey = `${target.namespace}\0*`;

    if (!addedBulkActionKeys.has(namespaceActionKey)) {
      addedBulkActionKeys.add(namespaceActionKey);

      const allAction = createDeleteAction(
        `Delete all unused attributes from all ${target.namespace}.json dictionaries`,
        namespaceTargets.map((candidate) => candidate.keyPath),
        namespaceDiagnostics,
      );

      if (allAction) {
        actions.push(allAction);
      }
    }
  }

  return actions;
}

function createDeleteWorkspaceEdit(deletionEdits) {
  const workspaceEdit = new vscode.WorkspaceEdit();

  for (const deletionEdit of deletionEdits) {
    const uri = vscode.Uri.file(deletionEdit.filePath);

    workspaceEdit.delete(
      uri,
      new vscode.Range(
        new vscode.Position(deletionEdit.startPosition.line, deletionEdit.startPosition.character),
        new vscode.Position(deletionEdit.endPosition.line, deletionEdit.endPosition.character),
      ),
    );
  }

  return workspaceEdit;
}

function getParentKeyPath(keyPath) {
  const lastDot = keyPath.lastIndexOf(".");

  if (lastDot === -1) {
    return null;
  }

  return keyPath.slice(0, lastDot);
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
  const analysisCache = {};

  for (const document of vscode.workspace.textDocuments) {
    updateDocumentDiagnostics(document, openDocuments, analysisCache);
  }
}

function updateDocumentDiagnostics(document, openDocuments = getOpenDocumentTexts(), analysisCache = {}) {
  if (document.uri.scheme !== "file") {
    return;
  }

  const workspaceRoot = getWorkspaceRoot(document.uri);

  if (!workspaceRoot) {
    return;
  }

  const text = document.getText();
  const dictionaryPublicPaths = getDictionaryPublicPaths();
  let rawDiagnostics = [];

  if (isTsxDocument(document)) {
    rawDiagnostics = analyzeTsxDocument({
      text,
      filePath: document.uri.fsPath,
      workspaceRoot,
      openDocuments,
      dictionaryPublicPaths,
      cache: analysisCache,
    });
  } else if (isJsonDocument(document)) {
    if (!isLocaleJsonFile(document.uri.fsPath, workspaceRoot, dictionaryPublicPaths, analysisCache)) {
      diagnostics.delete(document.uri);
      return;
    }

    rawDiagnostics = analyzeJsonDocument({
      text,
      filePath: document.uri.fsPath,
      workspaceRoot,
      openDocuments,
      dictionaryPublicPaths,
      cache: analysisCache,
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

async function provideDefinition(document, position) {
  if (!isTsxDocument(document)) {
    return undefined;
  }

  const workspaceRoot = getWorkspaceRoot(document.uri);

  if (!workspaceRoot) {
    return undefined;
  }

  const target = findTranslationKeyAtOffset(document.getText(), document.offsetAt(position));

  if (!target) {
    return undefined;
  }

  const defaultLocale = getDefaultLocale();
  const dictionaryPath = findDictionaryFile(
    workspaceRoot,
    defaultLocale,
    target.namespace,
    getDictionaryPublicPaths(),
  );

  if (!dictionaryPath) {
    return undefined;
  }

  const dictionaryUri = vscode.Uri.file(dictionaryPath);
  let dictionaryDocument;

  try {
    dictionaryDocument = await vscode.workspace.openTextDocument(dictionaryUri);
  } catch {
    return undefined;
  }

  const keyLocation = findJsonKeyLocation(dictionaryDocument.getText(), target.path);

  if (!keyLocation) {
    return undefined;
  }

  return new vscode.Location(
    dictionaryUri,
    new vscode.Range(
      dictionaryDocument.positionAt(keyLocation.keyStart),
      dictionaryDocument.positionAt(keyLocation.keyEnd),
    ),
  );
}

function getDefaultLocale() {
  const configuredLocale = vscode.workspace
    .getConfiguration("simpleI18nChecker")
    .get("defaultLocale", "fr");

  return String(configuredLocale || "fr").trim() || "fr";
}

function getDictionaryPublicPaths() {
  const configuredPaths = vscode.workspace
    .getConfiguration("simpleI18nChecker")
    .get("dictionaryPublicPaths", []);

  if (!Array.isArray(configuredPaths)) {
    return [];
  }

  return configuredPaths
    .filter((configuredPath) => typeof configuredPath === "string" && configuredPath.trim())
    .map((configuredPath) => configuredPath.trim());
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
    dictionaryPublicPaths: getDictionaryPublicPaths(),
    cache: {},
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
  vsCodeDiagnostic.code = diagnostic.code;
  vsCodeDiagnostic.data = diagnostic.data;
  return vsCodeDiagnostic;
}

function isUnusedTranslationKeyDiagnostic(diagnostic) {
  return diagnostic.source === "simple-i18n-checker" && diagnostic.code === "unusedTranslationKey";
}

function getUnusedTranslationKeyTarget(diagnostic) {
  if (diagnostic.data?.namespace && diagnostic.data?.keyPath) {
    return diagnostic.data;
  }

  const match = diagnostic.message.match(
    /^Translation key "(.+)" is not used by any TSX file with namespace "(.+)"\.$/,
  );

  if (!match) {
    return null;
  }

  return {
    keyPath: match[1],
    namespace: match[2],
  };
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
