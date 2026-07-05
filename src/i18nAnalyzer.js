"use strict";

const fs = require("fs");
const path = require("path");

const TSX_EXTENSIONS = new Set([".tsx"]);

function analyzeTsxDocument({ text, filePath, workspaceRoot, openDocuments }) {
  const diagnostics = [];
  const contexts = findTranslationContexts(text);

  for (const context of contexts) {
    const dictionaries = readDictionaries(workspaceRoot, context.namespace, openDocuments);
    const existingDictionaries = dictionaries.files.filter((file) => file.exists);
    const namespaceTarget = existingDictionaries.length
      ? existingDictionaries.map((file) => path.relative(workspaceRoot, file.filePath)).join(", ")
      : `public/*/${context.namespace}.json`;

    for (const usage of findTranslationCalls(text, context.tName)) {
      if (!existingDictionaries.length) {
        diagnostics.push({
          start: usage.keyStart,
          end: usage.keyEnd,
          message: `No dictionary file found for namespace "${context.namespace}" (${namespaceTarget}).`,
          severity: "warning",
        });
        continue;
      }

      const missingLocales = dictionaries.files
        .filter((file) => !file.keys.has(usage.key))
        .map((file) => file.locale);

      if (missingLocales.length) {
        const missingFiles = missingLocales.map((locale) => `public/${locale}/${context.namespace}.json`);

        diagnostics.push({
          start: usage.keyStart,
          end: usage.keyEnd,
          message: `Translation key "${usage.key}" is used here, but is missing from these locale dictionaries: ${missingFiles.join(
            ", ",
          )}. Add the same key to every locale for namespace "${context.namespace}".`,
          severity: "warning",
        });
      }
    }
  }

  return diagnostics;
}

function analyzeJsonDocument({ text, filePath, workspaceRoot, openDocuments }) {
  const info = getLocaleJsonInfo(filePath, workspaceRoot);

  if (!info) {
    return [];
  }

  const parsed = parseJsonWithLocations(text);

  if (parsed.error) {
    return [
      {
        start: parsed.error.offset,
        end: parsed.error.offset + 1,
        message: parsed.error.message,
        severity: "warning",
      },
    ];
  }

  const usedKeys = findWorkspaceTranslationKeys(workspaceRoot, info.namespace, openDocuments);

  return parsed.keys
    .filter((key) => !usedKeys.has(key.path))
    .map((key) => ({
      start: key.keyStart,
      end: key.keyEnd,
      message: `Translation key "${key.path}" is not used by any TSX file with namespace "${info.namespace}".`,
      severity: "warning",
    }));
}

function inspectDocument({ text, filePath, workspaceRoot, openDocuments }) {
  if (path.extname(filePath) === ".tsx") {
    const contexts = findTranslationContexts(text);

    return {
      kind: "tsx",
      filePath,
      contexts: contexts.map((context) => ({
        namespace: context.namespace,
        tName: context.tName,
        dictionaries: readDictionaries(workspaceRoot, context.namespace, openDocuments).files.map((file) => ({
          locale: file.locale,
          exists: file.exists,
          filePath: path.relative(workspaceRoot, file.filePath),
          keyCount: file.keys.size,
        })),
        usages: findTranslationCalls(text, context.tName).map((usage) => usage.key),
      })),
    };
  }

  if (path.extname(filePath) === ".json") {
    const info = getLocaleJsonInfo(filePath, workspaceRoot);
    const parsed = parseJsonWithLocations(text);

    return {
      kind: "json",
      filePath,
      locale: info?.locale ?? null,
      namespace: info?.namespace ?? null,
      keyCount: parsed.keys.length,
      keys: parsed.keys.map((key) => key.path),
      parseError: parsed.error?.message ?? null,
      usedKeys: info ? [...findWorkspaceTranslationKeys(workspaceRoot, info.namespace, openDocuments)].sort() : [],
    };
  }

  return {
    kind: "unsupported",
    filePath,
  };
}

function findTranslationKeyAtOffset(text, offset) {
  for (const context of findTranslationContexts(text)) {
    for (const usage of findTranslationCalls(text, context.tName)) {
      const segment = findKeySegmentAtOffset(usage, offset);

      if (segment) {
        return {
          namespace: context.namespace,
          key: usage.key,
          path: segment.path,
          start: segment.start,
          end: segment.end,
        };
      }
    }
  }

  return null;
}

function findKeySegmentAtOffset(usage, offset) {
  if (offset < usage.keyStart || offset > usage.keyEnd) {
    return null;
  }

  let segmentStart = usage.keyStart;
  const parts = usage.key.split(".");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const segmentEnd = segmentStart + part.length;

    if (offset >= segmentStart && offset <= segmentEnd) {
      return {
        path: parts.slice(0, index + 1).join("."),
        start: segmentStart,
        end: segmentEnd,
      };
    }

    segmentStart = segmentEnd + 1;
  }

  return null;
}

