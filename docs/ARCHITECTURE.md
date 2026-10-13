# Loam architecture

A short technical overview for contributors. Loam is a local-first desktop app for indie game developers: a reference library with canvas boards, a creative bible and a study journal. It runs on Windows, as an Electron app written in TypeScript.

## Stack

| Layer         | Choice                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| Desktop shell | Electron, with `contextIsolation`, `sandbox` and no `nodeIntegration`               |
| UI            | React and Vite, TypeScript in strict mode                                           |
| Protocol      | zod schemas for every message between the UI and the backend                        |
| Database      | SQLite through better-sqlite3, in WAL mode                                          |
| Files         | A content-addressed file store for images; Markdown folders for bibles and journals |
| Tests         | Vitest (unit) and Playwright for Electron (end to end)                              |
| Packaging     | electron-builder, an NSIS installer per user                                        |
| Tooling       | pnpm workspaces, oxlint, prettier, Node.js 24                                       |

## Repository layout

Dependencies point one way: `apps` depend on `packages`, and `packages/core` depends on nothing host-specific.

```
apps/
  desktop/        Electron main and preload: window, IPC wiring, file dialogs, OS keychain,
                  data folder, the optional local model
  ui/             The React app; talks to the backend only through packages/protocol
packages/
  protocol/       zod schemas and the typed request/response map (the boundary)
  core/           Domain services: references and boards, bible and journal vaults
  storage/        SQLite access, the migration runner, the file store, vault files and watching
  agent/          The provider interface for the optional helpers and its local implementation
migrations/       Numbered SQL files, applied in order; never edited once released
starter-kits/     The kits a new bible or journal is made from (JSON and Markdown)
samples/          The sample bible that ships with the app
native/           Reserved for N-API addons, empty for now
tests/e2e/        Playwright tests; each runs the app with its own temporary data folder
scripts/          Development, notices, release and update scripts
site/             The website (one static page)
```

## Boundaries

The design keeps any single hot path cheap to move to native code later, without a rewrite:

1. **The UI talks to the backend only through the protocol.** Every message is a zod schema in `packages/protocol`, validated on both sides. Messages are view-model sized: one round trip per user action, not chains of small fetches. The UI never imports `core`, `storage` or `apps/desktop`.
2. **Domain logic is host-agnostic.** `packages/core` imports no Electron or Node-only APIs. It receives the file system, clock, storage and hashing through injected interfaces, so any service can be reimplemented behind the same interface.
3. **Data is language-neutral.** SQLite with plain numbered SQL migrations, plus files on disk. Another process, in any language, can read the same data without conversion.
4. **Hot paths move one at a time.** A slow module can become a Node addon (N-API) or a separate process speaking the same protocol.

## Data layout

**App data** lives in `%LOCALAPPDATA%\Loam`:

```
loam.db           SQLite: the library (references, tags, boards, canvas placements, groups,
                  notes), settings, and the index of every bible and journal
files/ab/<sha256> Images and thumbnails, stored once by the SHA-256 of their bytes
backups/          A copy of loam.db made before each schema migration (newest five kept)
logs/main.log     Startup and error log; paths outside the app's own folders are hidden
browser/          The Chromium profile (local storage, caches)
models/           The optional local model and its runtime, only after the user downloads them
```

Binary files never go into SQLite. Database changes happen only through new numbered files in `migrations/`; a backup is written before any pending migration runs.

**Bibles and journals are folders of plain Markdown**, wherever the user puts them, so they can be edited in any editor, kept in git and shared:

```
bible/
  bible.json      Format version, title, kit, and the sections with their order, names and fields
  README.md       Explains the format; written once, never rewritten
  <section>/      One folder per section, one .md file per entry (front matter + Markdown body)
  _assets/        Images used in entries
  .trash/         Deleted entries and sections, restorable from the app
```

The folder is the source of truth. SQLite only indexes it for search, links and backlinks, and a file watcher keeps the index in step with changes made outside the app. Files the app does not know are left untouched, and opening a vault never rewrites it.

## Security minimums

- API keys, when a feature needs one, are kept in the OS keychain (Electron safeStorage); never in config files, SQLite, logs or the repository.
- Electron runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` and a strict Content Security Policy for the UI.
- The app opens only http and https links in the system browser, after the user asks.
- Content from outside (imported notes, captions, web pages) is passed to any model as clearly marked untrusted data, never as instructions.
- A gitleaks pre-commit hook blocks committed secrets.
- No telemetry and no network access unless the user asks for it.

## Optional local helpers

Tag suggestions for references and recaps of study sessions come from a small vision-language model that runs on the user's computer. They are **off by default**: until the user turns them on and downloads the model, nothing loads and nothing goes online.

- **Runtime:** llama.cpp's `llama-server` (Vulkan build), started by the app as a child process bound to 127.0.0.1, with `--offline`, at below-normal priority, and with a random API key per launch that only the app knows. It stops after two idle minutes.
- **Model:** Qwen3-VL 4B Instruct (Apache-2.0), Q4_K_M with its vision projector.
- **Download:** on request only, from a pinned catalog of exact URLs, sizes and SHA-256 checksums, into `%LOCALAPPDATA%\Loam\models`. The dialog lists every file before anything is fetched.
- **Use:** suggestions are never applied without the user's click. Tagging pauses while programs the user lists (a game engine, for example) are running.
- **Interface:** everything sits behind a provider interface in `packages/agent`, so another runtime is one more implementation.

## Testing

- Unit tests sit next to the code (`*.test.ts`) and run with `pnpm test:unit`.
- End-to-end tests (`tests/e2e`) drive the built app with Playwright: `pnpm build:app`, then `pnpm test:e2e`, or `pnpm test:e2e:packaged` against the installer's build.
- CI runs lint, typecheck, unit tests, the format check and the license check on Windows for every push and pull request.
