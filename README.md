# NoneNote for Windows

Paper Desk note app for Windows. Shares design tokens and the WebDAV
`sync.json` protocol with Android, macOS and iOS
(`docs/plans/2026-09-01-ui-redesign-design.md`,
`docs/plans/2026-08-31-multiplatform-sync-design.md` in the Android repo).

## Status (1.12.0)

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
- **Ask your notes:** a second-brain chat over the compiled wiki + raw notes
  (term-overlap retrieval, bounded context, answer sources), with local chat
  sessions. The `noty` agent protocol can create / append / recolour notes
  immediately and asks for confirmation before archive / delete. No
  streaming, memory extraction, due-date or calendar/diagram actions yet.
- **Palette:** note colours now use the Android `NoteColor` order and values
  (Lemon → Slate), so colour indexes mean the same thing on every platform.
- **Due dates:** set/clear a local due date per note (editor date field),
  overdue/today/future badges in the list, and a `due` agent action. Local-only
  and not synced, matching Android (reminders are not ported yet). The `event`
  action is confirmation-gated and downloads an RFC 5545 `.ics` (timed or
  all-day) for the system calendar app.
- **Memory:** facts about the user are distilled from changed notes and new
  chat lines (static/dynamic, add/updates/extends/derives, optional expiry,
  dedup by normalized hash, version chains). An "About the user" block is
  injected into every ask; Settings → My profile lists long-term/recent facts
  with Forget and Inferred review (Accept/Discard), plus Learn now. Dreaming
  also runs best-effort after each successful wiki compile. Memory is local-only,
  like Android (never synced or backed up).
- **Attachments:** add/download/remove files per note (image thumbnails in
  the editor). Payloads sync as `NoneNote/attachments/<id>` ciphertext using
  the same PBKDF2(WebDAV password) + AES-GCM chunk format as Android, so any
  peer with the same credentials can open them. Local payloads are stored
  unencrypted in the app-data directory on Windows for now; text extraction
  and AI summaries are not generated here (remote metadata is still used by
  the wiki compiler).
- **Backup:** one JSON file with notes, settings (including secrets), the
  compiled wiki, chat sessions and decrypted attachment payloads; import
  replaces all of them.
- **i18n:** English + 简体中文 for all user-visible strings.
- **Scheduled compile:** optional daily wall-clock run (default 08:00) with the
  fixed 60-page background budget; it runs only while NoneNote is open.
- **Edge deck:** the always-on-top window snaps to the right screen edge, shows
  a dash per recent note, and expands on hover into a card panel; clicking a
  dash or card opens that note in the main window.
- **Not yet ported:** Excalidraw-diagram agent action, due-date reminders,
  full edge-deck fan gestures. Attachment text extraction / AI summaries also
  remain Android/macOS-only.
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
retries, budgets), prompt metrics, backup, document projection, the daily
scheduler, chat retrieval/grounding/agent actions, attachment crypto (AES-GCM
chunk records), memory ops/profile/dreamer, and real-HTTP WebDAV end-to-end
tests (an in-process DAV server, including ciphertext upload/download).

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
