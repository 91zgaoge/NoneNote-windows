# NoneNote for Windows

Paper Desk UI shell for Windows. Shares design tokens with Android and macOS
(`docs/plans/2026-09-01-ui-redesign-design.md` in the Android repo).

## Status

- **UI shell:** React + Paper Desk CSS (Library / Settings prototype).
- **Edge deck:** Tauri always-on-top `edge` window stub (colour dashes only).
- **WebDAV / encryption:** not implemented yet.
- **Verification:** UI shell builds on macOS; **未验证** on a Windows host.

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

## Dev (Tauri 2)

Requires Rust toolchain + Windows SDK for native builds.

```sh
npm install --proxy=null
npm run tauri:dev          # main Library window + edge stub
npm run tauri:build        # production bundle (Windows host)
```

## Stack

**Tauri 2 + React + TypeScript.** Library/Settings live in the main webview;
the edge pill is a separate transparent, always-on-top window (`edge.html`).
