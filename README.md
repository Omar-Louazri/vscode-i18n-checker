# Simple i18n Checker

![Simple i18n Checker icon](media/icon.svg)

Simple i18n Checker is a focused VS Code extension for teams that keep locale
dictionaries in `public/<locale>/<namespace>.json` and read them from TSX with
`useTranslation(...)` or `useTranslate(...)`.

It keeps translation usage and JSON dictionaries aligned while you work:
missing keys are underlined in TSX, unused dictionary leaves are underlined in
JSON, and cleanup fixes can remove stale keys across every locale file for the
same namespace.

## Highlights

- Finds missing `t("key.path")` translations in `.tsx` files.
- Finds unused leaf keys in `public/<locale>/<namespace>.json` dictionaries.
- Deletes a stale key from every locale dictionary with one Quick Fix.
- Offers bulk fixes for unused groups such as `hero.*` or an entire namespace.
- Auto-discovers nested `public` folders, including layouts such as
  `frontend/public`.
- Jumps from a TSX translation key to the matching JSON key in the configured
  default locale.
- Prints debug details for the active file to the `Simple i18n Checker` output
  channel.

## Designed For

This extension is intentionally small and predictable. It is best for projects
with:

- TSX components that use string-literal translation namespaces.
- Dot-path translation keys such as `metadata.title` or `hero.cta`.
- JSON dictionaries stored directly under locale folders.
- One JSON file per namespace, for example `public/fr/landing.json`.

It is not a general JavaScript static analyzer. The checker favors transparent
rules and useful editor feedback over complex inference.

## Expected Project Layout

Locale dictionaries must live directly below a `public` directory:

```text
public/
  en/
    landing.json
    common.json
  fr/
    landing.json
    common.json
```

Nested `public` directories are supported:

```text
frontend/
  public/
    en/
      landing.json
    fr/
      landing.json
```

The file name is the namespace. For example, `public/fr/landing.json` is the
French dictionary for the `landing` namespace.

## Supported TSX Patterns

The checker detects string-literal namespaces and string-literal keys in these
forms:

```tsx
const { locale, t } = useTranslation("landing");
t("metadata.title");
```

```tsx
const { t: translate } = useTranslation("landing");
translate("metadata.title");
```

```tsx
const common = useTranslation("common");
common.t("save");
```

```tsx
const t = useTranslate("landing");
t("hero.title");
```

If a file calls `useTranslation("namespace")` or `useTranslate("namespace")`
without one of the assignment forms above, the checker assumes translation calls
use a local function named `t`.

## Dictionary Keys

JSON keys are matched as dot paths. For example:

```json
{
  "metadata": {
    "title": "Welcome"
  },
  "hero": {
    "cta": "Start"
  }
}
```

The checker treats those leaf keys as:

```text
metadata.title
hero.cta
```

Only leaf values are considered translatable keys. Objects are used to build the
path.

## Diagnostics

### Missing Keys In TSX

When a TSX file uses a key that is not present in every matching locale
dictionary, the key is underlined with a warning:

```text
Add the attribute "hero.title" to these JSON files: public/en/landing.json, public/fr/landing.json.
```

If the namespace cannot be found in any locale dictionary, the warning points to
the expected `public/*/<namespace>.json` location.

### Unused Keys In JSON

When a locale dictionary contains a leaf key that is not used by any `.tsx` file
with the same namespace, the JSON key is underlined with a warning:

```text
Translation key "hero.subtitle" is not used by any TSX file with namespace "landing".
```

The warning includes a Quick Fix:

```text
Delete "hero.subtitle" from all landing.json dictionaries
```

Applying it removes that key from every existing
`public/<locale>/landing.json` file where the key is present.

When several unused keys are reported for the same namespace, related bulk
Quick Fixes are also available:

```text
Delete all "hero.*" from all landing.json dictionaries
Delete all unused attributes from all landing.json dictionaries
```

Batch fixes are validated before they are offered. Removing final sibling keys
will also remove the preceding comma instead of leaving trailing commas. If
every leaf key under a parent object is removed, the parent object is removed
too instead of leaving an empty object behind.

## Commands

Open the command palette and run:

- `Simple i18n Checker: Refresh i18n Diagnostics`
- `Simple i18n Checker: Debug Active i18n File`

The debug command writes inspection details to the `Simple i18n Checker` output
channel. It is the fastest way to check which namespace, translation calls, and
dictionary files the extension detected for the active file.

## Settings

### `simpleI18nChecker.defaultLocale`

Default: `fr`

Locale used by Go to Definition when jumping from a TSX key to a JSON
dictionary.

```json
{
  "simpleI18nChecker.defaultLocale": "en"
}
```

### `simpleI18nChecker.dictionaryPublicPaths`

Default: `[]`

Optional `public` directory paths to scan for locale dictionaries. Paths may be
relative to the workspace root or absolute. Auto-discovery still runs, so this
setting is mainly useful when you want to make a specific dictionary location
explicit.

```json
{
  "simpleI18nChecker.dictionaryPublicPaths": ["frontend/public"]
}
```

## Supported Locale Folders

Only these locale folder names are treated as dictionaries:

```text
en, fr, es, de, it, pt, nl, ru, uk, pl, cs, sk, hu, ro, bg, el, tr, sv, no,
da, fi, et, lv, lt, is, ga, cy, ar, he, fa, ur, zh, ja, ko, th, vi, id, ms,
hi, bn, ta, te, ml, mr, sw, am, zu, af, sr, hr, sl, mk, sq, ca, eu, gl, eo
```

Folders with other names are ignored.

## Run Locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Open this extension folder in VS Code.
3. Press `F5`.
4. Choose `Run Simple i18n Checker` if VS Code asks for a launch target.
5. In the Extension Development Host window, open a workspace that contains TSX
   files and `public/<locale>/<namespace>.json` dictionaries.

You can also run:

```sh
npm start
```

This prints the same reminder because extension debugging is launched from VS
Code.

## Test

Run the analyzer tests with:

```sh
npm test
```

The tests exercise the core analyzer without launching VS Code.

## Package

Build a local `.vsix` package with:

```sh
npx vsce package
```

Install the generated `.vsix` in VS Code with:

```sh
code --install-extension simple-i18n-checker-0.0.1.vsix
```

## Limitations

- Only `.tsx` files are scanned for translation usage.
- Namespace arguments must be string literals.
- Translation keys must be string literals, except for template literals whose
  expressions can be inferred from same-file const object keys used through
  indexed access such as `STATUS_CLASSES[call.status]`, or same-file const
  config object string properties used through an indexed alias such as
  `const cfg = INVITE_STATUS_CONFIG[status ?? "none"]; t(cfg.labelKey)`.
- Variables, imported constants, arbitrary template expressions, and computed
  keys are not evaluated.
- The checker does not understand arbitrary aliases or wrapper functions beyond
  the supported patterns above.
- Locale dictionaries must be JSON files directly under
  `public/<locale>/<namespace>.json`.
- Supported locale folder names are fixed to the list above.
