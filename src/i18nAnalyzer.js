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

function analyzeTsxDocument({ text, filePath, workspaceRoot, openDocuments, dictionaryPublicPaths, cache }) {
  const diagnostics = [];
  const contexts = findTranslationContexts(text);

  for (const context of contexts) {
    const dictionaries = readDictionaries(workspaceRoot, context.namespace, openDocuments, dictionaryPublicPaths, cache);
    const existingDictionaries = dictionaries.files.filter((file) => file.exists);
    const namespaceTarget = existingDictionaries.length
      ? existingDictionaries.map((file) => path.relative(workspaceRoot, file.filePath)).join(", ")
      : getNamespaceTarget(workspaceRoot, context.namespace, dictionaryPublicPaths, cache);
    const checkedKeys = new Set();

    for (const usage of findTranslationUsagesForContext(text, context)) {
      if (checkedKeys.has(usage.key)) {
        continue;
      }

      checkedKeys.add(usage.key);

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
          message:
            missingFiles.length === 1
              ? `Add the attribute "${usage.key}" to ${missingFiles[0]}.`
              : `Add the attribute "${usage.key}" to these JSON files: ${missingFiles.join(", ")}.`,
          severity: "warning",
        });
      }
    }
  }

  return diagnostics;
}

function analyzeJsonDocument({ text, filePath, workspaceRoot, openDocuments, dictionaryPublicPaths, cache }) {
  const info = getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths, cache);

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

  const usedKeys = findWorkspaceTranslationKeys(
    workspaceRoot,
    info.namespace,
    openDocuments,
    dictionaryPublicPaths,
    cache,
  );

  return parsed.keys
    .filter((key) => !usedKeys.has(key.path))
    .map((key) => ({
      start: key.keyStart,
      end: key.keyEnd,
      message: `Translation key "${key.path}" is not used by any TSX file with namespace "${info.namespace}".`,
      severity: "warning",
      code: "unusedTranslationKey",
      data: {
        keyPath: key.path,
        namespace: info.namespace,
      },
    }));
}

function inspectDocument({ text, filePath, workspaceRoot, openDocuments, dictionaryPublicPaths, cache }) {
  if (path.extname(filePath) === ".tsx") {
    const contexts = findTranslationContexts(text);

    return {
      kind: "tsx",
      filePath,
      contexts: contexts.map((context) => ({
        namespace: context.namespace,
        tName: context.tName,
        dictionaries: readDictionaries(workspaceRoot, context.namespace, openDocuments, dictionaryPublicPaths, cache).files.map((file) => ({
          locale: file.locale,
          language: getSupportedLanguageName(file.locale),
          exists: file.exists,
          filePath: path.relative(workspaceRoot, file.filePath),
          keyCount: file.keys.size,
        })),
        usages: findTranslationUsagesForContext(text, context).map((usage) => usage.key),
      })),
    };
  }

  if (path.extname(filePath) === ".json") {
    const info = getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths, cache);
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
      usedKeys: info
        ? [...findWorkspaceTranslationKeys(workspaceRoot, info.namespace, openDocuments, dictionaryPublicPaths, cache)].sort()
        : [],
    };
  }

  return {
    kind: "unsupported",
    filePath,
  };
}

