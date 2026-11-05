# NoneNote for Windows

Paper Desk note app for Windows. Shares design tokens and the WebDAV
`sync.json` protocol with Android, macOS and iOS
(`docs/plans/2026-09-01-ui-redesign-design.md`,
`docs/plans/2026-08-31-multiplatform-sync-design.md` in the Android repo).

## Status (1.4.0)

- **Notes:** local JSON persistence in the Tauri app-data directory, create /
  edit / pin / archive / delete with undo, search, reorder, 8-colour palette.
- **WebDAV sync:** same `NoneNote/sync.json` snapshot as Android/macOS —
  last-write-wins by `modified`, tombstones, two-way / upload-only /
  download-only, three deletion policies, payload-hash loop prevention.
- **AI:** OpenAI-compatible chat client with the shared `PromptMetrics`
  timeout rule (180s normally, 900s only when estimated cold prefill exceeds
  180s) and provider usage parsing (prompt / completion / cached tokens).
- **Wiki compiler:** incremental second-brain compile with the Android 1.11.5
  semantics: stable prompt prefix, 8k-char note segmentation, 12k extraction
  batches, 12 source notes / 12k chars per page, 1,500-char link catalog,
  1,024 / 2,048 / 2,048 output caps, 4-way concurrency with a single writer,
  checkpoints after every chunk, `pendingPages` resume, failed-page retries,
  revision prompts, and per-run page budget.
- **Backup:** one JSON file with notes, settings (including secrets) and the
  compiled wiki; import replaces all three.
- **i18n:** English + 简体中文 for all user-visible strings.
- **Edge deck:** the always-on-top window shows a dash per recent note;
  clicking one brings the main window forward and opens that note.
- **Not yet ported:** attachments (upload/view), second-brain chat / memory /
  agent actions, scheduled background compile, full edge-deck fan gestures.
- **Verification:** `npm test` and `npm run build` pass on macOS; `cargo check`
  passes; notes/wiki/settings screenshots were checked in Chrome (web mode).
  **未验证** on a Windows host, against a real WebDAV server, or against a real
  LLM endpoint.

## Tests

```sh
npm test        # Node test runner + type stripping, no extra deps
npm run build   # tsc -b && vite build
cd src-tauri && cargo check
```

The core is deliberately platform-free (`src/core/`) and tested with fakes:
sync codec/merge/manager, wiki compiler (batching, concurrency, checkpoints,
retries, budgets), prompt metrics, backup, document projection.

## Design tokens

`src/styles/paper-desk.css` mirrors:

| Platform | File |
|----------|------|
| Android | `app/.../ui/theme/PaperDesk.kt` |
| macOS | `Sources/PaperDesk.swift` |
| Windows | `src/styles/paper-desk.css` |

Fonts (OFL) live in `public/fonts/`.

## Dev (web only)

```sh
npm install --proxy=null   # if a dead local proxy breaks npm
npm run dev                # → http://localhost:1420
npm run build              # → dist/ + build/NoneNote-<version>-web/
```

Web mode falls back to `localStorage` for state and `fetch` for HTTP; WebDAV
and AI calls need the Tauri host (or a CORS-enabled proxy) to work.

## Dev (Tauri 2)

Requires Rust toolchain + Windows SDK for native builds.

```sh
npm install --proxy=null
npm run tauri:dev          # main window + edge stub
npm run tauri:build        # production bundle (Windows host)
```

The Rust host exposes four commands: `state_load`, `state_save`,
`state_delete` (atomic JSON files under the app-data dir) and `http_request`
(a reqwest proxy so the webview has no CORS restrictions; http/https only).

## Stack

**Tauri 2 + React + TypeScript.** Notes/settings/wiki live in the main webview;
the edge pill is a separate transparent, always-on-top window (`edge.html`).
