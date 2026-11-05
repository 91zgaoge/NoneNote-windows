# Changelog

## 1.4.0 (2026-11-05) — notes, WebDAV sync and the second-brain compiler

Windows catches up with the Android 1.11.5 core. Before this release the app
was a Paper Desk prototype with hard-coded sample notes; nothing persisted,
synced or compiled.

- **Local notes store** (`core/notes/store.ts`): create/edit/pin/archive/delete
  with the same 5s undo window as Android, derived titles, stable ordering,
  verbatim `applyRemote`, import regeneration for colliding ids.
- **Persistence** (`platform/notePersistence.ts`, Rust `state_load/save/delete`):
  JSON files in the Tauri app-data directory, atomic temp-file replace, keys
  validated against traversal.
- **WebDAV sync** (`core/sync/`): identical `NoneNote/sync.json` schema and
  merge rules — LWW by `modified` with remote winning ties, tombstones with
  whole-second rounding, two-way / upload-only / download-only, three deletion
  policies, persisted known-id ledger, and a payload hash (with `updated`
  zeroed) that prevents sync loops. Note block documents are preserved
  verbatim; bodies are re-projected from documents when present.
- **AI client** (`core/ai/client.ts`): OpenAI-compatible chat, Bearer auth, the
  temperature-400 retry, `PromptMetrics` time-based timeout exemption
  (180s/900s) and usage parsing including cached tokens.
- **Wiki compiler** (`core/wiki/compiler.ts`): byte-for-byte semantics with
  Android 1.11.5 — stable page-prompt prefix, `ExtractSegment` line-aligned
  8k segmentation, 12k extraction batches capped at 40 notes, newest 12 sources
  / 12k chars per page, 1,500-char link catalog, 8 semantic hints, 12k overview
  catalog, 1,024/2,048/2,048 output budgets, 4-way concurrency with results
  written by one writer, checkpoints after every extraction/page chunk,
  `pendingPages` resume, failed-note/page retries, revision prompts, per-run
  page budget, and SHA-256 content hashes.
- **UI**: notes / archive / wiki / settings tabs, live sync status, compile
  trace with large-prompt warning, wikilink navigation, settings for WebDAV,
  AI profiles, extraction model and page budget.
- **Backup**: plain JSON export/import of notes, settings and wiki; warns that
  it contains the API key and WebDAV password.
- **Edge deck**: the separate always-on-top window now lists a dash per recent
  note (colour + title) and opens that note in the main window on click; it
  refreshes when `notes` is saved. Fan gestures/card previews are still not
  ported.
- **i18n**: all new UI strings in English and 简体中文.
- **Not yet ported**: attachments, chat/memory/agent actions, scheduled
  background compile, full edge-deck fan gestures.

### Verification

- `npm test`: **40 tests, 0 failures** (codec/merge/manager, compiler batching
  + concurrency + checkpoints + retries + revision + budgets, SHA-256 vectors,
  prompt metrics, backup).
- `npm run build`: **success** (`NoneNote-1.4.0-web`, 60 modules).
- `cd src-tauri && cargo check`: **success** (reqwest/rustls, base64,
  `open_note`, `state-saved` event).
- UI smoke screenshots (Chrome, web mode): notes, wiki and settings render.
- **未验证**: runtime on a Windows host; real WebDAV / LLM endpoints; export
  download and import picker inside WebView2; attachment sync; installer.