function findTranslationKeyAtOffset(text, offset) {
  for (const context of findTranslationContexts(text)) {
    for (const usage of findTranslationUsagesForContext(text, context)) {
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

  if (usage.isDynamic) {
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

function findJsonKeyDeletionRange(text, targetPath) {
  return findJsonKeyDeletionRanges(text, [targetPath])[0] ?? null;
}

function findJsonKeyDeletionRanges(text, targetPaths) {
  const parsed = parseJsonWithLocations(text);

  if (parsed.error) {
    return [];
  }

  const removalPlan = createJsonKeyRemovalPlan(parsed.keyLocations, new Set(targetPaths));
  const ranges = [];

  for (const siblings of removalPlan.siblingGroups.values()) {
    const targetSiblings = siblings.filter((key) => removalPlan.targets.has(key));

    if (!targetSiblings.length) {
      continue;
    }

    ranges.push(...createSiblingRemovalRanges(text, siblings, targetSiblings));
  }

  const mergedRanges = mergeTextRanges(ranges);

  return isValidJsonAfterRemovingRanges(text, mergedRanges) ? mergedRanges : [];
}

function createJsonKeyRemovalPlan(keyLocations, targetPathSet) {
  const descendantLeavesByPath = indexDescendantLeavesByPath(keyLocations);
  const targets = new Set(keyLocations.filter((keyLocation) => targetPathSet.has(keyLocation.path)));

  for (const keyLocation of keyLocations) {
    if (keyLocation.isLeaf) {
      continue;
    }

    const descendantLeaves = descendantLeavesByPath.get(keyLocation.path) ?? [];

    if (!descendantLeaves.length) {
      continue;
    }

    if (descendantLeaves.every((descendant) => targetPathSet.has(descendant.path))) {
      targets.add(keyLocation);
    }
  }

  return {
    targets: keepTopLevelRemovalTargets(targets),
    siblingGroups: groupKeyLocationsByParent(keyLocations),
  };
}

function indexDescendantLeavesByPath(keyLocations) {
  const descendantLeavesByPath = new Map();

  for (const keyLocation of keyLocations) {
    if (!keyLocation.isLeaf) {
      continue;
    }

    const parts = keyLocation.path.split(".");

    for (let index = 1; index < parts.length; index += 1) {
      const ancestorPath = parts.slice(0, index).join(".");
      const descendants = descendantLeavesByPath.get(ancestorPath) ?? [];
      descendants.push(keyLocation);
      descendantLeavesByPath.set(ancestorPath, descendants);
    }
  }

  return descendantLeavesByPath;
}

function keepTopLevelRemovalTargets(removalTargets) {
  const targets = [...removalTargets];
  return new Set(
    targets.filter(
      (target) =>
        !targets.some(
          (candidate) =>
            candidate !== target &&
            target.path.startsWith(`${candidate.path}.`),
        ),
    ),
  );
}

function groupKeyLocationsByParent(keyLocations) {
  const groups = new Map();

  for (const keyLocation of keyLocations) {
    const siblings = groups.get(keyLocation.parentPath) ?? [];
    siblings.push(keyLocation);
    groups.set(keyLocation.parentPath, siblings);
  }

  return groups;
}

function createSiblingRemovalRanges(text, siblings, targetSiblings) {
  const ranges = [];
  const targetSiblingSet = new Set(targetSiblings);

  for (const target of targetSiblings) {
    if (target.commaStart !== null) {
      ranges.push({
        start: findLeadingWhitespaceStart(text, target.propertyStart),
        end: includeFollowingLineWhitespace(text, target.commaStart + 1),
      });
      continue;
    }

    const previousKept = findPreviousKeptSibling(siblings, target, targetSiblingSet);

    if (previousKept?.commaStart !== null && previousKept?.commaStart !== undefined) {
      ranges.push({
        start: previousKept.commaStart,
        end: target.propertyEnd,
      });
      continue;
    }

    ranges.push({
      start: findLeadingWhitespaceStart(text, target.propertyStart),
      end: includeFollowingLineWhitespace(text, target.propertyEnd),
    });
  }

  return ranges;
}

function findPreviousKeptSibling(siblings, target, targetSiblingSet) {
  let previousKept = null;

  for (const sibling of siblings) {
    if (sibling === target) {
      return previousKept;
    }

    if (!targetSiblingSet.has(sibling)) {
      previousKept = sibling;
    }
  }

  return null;
}

function findUnusedTranslationKeyRemovalEdits({
  workspaceRoot,
  namespace,
  keyPath,
  openDocuments,
  dictionaryPublicPaths,
  cache,
}) {
  return findUnusedTranslationKeysRemovalEdits({
    workspaceRoot,
    namespace,
    keyPaths: [keyPath],
    openDocuments,
    dictionaryPublicPaths,
    cache,
  });
}

function findUnusedTranslationKeysRemovalEdits({
  workspaceRoot,
  namespace,
  keyPaths,
  openDocuments,
  dictionaryPublicPaths,
  cache,
}) {
  const edits = [];
  const targetPaths = [...new Set(keyPaths)].filter(Boolean);

  if (!targetPaths.length) {
    return edits;
  }

  for (const dictionary of findDictionaryTargets(workspaceRoot, namespace, dictionaryPublicPaths, cache)) {
    if (!dictionary.exists) {
      continue;
    }

    const text = readTextFile(dictionary.filePath, openDocuments);
    const ranges = findJsonKeyDeletionRanges(text, targetPaths);

    edits.push(
      ...ranges.map((range) => ({
        filePath: dictionary.filePath,
        start: range.start,
        end: range.end,
        startPosition: offsetToLineCharacter(text, range.start),
        endPosition: offsetToLineCharacter(text, range.end),
      })),
    );
  }

  return edits;
}

function mergeTextRanges(ranges) {
  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedRanges = [];

  for (const range of sortedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];

    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }

    mergedRanges.push({ ...range });
  }

  return mergedRanges;
}

function isValidJsonAfterRemovingRanges(text, ranges) {
  const nextText = applyTextRemovals(text, ranges);
  return !parseJsonWithLocations(nextText).error;
}

function applyTextRemovals(text, ranges) {
  return [...ranges]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (currentText, range) => `${currentText.slice(0, range.start)}${currentText.slice(range.end)}`,
      text,
    );
}

function findTranslationContexts(text) {
  const contexts = [];
  const assignmentRegex =
    /\bconst\s+(?:\{(?<destructure>[^}]+)\}|(?<identifier>[A-Za-z_$][\w$]*))\s*=\s*(?:useTranslation|useTranslate)\s*\(\s*(["'`])(?<namespace>[^"'`]+)\3\s*\)/g;

  for (const match of text.matchAll(assignmentRegex)) {
    const namespace = match.groups.namespace;
    if (match.groups.destructure) {
      const tName = findDestructuredLocalName(match.groups.destructure, "t");

      if (tName) {
        contexts.push({ namespace, tName });
      }
      continue;
    }

    if (match.groups.identifier) {
      contexts.push({ namespace, tName: match.groups.identifier, objectName: match.groups.identifier });
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
  const callRegex = new RegExp(`(?<![\\w$.])${escapedName}\\s*\\(`, "g");
  const usages = [];
  const dynamicValues = findDynamicExpressionValues(text);

  for (const match of text.matchAll(callRegex)) {
    usages.push(...parseTranslationKeyArgument(text, match.index + match[0].length, dynamicValues));
  }

  return usages;
}

function findTranslationCallsForContext(text, context) {
  const usages = [];

  if (context.tName) {
    usages.push(...findTranslationCalls(text, context.tName));
  }

  if (context.objectName) {
    usages.push(...findMemberTranslationCalls(text, context.objectName, "t"));
  }

  return usages.sort((left, right) => left.keyStart - right.keyStart);
}

function findTranslationUsagesForContext(text, context, knownKeys = null) {
  return dedupeTranslationUsages([
    ...findTranslationCallsForContext(text, context),
    ...findContextualTranslationKeyLiterals(text, knownKeys),
  ]);
}

function dedupeTranslationUsages(usages) {
  const seen = new Set();
  const result = [];

  for (const usage of usages.sort((left, right) => left.keyStart - right.keyStart)) {
    const key = `${usage.key}\0${usage.keyStart}\0${usage.keyEnd}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(usage);
  }

  return result;
}

function findMemberTranslationCalls(text, objectName, methodName) {
  const escapedObjectName = escapeRegExp(objectName);
  const escapedMethodName = escapeRegExp(methodName);
  const callRegex = new RegExp(
    `(?<![\\w$])${escapedObjectName}\\s*\\.\\s*${escapedMethodName}\\s*\\(`,
    "g",
  );
  const usages = [];
  const dynamicValues = findDynamicExpressionValues(text);

  for (const match of text.matchAll(callRegex)) {
    usages.push(...parseTranslationKeyArgument(text, match.index + match[0].length, dynamicValues));
  }

  return usages;
}

function findContextualTranslationKeyLiterals(text, knownKeys = null) {
  return findStringLiterals(text)
    .filter((literal) => isContextualTranslationKeyLiteral(text, literal, knownKeys))
    .map((literal) => ({
      key: literal.value,
      keyStart: literal.valueStart,
      keyEnd: literal.valueEnd,
      isDynamic: false,
    }));
}

function isContextualTranslationKeyLiteral(text, literal, knownKeys) {
  if (!literal.value || !isTranslationKeyLikeValue(literal.value)) {
    return false;
  }

  const hasKnownKey = knownKeys?.has?.(literal.value);
  const translationHint = getTranslationPropertyHint(text, literal.start);

  if (translationHint) {
    if (isGenericTranslationKeyPropertyName(translationHint)) {
      return literal.value.includes(".");
    }

    return true;
  }

  return literal.value.includes(".") && (!knownKeys || hasKnownKey);
}

function isTranslationKeyLikeValue(value) {
  return /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(value);
}

function getTranslationPropertyHint(text, literalStart) {
  const previous = findPreviousSignificantToken(text, literalStart);

  if (!previous) {
    return null;
  }

  if (previous.value === ":") {
    const propertyName = readPropertyNameBefore(text, previous.start);
    return isTranslationKeyPropertyName(propertyName) ? propertyName : null;
  }

  if (previous.value === "=") {
    const attributeName = readIdentifierBefore(text, previous.start);
    return isTranslationKeyPropertyName(attributeName) ? attributeName : null;
  }

  return null;
}

function isTranslationKeyPropertyName(name) {
  return /(?:^|[_-])(?:i18n|translation|translate|trans|locale|label|title|subtitle|description|message|placeholder|tooltip|ariaLabel)?(?:Key|Path)$/i.test(
    name || "",
  );
}

function isGenericTranslationKeyPropertyName(name) {
  return /^(?:key|path)$/i.test(name || "");
}

function readPropertyNameBefore(text, offset) {
  let index = skipWhitespaceBackward(text, offset - 1);
  const quote = text[index];

  if (quote === "\"" || quote === "'") {
    const end = index;
    index -= 1;

    while (index >= 0) {
      if (text[index] === "\\") {
        index -= 2;
        continue;
      }

      if (text[index] === quote) {
        return text.slice(index + 1, end);
      }

      index -= 1;
    }

    return "";
  }

  return readIdentifierBefore(text, index + 1);
}

function readIdentifierBefore(text, offset) {
  let index = skipWhitespaceBackward(text, offset - 1);
  const end = index + 1;

  while (index >= 0 && /[A-Za-z0-9_$-]/.test(text[index] || "")) {
    index -= 1;
  }

  return text.slice(index + 1, end);
}

function findPreviousSignificantToken(text, offset) {
  let index = skipWhitespaceBackward(text, offset - 1);

  while (index >= 0) {
    if (isLineCommentEnd(text, index)) {
      index = findLineCommentStartBefore(text, index - 1);
      index = skipWhitespaceBackward(text, index - 1);
      continue;
    }

    if (isBlockCommentEnd(text, index)) {
      index = findBlockCommentStartBefore(text, index - 1);
      index = skipWhitespaceBackward(text, index - 1);
      continue;
    }

    return { value: text[index], start: index };
  }

  return null;
}

function findStringLiterals(text) {
  const literals = [];
  let index = 0;

  while (index < text.length) {
    if (isLineCommentStart(text, index)) {
      index = findLineCommentEnd(text, index + 2);
      continue;
    }

    if (isBlockCommentStart(text, index)) {
      index = findBlockCommentEnd(text, index + 2);
      continue;
    }

    const char = text[index];

    if (char === "\"" || char === "'") {
      const parsed = parseQuotedString(text, index, char);

      if (parsed) {
        literals.push({
          value: parsed.value,
          start: index,
          valueStart: parsed.valueStart,
          valueEnd: parsed.valueEnd,
          end: parsed.valueEnd + 1,
        });
        index = parsed.valueEnd + 1;
        continue;
      }
    }

    if (char === "`") {
      const parsed = parseTemplateLiteral(text, index);

      if (parsed && !parsed.expressions.length) {
        literals.push({
          value: parsed.parts[0],
          start: index,
          valueStart: parsed.contentStart,
          valueEnd: parsed.contentEnd,
          end: parsed.contentEnd + 1,
        });
        index = parsed.contentEnd + 1;
        continue;
      }
    }

    index += 1;
  }

  return literals;
}

function parseTranslationKeyArgument(text, offset, dynamicValues) {
  const keyStart = skipWhitespaceAt(text, offset);
  const quote = text[keyStart];

  if (quote === "\"" || quote === "'") {
    const parsed = parseQuotedString(text, keyStart, quote);

    if (!parsed) {
      return [];
    }

    return [
      {
        key: parsed.value,
        keyStart: parsed.valueStart,
        keyEnd: parsed.valueEnd,
      },
    ];
  }

  if (quote !== "`") {
    const parsedExpression = parseCallArgumentExpression(text, keyStart);

    if (!parsedExpression) {
      return [];
    }

    const values = dynamicValues.get(normalizeExpression(parsedExpression.source));

    if (!values?.length) {
      return [];
    }

    return values.map((key) => ({
      key,
      keyStart,
      keyEnd: parsedExpression.end,
      isDynamic: true,
    }));
  }

  const parsedTemplate = parseTemplateLiteral(text, keyStart);

  if (!parsedTemplate) {
    return [];
  }

  if (!parsedTemplate.expressions.length) {
    return [
      {
        key: parsedTemplate.parts[0],
        keyStart: parsedTemplate.contentStart,
        keyEnd: parsedTemplate.contentEnd,
      },
    ];
  }

  const expressionValues = [];

  for (const expression of parsedTemplate.expressions) {
    const values = dynamicValues.get(normalizeExpression(expression.source));

    if (!values?.length) {
      return [];
    }

    expressionValues.push(values);
  }

  return combineTemplateValues(parsedTemplate.parts, expressionValues).map((key) => ({
    key,
    keyStart: parsedTemplate.contentStart,
    keyEnd: parsedTemplate.contentEnd,
    isDynamic: true,
  }));
}

function parseCallArgumentExpression(text, start) {
  let index = start;
  let depth = 0;
  let quote = null;

  while (index < text.length) {
    const char = text[index];

    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (isLineCommentStart(text, index)) {
      index = findLineCommentEnd(text, index + 2);
      continue;
    }

    if (isBlockCommentStart(text, index)) {
      index = findBlockCommentEnd(text, index + 2);
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        break;
      }

      depth -= 1;
      index += 1;
      continue;
    }

    if (char === "," && depth === 0) {
      break;
    }

    index += 1;
  }

  const end = trimTrailingWhitespaceEnd(text, start, index);
  const source = text.slice(start, end);

  return source.trim() ? { source, end } : null;
}

function parseQuotedString(text, start, quote) {
  let index = start + 1;
  let value = "";

  while (index < text.length) {
    const char = text[index];

    if (char === quote) {
      return {
        value,
        valueStart: start + 1,
        valueEnd: index,
      };
    }

    if (char === "\\") {
      if (index + 1 >= text.length) {
        return null;
      }

      value += text[index + 1];
      index += 2;
      continue;
    }

    value += char;
    index += 1;
  }

  return null;
}

function parseTemplateLiteral(text, start) {
  let index = start + 1;
  let currentPart = "";
  const parts = [];
  const expressions = [];

  while (index < text.length) {
    const char = text[index];

    if (char === "`") {
      parts.push(currentPart);
      return {
        parts,
        expressions,
        contentStart: start + 1,
        contentEnd: index,
      };
    }

    if (char === "\\") {
      if (index + 1 >= text.length) {
        return null;
      }

      currentPart += text[index + 1];
      index += 2;
      continue;
    }

    if (char === "$" && text[index + 1] === "{") {
      const expression = parseTemplateExpression(text, index + 2);

      if (!expression) {
        return null;
      }

      parts.push(currentPart);
      expressions.push(expression);
      currentPart = "";
      index = expression.end + 1;
      continue;
    }

    currentPart += char;
    index += 1;
  }

  return null;
}

function parseTemplateExpression(text, start) {
  let index = start;
  let depth = 1;
  let quote = null;
  let templateDepth = 0;

  while (index < text.length) {
    const char = text[index];

    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (isLineCommentStart(text, index)) {
      index = findLineCommentEnd(text, index + 2);
      continue;
    }

    if (isBlockCommentStart(text, index)) {
      index = findBlockCommentEnd(text, index + 2);
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      index += 1;
      continue;
    }

    if (char === "`") {
      templateDepth = templateDepth ? templateDepth - 1 : templateDepth + 1;
      index += 1;
      continue;
    }

    if (!templateDepth && char === "{") {
      depth += 1;
      index += 1;
      continue;
    }

    if (!templateDepth && char === "}") {
      depth -= 1;

      if (depth === 0) {
        return {
          source: text.slice(start, index),
          start,
          end: index,
        };
      }
    }

    index += 1;
  }

  return null;
}

function combineTemplateValues(parts, expressionValues) {
  let combinations = [parts[0]];

  for (let index = 0; index < expressionValues.length; index += 1) {
    const nextCombinations = [];

    for (const prefix of combinations) {
      for (const value of expressionValues[index]) {
        nextCombinations.push(`${prefix}${value}${parts[index + 1]}`);
      }
    }

    combinations = nextCombinations;
  }

  return combinations;
}

function findDynamicExpressionValues(text) {
  const objects = findConstObjectData(text);
  const expressionValues = new Map();

  for (const [objectName, objectData] of objects) {
    const accessRegex = new RegExp(`(?<![\\w$])${escapeRegExp(objectName)}\\s*\\[([^\\]]+)\\]`, "g");

    for (const match of text.matchAll(accessRegex)) {
      addExpressionValues(expressionValues, normalizeExpression(match[1]), objectData.keys);
    }

    for (const [propertyName, values] of objectData.stringPropertyValues) {
      const escapedPropertyName = escapeRegExp(propertyName);
      const directAccessRegex = new RegExp(
        `(?<![\\w$])${escapeRegExp(objectName)}\\s*\\[[^\\]]+\\]\\s*\\.\\s*${escapedPropertyName}`,
        "g",
      );

      for (const match of text.matchAll(directAccessRegex)) {
        addExpressionValues(expressionValues, normalizeExpression(match[0]), values);
      }

      const aliasRegex = new RegExp(
        `\\bconst\\s+([A-Za-z_$][\\w$]*)\\b(?:\\s*:[^=]+)?\\s*=\\s*${escapeRegExp(objectName)}\\s*\\[[^\\]]+\\]`,
        "g",
      );

      for (const match of text.matchAll(aliasRegex)) {
        addExpressionValues(expressionValues, `${match[1]}.${propertyName}`, values);
      }
    }
  }

  return expressionValues;
}

function findConstObjectKeySets(text) {
  const objects = findConstObjectData(text);

  return new Map([...objects].map(([objectName, objectData]) => [objectName, objectData.keys]));
}

function findConstObjectData(text) {
  const objects = new Map();
  const constRegex = /\bconst\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*\{/g;

  for (const match of text.matchAll(constRegex)) {
    const objectStart = match.index + match[0].length - 1;
    const objectEnd = findMatchingBrace(text, objectStart);

    if (objectEnd === -1) {
      continue;
    }

    const source = text.slice(objectStart + 1, objectEnd);
    const keys = parseTopLevelObjectKeys(source);
    const stringPropertyValues = parseNestedStringPropertyValues(source);

    if (keys.length || stringPropertyValues.size) {
      objects.set(match[1], { keys, stringPropertyValues });
    }
  }

  return objects;
}

function parseTopLevelObjectKeys(source) {
  return parseTopLevelObjectProperties(source).map((property) => property.key);
}

function parseTopLevelObjectProperties(source) {
  const properties = [];
  let index = 0;

  while (index < source.length) {
    index = skipWhitespaceAndCommasAt(source, index);

    if (index >= source.length) {
      break;
    }

    const key = parseObjectPropertyKey(source, index);

    if (!key) {
      index += 1;
      continue;
    }

    index = skipWhitespaceAt(source, key.end);

    if (source[index] !== ":") {
      continue;
    }

    index += 1;
    const valueStart = skipWhitespaceAt(source, index);
    index = valueStart;
    let depth = 0;
    let valueEnd = source.length;

    while (index < source.length) {
      const char = source[index];

      if (isLineCommentStart(source, index)) {
        index = findLineCommentEnd(source, index + 2);
        continue;
      }

      if (isBlockCommentStart(source, index)) {
        index = findBlockCommentEnd(source, index + 2);
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        const end = findStringEnd(source, index, char);
        index = end === -1 ? source.length : end + 1;
        continue;
      }

      if (char === "{" || char === "[" || char === "(") {
        depth += 1;
      } else if (char === "}" || char === "]" || char === ")") {
        depth = Math.max(0, depth - 1);
      } else if (char === "," && depth === 0) {
        valueEnd = index;
        index += 1;
        break;
      }

      index += 1;
    }

    properties.push({
      key: key.value,
      valueStart,
      valueEnd: trimTrailingWhitespaceEnd(source, valueStart, valueEnd),
    });
  }

  return properties;
}

function parseNestedStringPropertyValues(source) {
  const propertyValues = new Map();

  for (const property of parseTopLevelObjectProperties(source)) {
    if (source[property.valueStart] !== "{") {
      continue;
    }

    const objectEnd = findMatchingBrace(source, property.valueStart);

    if (objectEnd === -1 || objectEnd > property.valueEnd) {
      continue;
    }

    for (const nestedProperty of parseDirectStringProperties(
      source.slice(property.valueStart + 1, objectEnd),
    )) {
      const existing = propertyValues.get(nestedProperty.key) ?? [];
      propertyValues.set(nestedProperty.key, [...new Set([...existing, nestedProperty.value])]);
    }
  }

  return propertyValues;
}

function parseDirectStringProperties(source) {
  const stringProperties = [];

  for (const property of parseTopLevelObjectProperties(source)) {
    const quote = source[property.valueStart];

    if (quote !== "\"" && quote !== "'") {
      continue;
    }

    const parsed = parseQuotedString(source, property.valueStart, quote);

    if (!parsed || parsed.valueEnd + 1 > property.valueEnd) {
      continue;
    }

    stringProperties.push({ key: property.key, value: parsed.value });
  }

  return stringProperties;
}

function parseObjectPropertyKey(source, start) {
  const char = source[start];

  if (char === "\"" || char === "'") {
    const parsed = parseQuotedString(source, start, char);

    return parsed
      ? {
          value: parsed.value,
          end: parsed.valueEnd + 1,
        }
      : null;
  }

  const identifier = source.slice(start).match(/^[A-Za-z_$][\w$-]*/);

  if (!identifier) {
    return null;
  }

  return {
    value: identifier[0],
    end: start + identifier[0].length,
  };
}

function addExpressionValues(expressionValues, expression, values) {
  if (!expression) {
    return;
  }

  const existing = expressionValues.get(expression) ?? [];
  expressionValues.set(expression, [...new Set([...existing, ...values])]);
}

function findMatchingBrace(text, start) {
  let index = start;
  let depth = 0;
  let quote = null;

  while (index < text.length) {
    const char = text[index];

    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }

    if (isLineCommentStart(text, index)) {
      index = findLineCommentEnd(text, index + 2);
      continue;
    }

    if (isBlockCommentStart(text, index)) {
      index = findBlockCommentEnd(text, index + 2);
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }

    index += 1;
  }

  return -1;
}

function findStringEnd(text, start, quote) {
  let index = start + 1;

  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }

    if (text[index] === quote) {
      return index;
    }

    index += 1;
  }

  return -1;
}

function skipWhitespaceAt(text, offset) {
  let index = offset;

  while (index < text.length) {
    if (/\s/.test(text[index] || "")) {
      index += 1;
      continue;
    }

    if (isLineCommentStart(text, index)) {
      index = findLineCommentEnd(text, index + 2);
      continue;
    }

    if (isBlockCommentStart(text, index)) {
      index = findBlockCommentEnd(text, index + 2);
      continue;
    }

    break;
  }

  return index;
}

function skipWhitespaceAndCommasAt(text, offset) {
  let index = offset;

  while (index < text.length) {
    if (/[\s,]/.test(text[index] || "")) {
      index += 1;
      continue;
    }

    if (isLineCommentStart(text, index)) {
      index = findLineCommentEnd(text, index + 2);
      continue;
    }

    if (isBlockCommentStart(text, index)) {
      index = findBlockCommentEnd(text, index + 2);
      continue;
    }

    break;
  }

  return index;
}

function skipWhitespaceBackward(text, offset) {
  let index = offset;

  while (index >= 0 && /\s/.test(text[index] || "")) {
    index -= 1;
  }

  return index;
}

function isLineCommentStart(text, index) {
  return text[index] === "/" && text[index + 1] === "/";
}

function isBlockCommentStart(text, index) {
  return text[index] === "/" && text[index + 1] === "*";
}

function isLineCommentEnd(text, index) {
  return text[index] === "\n";
}

function isBlockCommentEnd(text, index) {
  return text[index - 1] === "*" && text[index] === "/";
}

function findLineCommentEnd(text, offset) {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end + 1;
}

function findBlockCommentEnd(text, offset) {
  const end = text.indexOf("*/", offset);
  return end === -1 ? text.length : end + 2;
}

function findLineCommentStartBefore(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  const commentStart = text.lastIndexOf("//", offset);

  return commentStart >= lineStart ? commentStart : lineStart;
}

function findBlockCommentStartBefore(text, offset) {
  const commentStart = text.lastIndexOf("/*", offset);
  return commentStart === -1 ? 0 : commentStart;
}

function trimTrailingWhitespaceEnd(text, start, end) {
  let index = Math.max(start, end);

  while (index > start && /\s/.test(text[index - 1] || "")) {
    index -= 1;
  }

  return index;
}

function findLeadingWhitespaceStart(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);

  return /^[ \t]*$/.test(prefix) ? lineStart : offset;
}

function includeFollowingLineWhitespace(text, offset) {
  let index = offset;

  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }

  if (text[index] === "\r" && text[index + 1] === "\n") {
    return index + 2;
  }

  if (text[index] === "\n") {
    return index + 1;
  }

  return index;
}

