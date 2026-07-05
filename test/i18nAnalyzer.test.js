"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  analyzeJsonDocument,
  analyzeTsxDocument,
  findJsonKeyDeletionRanges,
  findUnusedTranslationKeyRemovalEdits,
  findUnusedTranslationKeysRemovalEdits,
} = require("../src/i18nAnalyzer");

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
  assert.deepEqual(diagnostics[0].data, {
    keyPath: "unused",
    namespace: "common",
  });
  assert.equal(diagnostics[0].code, "unusedTranslationKey");
});

test("unused key removal edits delete the key from every namespace dictionary", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/alerts.json": JSON.stringify(
      {
        title: "Alertes",
        page_description: "Description",
        footer: "Pied de page",
      },
      null,
      2,
    ),
    "public/en/alerts.json": JSON.stringify(
      {
        title: "Alerts",
        page_description: "Description",
        footer: "Footer",
      },
      null,
      2,
    ),
    "app/alerts.tsx": `
      export function AlertsPage() {
        const { t } = useTranslation("alerts");
        return <h1>{t("title")}</h1>;
      }
    `,
  });

  const edits = findUnusedTranslationKeyRemovalEdits({
    workspaceRoot,
    namespace: "alerts",
    keyPath: "page_description",
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    edits.map((edit) => path.relative(workspaceRoot, edit.filePath)).sort(),
    ["public/en/alerts.json", "public/fr/alerts.json"],
  );

  for (const edit of edits) {
    const text = fs.readFileSync(edit.filePath, "utf8");
    const nextText = applyTextEdits(text, [edit]);

    assert.deepEqual(edit.startPosition, { line: 2, character: 0 });
    assert.deepEqual(edit.endPosition, { line: 3, character: 0 });
    assert.deepEqual(Object.keys(JSON.parse(nextText)), ["title", "footer"]);
  }
});

test("unused key removal edits merge multiple key deletes per dictionary", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/alerts.json": JSON.stringify(
      {
        alert_types: {
          missed_alarm: "Alarme manquee",
          low_battery: "Batterie faible",
          disconnected: "Deconnecte",
        },
        alert_statuses: {
          pending: "En attente",
          acknowledged: "Acquitte",
        },
        title: "Alertes",
      },
      null,
      2,
    ),
    "public/en/alerts.json": JSON.stringify(
      {
        alert_types: {
          missed_alarm: "Missed alarm",
          low_battery: "Low battery",
          disconnected: "Disconnected",
        },
        alert_statuses: {
          pending: "Pending",
          acknowledged: "Acknowledged",
        },
        title: "Alerts",
      },
      null,
      2,
    ),
  });

  const edits = findUnusedTranslationKeysRemovalEdits({
    workspaceRoot,
    namespace: "alerts",
    keyPaths: [
      "alert_types.missed_alarm",
      "alert_types.low_battery",
      "alert_types.disconnected",
      "alert_statuses.pending",
    ],
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.equal(edits.length, 4);

  for (const filePath of [
    path.join(workspaceRoot, "public/fr/alerts.json"),
    path.join(workspaceRoot, "public/en/alerts.json"),
  ]) {
    const text = fs.readFileSync(filePath, "utf8");
    const nextText = applyTextEdits(
      text,
      edits.filter((edit) => edit.filePath === filePath),
    );
    const parsed = JSON.parse(nextText);

    assert.equal(parsed.alert_types, undefined);
    assert.deepEqual(Object.keys(parsed.alert_statuses), ["acknowledged"]);
    assert.equal(typeof parsed.title, "string");
  }
});

test("json key removal deletes parent object when all child keys are removed", () => {
  const text = JSON.stringify(
    {
      page: {
        description: "Description",
      },
      title: "Alerts",
    },
    null,
    2,
  );
  const ranges = findJsonKeyDeletionRanges(text, ["page.description"]);
  const nextText = applyTextEdits(text, ranges);
  const parsed = JSON.parse(nextText);

  assert.equal(parsed.page, undefined);
  assert.equal(parsed.title, "Alerts");
  assert.doesNotMatch(nextText, /,\s*}/);
});

test("json key removal does not leave trailing commas when deleting final siblings", () => {
  const text = JSON.stringify(
    {
      stats: {
        total: "Total",
        resolved: "Resolved",
        change_from_last_week: "Change",
      },
      title: "Alerts",
    },
    null,
    2,
  );
  const ranges = findJsonKeyDeletionRanges(text, [
    "stats.resolved",
    "stats.change_from_last_week",
  ]);
  const nextText = applyTextEdits(text, ranges);
  const parsed = JSON.parse(nextText);

  assert.deepEqual(parsed.stats, { total: "Total" });
  assert.doesNotMatch(nextText, /,\s*}/);
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

function applyTextEdits(text, edits) {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (currentText, edit) => `${currentText.slice(0, edit.start)}${currentText.slice(edit.end)}`,
      text,
    );
}
