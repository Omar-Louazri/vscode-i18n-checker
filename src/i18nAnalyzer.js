"use strict";

const fs = require("fs");
const path = require("path");

const TSX_EXTENSIONS = new Set([".tsx"]);
const IGNORED_DIRECTORIES = new Set([".git", ".next", "node_modules", "vscode-i18n-checker"]);
const SUPPORTED_LANGUAGES = Object.freeze({
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  uk: "Ukrainian",
  pl: "Polish",
  cs: "Czech",
  sk: "Slovak",
  hu: "Hungarian",
  ro: "Romanian",
  bg: "Bulgarian",
  el: "Greek",
  tr: "Turkish",
  sv: "Swedish",
  no: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  et: "Estonian",
  lv: "Latvian",
  lt: "Lithuanian",
  is: "Icelandic",
  ga: "Irish",
  cy: "Welsh",
  ar: "Arabic",
  he: "Hebrew",
  fa: "Persian (Farsi)",
  ur: "Urdu",
  zh: "Chinese (generic)",
  ja: "Japanese",
  ko: "Korean",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  hi: "Hindi",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  mr: "Marathi",
  sw: "Swahili",
  am: "Amharic",
  zu: "Zulu",
  af: "Afrikaans",
  sr: "Serbian",
  hr: "Croatian",
  sl: "Slovenian",
  mk: "Macedonian",
  sq: "Albanian",
  ca: "Catalan",
  eu: "Basque",
  gl: "Galician",
  eo: "Esperanto",
});
const SUPPORTED_LANGUAGE_CODES = new Set(Object.keys(SUPPORTED_LANGUAGES));

function analyzeTsxDocument({ text, filePath, workspaceRoot, openDocuments, dictionaryPublicPaths }) {
  const diagnostics = [];
  const contexts = findTranslationContexts(text);

  for (const context of contexts) {
    const dictionaries = readDictionaries(workspaceRoot, context.namespace, openDocuments, dictionaryPublicPaths);
    const existingDictionaries = dictionaries.files.filter((file) => file.exists);
    const namespaceTarget = existingDictionaries.length
      ? existingDictionaries.map((file) => path.relative(workspaceRoot, file.filePath)).join(", ")
      : getNamespaceTarget(workspaceRoot, context.namespace, dictionaryPublicPaths);

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
        const missingFiles = dictionaries.files
          .filter((file) => !file.keys.has(usage.key))
          .map((file) => path.relative(workspaceRoot, file.filePath));

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

function analyzeJsonDocument({ text, filePath, workspaceRoot, openDocuments, dictionaryPublicPaths }) {
  const info = getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths);

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

function inspectDocument({ text, filePath, workspaceRoot, openDocuments, dictionaryPublicPaths }) {
  if (path.extname(filePath) === ".tsx") {
    const contexts = findTranslationContexts(text);

    return {
      kind: "tsx",
      filePath,
      contexts: contexts.map((context) => ({
        namespace: context.namespace,
        tName: context.tName,
        dictionaries: readDictionaries(workspaceRoot, context.namespace, openDocuments, dictionaryPublicPaths).files.map((file) => ({
          locale: file.locale,
          language: getSupportedLanguageName(file.locale),
          exists: file.exists,
          filePath: path.relative(workspaceRoot, file.filePath),
          keyCount: file.keys.size,
        })),
        usages: findTranslationCalls(text, context.tName).map((usage) => usage.key),
      })),
    };
  }

  if (path.extname(filePath) === ".json") {
    const info = getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths);
    const parsed = parseJsonWithLocations(text);

    return {
      kind: "json",
      filePath,
      locale: info?.locale ?? null,
      language: info?.locale ? getSupportedLanguageName(info.locale) : null,
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

function readDictionaries(workspaceRoot, namespace, openDocuments, dictionaryPublicPaths) {
  const files = [];
  const publicDirs = findPublicDirectories(workspaceRoot, dictionaryPublicPaths);

  if (!publicDirs.length) {
    return { files };
  }

  for (const publicDir of publicDirs) {
    for (const locale of safeReadDir(publicDir)) {
      const localeDir = path.join(publicDir, locale);
      const filePath = path.join(localeDir, `${namespace}.json`);

      if (!isSupportedLanguageCode(locale) || !isDirectory(localeDir)) {
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
  }

  return { files };
}

function getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths) {
  for (const publicDir of findPublicDirectories(workspaceRoot, dictionaryPublicPaths)) {
    const relativePath = path.relative(publicDir, filePath);

    if (!isRelativeChildPath(relativePath)) {
      continue;
    }

    const segments = relativePath.split(path.sep);

    if (segments.length !== 2 || path.extname(segments[1]) !== ".json") {
      continue;
    }

    if (!isSupportedLanguageCode(segments[0])) {
      continue;
    }

    return {
      locale: segments[0],
      language: getSupportedLanguageName(segments[0]),
      namespace: path.basename(segments[1], ".json"),
      publicDir,
    };
  }

  return null;
}

function isLocaleJsonFile(filePath, workspaceRoot, dictionaryPublicPaths) {
  return Boolean(getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths));
}

function findDictionaryFile(workspaceRoot, locale, namespace, dictionaryPublicPaths) {
  if (!isSupportedLanguageCode(locale)) {
    return null;
  }

  for (const publicDir of findPublicDirectories(workspaceRoot, dictionaryPublicPaths)) {
    const filePath = path.join(publicDir, locale, `${namespace}.json`);

    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

function getSupportedLanguageName(locale) {
  return SUPPORTED_LANGUAGES[locale] ?? null;
}

function isSupportedLanguageCode(locale) {
  return SUPPORTED_LANGUAGE_CODES.has(locale);
}

function getNamespaceTarget(workspaceRoot, namespace, dictionaryPublicPaths) {
  const publicDirs = findPublicDirectories(workspaceRoot, dictionaryPublicPaths);

  if (!publicDirs.length) {
    return `**/public/*/${namespace}.json`;
  }

  return publicDirs
    .map((publicDir) => `${path.relative(workspaceRoot, publicDir)}/*/${namespace}.json`)
    .join(", ");
}

function findPublicDirectories(workspaceRoot, dictionaryPublicPaths) {
  const publicDirs = new Set();

  for (const configuredPath of dictionaryPublicPaths ?? []) {
    const publicDir = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(workspaceRoot, configuredPath);

    if (isDirectory(publicDir)) {
      publicDirs.add(publicDir);
    }
  }

  walk(workspaceRoot);

  return [...publicDirs];

  function walk(directory) {
    for (const entry of safeReadDir(directory)) {
      if (IGNORED_DIRECTORIES.has(entry)) {
        continue;
      }

      const entryPath = path.join(directory, entry);

      if (!isDirectory(entryPath)) {
        continue;
      }

      if (entry === "public") {
        publicDirs.add(entryPath);
        continue;
      }

      walk(entryPath);
    }
  }
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

  walk(root);
  return results;

  function walk(directory) {
    for (const entry of safeReadDir(directory)) {
      if (IGNORED_DIRECTORIES.has(entry)) {
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
  findDictionaryFile,
  findJsonKeyLocation,
  findTranslationCalls,
  findTranslationContexts,
  findTranslationKeyAtOffset,
  getSupportedLanguageName,
  inspectDocument,
  isLocaleJsonFile,
  isSupportedLanguageCode,
  parseJsonWithLocations,
  SUPPORTED_LANGUAGES,
};
