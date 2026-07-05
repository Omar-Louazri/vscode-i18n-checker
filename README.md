# Simple i18n Checker

A very small VS Code extension for this project style:

- TSX calls `const { locale, t } = useTranslation("landing")`, `const common = useTranslation("common")`, or `useTranslate("landing")`.
- Locale dictionaries live at `public/<locale>/<namespace>.json`. `public` folders can be nested, for example `frontend/public/<locale>/<namespace>.json`.
- Translation calls use dot paths like `t("metadata.title", "Default")`.

## What it underlines

- In `.tsx` files: any `t("key")` where `key` is missing from one or more matching locale JSON files.
- In `public/<locale>/<namespace>.json` files: any leaf JSON key that is not used by any `.tsx` file using that namespace.

## Supported Languages v1

Only these locale folder names are treated as dictionaries: `en`, `fr`, `es`, `de`, `it`, `pt`, `nl`, `ru`, `uk`, `pl`, `cs`, `sk`, `hu`, `ro`, `bg`, `el`, `tr`, `sv`, `no`, `da`, `fi`, `et`, `lv`, `lt`, `is`, `ga`, `cy`, `ar`, `he`, `fa`, `ur`, `zh`, `ja`, `ko`, `th`, `vi`, `id`, `ms`, `hi`, `bn`, `ta`, `te`, `ml`, `mr`, `sw`, `am`, `zu`, `af`, `sr`, `hr`, `sl`, `mk`, `sq`, `ca`, `eu`, `gl`, `eo`.

## Run it locally

1. Open the app folder in VS Code.
2. Press `F5` and choose `Run Simple i18n Checker`.
3. VS Code opens a new Extension Development Host window with this app folder loaded.
4. Open `app/[locale]/landing-content.tsx` or `public/en/landing.json`.

You can also run `Simple i18n Checker: Refresh Diagnostics` from the command palette.
Run `Simple i18n Checker: Debug Active File` if diagnostics do not show up; it prints the detected namespace, keys, dictionary files, and diagnostic count in the `Simple i18n Checker` output panel.

## Limits

This is intentionally simple. It supports string-literal namespaces and string-literal translation keys. It does not try to evaluate variables, template expressions, or imported constants.