function findJsonKeyLocation(text, targetPath) {
  const parsed = parseJsonWithLocations(text);

  if (parsed.error) {
    return null;
  }

  return parsed.keyLocations.find((key) => key.path === targetPath) ?? null;
}

function findTranslationContexts(text) {
  const contexts = [];
  const assignmentRegex =
    /\bconst\s+(?:\{(?<destructure>[^}]+)\}|(?<identifier>[A-Za-z_$][\w$]*))\s*=\s*(?:useTranslation|useTranslate)\s*\(\s*(["'`])(?<namespace>[^"'`]+)\3\s*\)/g;

  for (const match of text.matchAll(assignmentRegex)) {
    const namespace = match.groups.namespace;
    const destructure = match.groups.destructure;

    if (!destructure) {
      continue;
    }

    const tName = findDestructuredLocalName(destructure, "t");

    if (tName) {
      contexts.push({ namespace, tName });
    }
  }

  if (contexts.length) {
    return contexts;
  }

  const hookRegex = /\b(?:useTranslation|useTranslate)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g;

  for (const match of text.matchAll(hookRegex)) {
    contexts.push({ namespace: match[2], tName: "t" });
  }

  return contexts;
}

function findDestructuredLocalName(source, propertyName) {
  for (const rawPart of source.split(",")) {
    const part = rawPart.trim();

    if (!part) {
      continue;
    }

    const [property, local] = part.split(":").map((piece) => piece.trim());

    if (property === propertyName) {
      return local || propertyName;
    }
  }

  return null;
}

function findTranslationCalls(text, tName) {
  const escapedName = escapeRegExp(tName);
  const callRegex = new RegExp(`(?<![\\w$])${escapedName}\\s*\\(\\s*(["'\`])([^"'\`]+)\\1`, "g");
  const usages = [];

  for (const match of text.matchAll(callRegex)) {
    const key = match[2];
    const keyStart = match.index + match[0].lastIndexOf(key);

    usages.push({
      key,
      keyStart,
      keyEnd: keyStart + key.length,
    });
  }

  return usages;
}

function readDictionaries(workspaceRoot, namespace, openDocuments) {
  const publicDir = path.join(workspaceRoot, "public");
  const files = [];

  if (!fs.existsSync(publicDir)) {
    return { files };
  }

  for (const locale of safeReadDir(publicDir)) {
    const localeDir = path.join(publicDir, locale);
    const filePath = path.join(localeDir, `${namespace}.json`);

    if (!isDirectory(localeDir)) {
      continue;
    }

    let keys = new Set();

    if (fs.existsSync(filePath)) {
      const text = readTextFile(filePath, openDocuments);
      const parsed = parseJsonWithLocations(text);
      keys = new Set(parsed.keys.map((key) => key.path));
    }

    files.push({
      locale,
      filePath,
      exists: fs.existsSync(filePath),
      keys,
    });
  }

  return { files };
}

function getLocaleJsonInfo(filePath, workspaceRoot) {
  const relativePath = path.relative(path.join(workspaceRoot, "public"), filePath);

  if (!isRelativeChildPath(relativePath)) {
    return null;
  }

  const segments = relativePath.split(path.sep);

  if (segments.length !== 2 || path.extname(segments[1]) !== ".json") {
    return null;
  }

  return {
    locale: segments[0],
    namespace: path.basename(segments[1], ".json"),
  };
}

function isLocaleJsonFile(filePath, workspaceRoot) {
  return Boolean(getLocaleJsonInfo(filePath, workspaceRoot));
}

function isInsidePath(root, filePath) {
  return isRelativeChildPath(path.relative(root, filePath));
}

function isRelativeChildPath(relativePath) {
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function findWorkspaceTranslationKeys(workspaceRoot, namespace, openDocuments) {
  const keys = new Set();
  const filePaths = new Set(findFiles(workspaceRoot, TSX_EXTENSIONS));

  for (const filePath of openDocuments?.keys?.() ?? []) {
    if (isInsidePath(workspaceRoot, filePath) && TSX_EXTENSIONS.has(path.extname(filePath))) {
      filePaths.add(filePath);
    }
  }

  for (const filePath of filePaths) {
    const text = readTextFile(filePath, openDocuments);

    for (const context of findTranslationContexts(text)) {
      if (context.namespace !== namespace) {
        continue;
      }

      for (const usage of findTranslationCalls(text, context.tName)) {
        keys.add(usage.key);
      }
    }
  }

  return keys;
}

function readTextFile(filePath, openDocuments) {
  if (openDocuments?.has(filePath)) {
    return openDocuments.get(filePath);
  }

  return fs.readFileSync(filePath, "utf8");
}

function findFiles(root, extensions) {
  const results = [];
  const ignoredDirectories = new Set([".git", ".next", "node_modules", "vscode-i18n-checker"]);

  walk(root);
  return results;

  function walk(directory) {
    for (const entry of safeReadDir(directory)) {
      if (ignoredDirectories.has(entry)) {
        continue;
      }

      const entryPath = path.join(directory, entry);

      if (isDirectory(entryPath)) {
        walk(entryPath);
      } else if (extensions.has(path.extname(entryPath))) {
        results.push(entryPath);
      }
    }
  }
}

function parseJsonWithLocations(text) {
  let index = 0;
  const keys = [];
  const keyLocations = [];

  try {
    parseValue([]);
    skipWhitespace();

    if (index < text.length) {
      throw error("Unexpected characters after JSON value.");
    }

    return { keys, keyLocations };
  } catch (parseError) {
    return {
      keys,
      keyLocations,
      error: {
        offset: Math.max(0, Math.min(index, text.length - 1)),
        message: parseError.message,
      },
    };
  }

  function parseValue(pathParts, keyLocation) {
    skipWhitespace();
    const char = text[index];

    if (char === "{") {
      parseObject(pathParts);
      return;
    }

    if (char === "[") {
      parseArray(pathParts);
      if (keyLocation) {
        recordKey(pathParts, keyLocation);
      }
      return;
    }

    if (char === "\"") {
      parseString();
      if (keyLocation) {
        recordKey(pathParts, keyLocation);
      }
      return;
    }

    parseLiteralOrNumber();
    if (keyLocation) {
      recordKey(pathParts, keyLocation);
    }
  }

  function parseObject(pathParts) {
    expect("{");
    skipWhitespace();

    if (text[index] === "}") {
      index += 1;
      return;
    }

    while (index < text.length) {
      skipWhitespace();
      const key = parseString();
      const nextPathParts = [...pathParts, key.value];
      recordKeyLocation(nextPathParts, key);
      skipWhitespace();
      expect(":");
      parseValue(nextPathParts, key);
      skipWhitespace();

      if (text[index] === ",") {
        index += 1;
        continue;
      }

      if (text[index] === "}") {
        index += 1;
        return;
      }

      throw error("Expected ',' or '}'.");
    }
  }

  function parseArray(pathParts) {
    expect("[");
    skipWhitespace();

    if (text[index] === "]") {
      index += 1;
      return;
    }

    while (index < text.length) {
      parseValue(pathParts);
      skipWhitespace();

      if (text[index] === ",") {
        index += 1;
        continue;
      }

      if (text[index] === "]") {
        index += 1;
        return;
      }

      throw error("Expected ',' or ']'.");
    }
  }

  function parseString() {
    expect("\"");
    const start = index;
    let value = "";

    while (index < text.length) {
      const char = text[index];

      if (char === "\"") {
        const end = index;
        index += 1;
        return { value, keyStart: start, keyEnd: end };
      }

      if (char === "\\") {
        const escapeStart = index;
        index += 1;
        const escaped = text[index];

        if (escaped === "u") {
          const code = text.slice(index + 1, index + 5);

          if (!/^[0-9a-fA-F]{4}$/.test(code)) {
            throw error("Invalid unicode escape.");
          }

          value += String.fromCharCode(parseInt(code, 16));
          index += 5;
          continue;
        }

        const escapeMap = {
          "\"": "\"",
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };

        if (!(escaped in escapeMap)) {
          index = escapeStart;
          throw error("Invalid string escape.");
        }

        value += escapeMap[escaped];
        index += 1;
        continue;
      }

      value += char;
      index += 1;
    }

    throw error("Unterminated string.");
  }

  function parseLiteralOrNumber() {
    const remaining = text.slice(index);

    for (const literal of ["true", "false", "null"]) {
      if (remaining.startsWith(literal)) {
        index += literal.length;
        return;
      }
    }

    const number = remaining.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);

    if (number) {
      index += number[0].length;
      return;
    }

    throw error("Expected JSON value.");
  }

  function recordKey(pathParts, keyLocation) {
    keys.push({
      path: pathParts.join("."),
      keyStart: keyLocation.keyStart,
      keyEnd: keyLocation.keyEnd,
    });
  }

  function recordKeyLocation(pathParts, keyLocation) {
    keyLocations.push({
      path: pathParts.join("."),
      keyStart: keyLocation.keyStart,
      keyEnd: keyLocation.keyEnd,
    });
  }

  function expect(char) {
    if (text[index] !== char) {
      throw error(`Expected '${char}'.`);
    }

    index += 1;
  }

  function skipWhitespace() {
    while (/\s/.test(text[index] || "")) {
      index += 1;
    }
  }

  function error(message) {
    return new Error(message);
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  analyzeJsonDocument,
  analyzeTsxDocument,
  findJsonKeyLocation,
  findTranslationCalls,
  findTranslationContexts,
  findTranslationKeyAtOffset,
  inspectDocument,
  isLocaleJsonFile,
  parseJsonWithLocations,
};
