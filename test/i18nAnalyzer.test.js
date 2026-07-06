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

test("tsx key checks ignore plain values on generic key properties", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/fillpillbox.json": JSON.stringify({ presets: "Horaires" }, null, 2),
    "public/en/fillpillbox.json": JSON.stringify({ presets: "Presets" }, null, 2),
  });
  const text = `
    const DEFAULT_TIME_PRESETS = [
      { key: "morning", time: "08:00" },
      { key: "noon", time: "12:00" },
      { key: "evening", time: "18:00" },
      { key: "night", time: "22:00" },
    ];

    export function FillPillbox() {
      const { t } = useTranslation("fillpillbox");
      return <h1>{t("presets")}</h1>;
    }
  `;

  const diagnostics = analyzeTsxDocument({
    text,
    filePath: path.join(workspaceRoot, "app/fillpillbox.tsx"),
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [],
  );
});

test("tsx key checks keep dotted values on generic key properties", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/fillpillbox.json": JSON.stringify(
      { presets: { noon: "Midi" } },
      null,
      2,
    ),
    "public/en/fillpillbox.json": JSON.stringify(
      { presets: { noon: "Noon" } },
      null,
      2,
    ),
  });
  const text = `
    const DEFAULT_TIME_PRESETS = [
      { key: "presets.morning", time: "08:00" },
      { key: "presets.noon", time: "12:00" },
    ];

    export function FillPillbox() {
      useTranslation("fillpillbox");
      return null;
    }
  `;

  const diagnostics = analyzeTsxDocument({
    text,
    filePath: path.join(workspaceRoot, "app/fillpillbox.tsx"),
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'Add the attribute "presets.morning" to these JSON files: public/en/fillpillbox.json, public/fr/fillpillbox.json.',
    ],
  );
});

test("tsx key checks keep plain values on specific translation key properties", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/common.json": JSON.stringify({}, null, 2),
    "public/en/common.json": JSON.stringify({}, null, 2),
  });
  const text = `
    const ACTIONS = {
      save: { labelKey: "save" },
    };

    export function Actions() {
      useTranslation("common");
      return null;
    }
  `;

  const diagnostics = analyzeTsxDocument({
    text,
    filePath: path.join(workspaceRoot, "app/actions.tsx"),
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ['Add the attribute "save" to these JSON files: public/en/common.json, public/fr/common.json.'],
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

test("tsx key checks resolve label keys from indexed config object aliases", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/patients.json": JSON.stringify(
      {
        relatives_section: {
          invite_status: {
            accepted: "Accepte",
            pending: "En attente",
            none: "Aucune invitation",
          },
        },
      },
      null,
      2,
    ),
  });
  const text = `
    type InviteStatus = "accepted" | "pending" | "declined" | "none";

    const INVITE_STATUS_CONFIG: Record<InviteStatus, { className: string; labelKey: string }> = {
      accepted: {
        className: "bg-green-100",
        labelKey: "relatives_section.invite_status.accepted",
      },
      pending: {
        className: "bg-amber-100",
        labelKey: "relatives_section.invite_status.pending",
      },
      declined: {
        className: "bg-red-100",
        labelKey: "relatives_section.invite_status.declined",
      },
      none: {
        className: "bg-gray-100",
        labelKey: "relatives_section.invite_status.none",
      },
    };

    export function InviteStatusPill({ status }) {
      const { t } = useTranslation("patients");
      const cfg = INVITE_STATUS_CONFIG[status ?? "none"];
      return <span>{t(cfg.labelKey, cfg.labelKey)}</span>;
    }
  `;

  const diagnostics = analyzeTsxDocument({
    text,
    filePath: path.join(workspaceRoot, "app/patients.tsx"),
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    ['Add the attribute "relatives_section.invite_status.declined" to public/fr/patients.json.'],
  );
});