function offsetToLineCharacter(text, offset) {
  let line = 0;
  let character = 0;
  const end = Math.max(0, Math.min(offset, text.length));

  for (let index = 0; index < end; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }

  return { line, character };
}

function normalizeExpression(source) {
  return source.replace(/\s+/g, "");
}

function getCacheMap(cache, key) {
  if (!cache) {
    return null;
  }

  if (!cache[key]) {
    cache[key] = new Map();
  }

  return cache[key];
}

function readDictionaries(workspaceRoot, namespace, openDocuments, dictionaryPublicPaths, cache) {
  const files = [];

  for (const target of findDictionaryTargets(workspaceRoot, namespace, dictionaryPublicPaths, cache)) {
    let keys = new Set();

    if (target.exists) {
      const text = readTextFile(target.filePath, openDocuments);
      const parsed = parseJsonWithLocations(text);
      keys = new Set(parsed.keys.map((key) => key.path));
    }

    files.push({
      ...target,
      keys,
    });
  }

  return { files };
}

function findDictionaryTargets(workspaceRoot, namespace, dictionaryPublicPaths, cache) {
  const files = [];

  for (const publicDir of findPublicDirectories(workspaceRoot, dictionaryPublicPaths, cache)) {
    for (const locale of safeReadDir(publicDir)) {
      const localeDir = path.join(publicDir, locale);

      if (!isSupportedLanguageCode(locale) || !isDirectory(localeDir)) {
        continue;
      }

      const filePath = path.join(localeDir, `${namespace}.json`);

      files.push({
        locale,
        filePath,
        exists: fs.existsSync(filePath),
      });
    }
  }

  return files;
}

function getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths, cache) {
  for (const publicDir of findPublicDirectories(workspaceRoot, dictionaryPublicPaths, cache)) {
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

function isLocaleJsonFile(filePath, workspaceRoot, dictionaryPublicPaths, cache) {
  return Boolean(getLocaleJsonInfo(filePath, workspaceRoot, dictionaryPublicPaths, cache));
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

function getNamespaceTarget(workspaceRoot, namespace, dictionaryPublicPaths, cache) {
  const publicDirs = findPublicDirectories(workspaceRoot, dictionaryPublicPaths, cache);

  if (!publicDirs.length) {
    return `**/public/*/${namespace}.json`;
  }

  return publicDirs
    .map((publicDir) => `${path.relative(workspaceRoot, publicDir)}/*/${namespace}.json`)
    .join(", ");
}

function findPublicDirectories(workspaceRoot, dictionaryPublicPaths, cache) {
  const cacheKey = `${workspaceRoot}\0${JSON.stringify(dictionaryPublicPaths ?? [])}`;
  const publicDirectoriesCache = getCacheMap(cache, "publicDirectories");
  const cachedPublicDirectories = publicDirectoriesCache?.get(cacheKey);

  if (cachedPublicDirectories) {
    return cachedPublicDirectories;
  }

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

  const result = [...publicDirs];
  publicDirectoriesCache?.set(cacheKey, result);
  return result;

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

function findWorkspaceTranslationKeys(workspaceRoot, namespace, openDocuments, dictionaryPublicPaths, cache) {
  const cacheKey = `${workspaceRoot}\0${namespace}`;
  const workspaceTranslationKeysCache = getCacheMap(cache, "workspaceTranslationKeys");
  const cachedKeys = workspaceTranslationKeysCache?.get(cacheKey);

  if (cachedKeys) {
    return cachedKeys;
  }

  const keys = new Set();
  const knownKeys = new Set();
  const filePaths = new Set(findFiles(workspaceRoot, TSX_EXTENSIONS, cache));

  for (const dictionary of readDictionaries(workspaceRoot, namespace, openDocuments, dictionaryPublicPaths, cache).files) {
    if (!dictionary.exists) {
      continue;
    }

    for (const key of dictionary.keys) {
      knownKeys.add(key);
    }
  }

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

      for (const usage of findTranslationUsagesForContext(text, context, knownKeys)) {
        keys.add(usage.key);
      }
    }
  }

  workspaceTranslationKeysCache?.set(cacheKey, keys);
  return keys;
}

function readTextFile(filePath, openDocuments) {
  if (openDocuments?.has(filePath)) {
    return openDocuments.get(filePath);
  }

  return fs.readFileSync(filePath, "utf8");
}

function findFiles(root, extensions, cache) {
  const cacheKey = `${root}\0${[...extensions].sort().join(",")}`;
  const filesCache = getCacheMap(cache, "files");
  const cachedFiles = filesCache?.get(cacheKey);

  if (cachedFiles) {
    return cachedFiles;
  }

  const results = [];

  walk(root);
  filesCache?.set(cacheKey, results);
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
  const keyLocations = [];

  try {
    parseValue([]);
    skipWhitespace();

    if (index < text.length) {
      throw error("Unexpected characters after JSON value.");
    }

    return {
      keys: getLeafKeys(),
      keyLocations,
    };
  } catch (parseError) {
    return {
      keys: getLeafKeys(),
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
      const propertyStart = index;
      const key = parseString();
      const nextPathParts = [...pathParts, key.value];
      const keyLocation = recordKeyLocation(pathParts, nextPathParts, key, propertyStart);
      skipWhitespace();
      expect(":");
      parseValue(nextPathParts, keyLocation);
      keyLocation.propertyEnd = index;
      skipWhitespace();

      if (text[index] === ",") {
        keyLocation.commaStart = index;
        index += 1;
        continue;
      }

      if (text[index] === "}") {
        keyLocation.commaStart = null;
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

  function recordKey(_pathParts, keyLocation) {
    keyLocation.isLeaf = true;
  }

  function recordKeyLocation(parentPathParts, pathParts, keyLocation, propertyStart) {
    const location = {
      path: pathParts.join("."),
      parentPath: parentPathParts.join("."),
      keyStart: keyLocation.keyStart,
      keyEnd: keyLocation.keyEnd,
      propertyStart,
      propertyEnd: keyLocation.keyEnd + 1,
      commaStart: null,
      isLeaf: false,
    };

    keyLocations.push(location);
    return location;
  }

  function getLeafKeys() {
    return keyLocations
      .filter((key) => key.isLeaf)
      .map((key) => ({
        path: key.path,
        keyStart: key.keyStart,
        keyEnd: key.keyEnd,
        propertyStart: key.propertyStart,
        propertyEnd: key.propertyEnd,
        commaStart: key.commaStart,
        parentPath: key.parentPath,
        isLeaf: key.isLeaf,
      }));
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
  findJsonKeyDeletionRange,
  findJsonKeyDeletionRanges,
  findTranslationCalls,
  findTranslationContexts,
  findTranslationKeyAtOffset,
  findUnusedTranslationKeyRemovalEdits,
  findUnusedTranslationKeysRemovalEdits,
  getSupportedLanguageName,
  inspectDocument,
  isLocaleJsonFile,
  isSupportedLanguageCode,
  parseJsonWithLocations,
  SUPPORTED_LANGUAGES,
};
