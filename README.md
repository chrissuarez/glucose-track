# Glucose Track

A small offline-capable web app for two people sharing one Keto-Mojo GKI meter. Log a food, prick at 0 / 30 / 60 / 120 min, import the meter export, and see which foods spike your glucose. All data stays on each phone (IndexedDB). No server, no login, no build step.

Not medical advice.

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. (Service workers need `localhost` or HTTPS.)

## Tests

```
node --test
```

Pure logic (CSV parsing, matching, scoring, ranking, zip reading) lives in `js/logic.js` and `js/zip.js` and has no DOM access. Test fixtures in `tests/fixtures/` are synthetic. Never put a real export in the project; `.gitignore` blocks `*.zip` and `readings*.csv`.

To regenerate the icons: `node tools/make-icons.mjs`.

## Deploy to GitHub Pages (instructions only)

1. Create a repo and commit the contents of this folder (the real export zip is ignored).
2. Settings -> Pages -> Deploy from a branch -> `main` / `(root)`.
3. Open `https://<user>.github.io/<repo>/`. All paths are relative, so the sub-path works.
4. After changing any app file, bump `CACHE` in `sw.js` so phones pick up the new version.

## iPhone

Open the site in Safari, Share -> Add to Home Screen. Safari can delete data of websites not opened for 7 days unless the app is added to the home screen, so add it, and use Settings -> Download backup regularly.

## Layout

- `index.html`, `css/styles.css`, `manifest.webmanifest`, `sw.js`, `icons/`
- `js/app.js` UI, `js/db.js` IndexedDB, `js/logic.js` pure logic, `js/zip.js` minimal zip reader
- Scoring thresholds are in the `CONSTANTS` block at the top of `js/logic.js`.
