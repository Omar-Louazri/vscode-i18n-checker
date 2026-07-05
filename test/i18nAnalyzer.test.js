"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { analyzeJsonDocument, analyzeTsxDocument } = require("../src/i18nAnalyzer");

test("json keys used through another TSX file are not reported as unused", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/common.json": JSON.stringify(
      {
        save: "Enregistrer",
        cancel: "Annuler",
        unused: "Inutilise",
      },
      null,
      2,
    ),
    "app/actions.tsx": `
      export function Actions() {
        const common = useTranslation("common");
        return <button>{common.t("save")}</button>;
      }
    `,
    "app/dialog.tsx": `
      export function Dialog() {
        const common = useTranslation("common");
        return <button>{common("cancel")}</button>;
      }
    `,
  });
  const filePath = path.join(workspaceRoot, "public/fr/common.json");
  const diagnostics = analyzeJsonDocument({
    text: fs.readFileSync(filePath, "utf8"),
    filePath,
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ['Translation key "unused" is not used by any TSX file with namespace "common".'],
  );
});

test("tsx key checks understand assigned hook variables", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/common.json": JSON.stringify({ save: "Enregistrer" }, null, 2),
    "public/en/common.json": JSON.stringify({ save: "Save" }, null, 2),
  });
  const text = `
    export function Actions() {
      const common = useTranslation("common");
      return <button>{common.t("missing")}</button>;
    }
  `;

  const diagnostics = analyzeTsxDocument({
    text,
    filePath: path.join(workspaceRoot, "app/actions.tsx"),
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.equal(diagnostics.length, 1);
  assert.equal(
    diagnostics[0].message,
    'Add the attribute "missing" to these JSON files: public/en/common.json, public/fr/common.json.',
  );
});

test("tsx key checks expand template keys from indexed const object keys", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/calls.json": JSON.stringify(
      {
        outcome: {
          pending: "En attente",
          answered: "Repondu",
        },
      },
      null,
      2,
    ),
    "public/en/calls.json": JSON.stringify(
      {
        outcome: {
          pending: "Pending",
        },
      },
      null,
      2,
    ),
  });
  const text = `
    type CallStatus = "pending" | "answered";
    const STATUS_CLASSES: Record<CallStatus, string> = {
      pending: "bg-gray-100",
      answered: "bg-green-100",
    };

    export function CallBadge({ call }) {
      const { t } = useTranslation("calls");
      return (
        <Badge className={STATUS_CLASSES[call.status]}>
          {t(\`outcome.\${call.status}\`, call.status.replace(/_/g, " "))}
        </Badge>
      );
    }
  `;

  const diagnostics = analyzeTsxDocument({
    text,
    filePath: path.join(workspaceRoot, "app/calls.tsx"),
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ['Add the attribute "outcome.answered" to public/en/calls.json.'],
  );
});

test("json key checks count expanded template keys as used", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/calls.json": JSON.stringify(
      {
        outcome: {
          pending: "En attente",
          answered: "Repondu",
          failed: "Echec",
        },
      },
      null,
      2,
    ),
    "app/calls.tsx": `
      type CallStatus = "pending" | "answered";
      const STATUS_CLASSES: Record<CallStatus, string> = {
        pending: "bg-gray-100",
        answered: "bg-green-100",
      };

      export function CallBadge({ call }) {
        const { t } = useTranslation("calls");
        return <span className={STATUS_CLASSES[call.status]}>{t(\`outcome.\${call.status}\`)}</span>;
      }
    `,
  });
  const filePath = path.join(workspaceRoot, "public/fr/calls.json");
  const diagnostics = analyzeJsonDocument({
    text: fs.readFileSync(filePath, "utf8"),
    filePath,
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ['Translation key "outcome.failed" is not used by any TSX file with namespace "calls".'],
  );
});

function createWorkspace(files) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "simple-i18n-checker-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return workspaceRoot;
}