test("json key checks count label keys from indexed config object aliases as used", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/patients.json": JSON.stringify(
      {
        relatives_section: {
          invite_status: {
            accepted: "Accepte",
            pending: "En attente",
            declined: "Refuse",
            none: "Aucune invitation",
            invited: "Invite",
          },
        },
      },
      null,
      2,
    ),
    "app/patients.tsx": `
      type InviteStatus = "accepted" | "pending" | "declined" | "none";

      const INVITE_STATUS_CONFIG: Record<InviteStatus, { className: string; labelKey: string }> = {
        accepted: {
          className: "bg-green-100",
          labelKey: "relatives_section.invite_status.accepted",
        },
        pending: {
          className: "bg-amber-100",
          labelKey: "relatives_section.invite_status.pending",
        },
        declined: {
          className: "bg-red-100",
          labelKey: "relatives_section.invite_status.declined",
        },
        none: {
          className: "bg-gray-100",
          labelKey: "relatives_section.invite_status.none",
        },
      };

      export function InviteStatusPill({ status }) {
        const { t } = useTranslation("patients");
        const cfg = INVITE_STATUS_CONFIG[status ?? "none"];
        return <span>{t(cfg.labelKey, cfg.labelKey)}</span>;
      }
    `,
  });
  const filePath = path.join(workspaceRoot, "public/fr/patients.json");
  const diagnostics = analyzeJsonDocument({
    text: fs.readFileSync(filePath, "utf8"),
    filePath,
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'Translation key "relatives_section.invite_status.invited" is not used by any TSX file with namespace "patients".',
    ],
  );
});

test("json key checks read translation keys from commented config maps", () => {
  const workspaceRoot = createWorkspace({
    "public/fr/patients.json": JSON.stringify(
      {
        relatives_section: {
          invite_status: {
            accepted: "Accepte",
            pending: "En attente",
            declined: "Refuse",
            none: "Aucune invitation",
            invited: "Invite",
            archived: "Archive",
          },
        },
      },
      null,
      2,
    ),
    "app/patients.tsx": `
      type InviteStatus = PatientRelative["invite_status"];

      const INVITE_STATUS_CONFIG: Record<
        InviteStatus,
        { icon: React.ElementType; className: string; labelKey: string }
      > = {
        // Relative accepted - linked_patient is an active Patient account.
        // FUTURE: make the pill clickable to navigate to the patient's profile page.
        accepted: {
          icon: UserCheck,
          className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200",
          labelKey: "relatives_section.invite_status.accepted",
        },
        // Invite email sent but no response yet.
        // FUTURE: add a "Resend" button next to this pill.
        pending: {
          icon: Clock,
          className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200",
          labelKey: "relatives_section.invite_status.pending",
        },
        // Relative explicitly declined the invite.
        declined: {
          icon: UserX,
          className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200",
          labelKey: "relatives_section.invite_status.declined",
        },
        // No invite was ever sent; if status is 'none', show a "Send invite" button.
        none: {
          icon: UserMinus,
          className: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border-gray-200",
          labelKey: "relatives_section.invite_status.none",
        },
        invited: {
          icon: Clock,
          className: "bg-sky-100 text-sky-700",
          labelKey: "relatives_section.invite_status.invited",
        },
      };

      export const InviteStatusPill = ({ status }: { status: InviteStatus | undefined }) => {
        const { t } = useTranslation("patients");
        const cfg = INVITE_STATUS_CONFIG[status ?? "none"];
        const Icon = cfg.icon;
        return (
          <span className={\`inline-flex items-center \${cfg.className}\`}>
            <Icon className="h-3 w-3" />
            {t(cfg.labelKey, cfg.labelKey)}
          </span>
        );
      };
    `,
  });
  const filePath = path.join(workspaceRoot, "public/fr/patients.json");
  const diagnostics = analyzeJsonDocument({
    text: fs.readFileSync(filePath, "utf8"),
    filePath,
    workspaceRoot,
    openDocuments: new Map(),
    dictionaryPublicPaths: [],
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.message),
    [
      'Translation key "relatives_section.invite_status.archived" is not used by any TSX file with namespace "patients".',
    ],
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
