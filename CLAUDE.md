# CLAUDE.md — Loam

Standing rules for any coding agent working in this repository. Read this file and `docs/ARCHITECTURE.md` before starting any task.

## What this project is

Loam (called UnrealManager before 0.1.0) is an MIT-licensed, local-first desktop workspace for creative indie game developers: reference boards, study journals, a creative bible, and (later) an in-app AI agent that respects the developer's intent. Stack: Electron + React + TypeScript, pnpm monorepo, SQLite (better-sqlite3), zod, Vitest, Playwright.

## How work is organized

- Work happens in **slices**. Each slice has a short spec (scope, "Done when", out of scope).
- Do **one slice at a time**. A slice is done only when every "Done when" item passes.
- At the end of a slice, write a short report (in the pull request): what was built, test results, deviations from the spec, open questions.

## Hard rules

1. **Stay in scope.** Implement only what the current slice specifies. No "while I'm here" improvements, no extra features, no speculative abstractions.
2. **Do not change the architecture.** Package boundaries, the protocol layer and the data layout are fixed by `docs/ARCHITECTURE.md`. If the spec seems wrong, stop and ask.
3. **No new dependencies without a note.** If a dependency not named in the spec is needed, add a one-line justification to the slice report. Prefer the standard library and existing dependencies.
4. **When unsure, ask instead of guessing.** Write `DECISION NEEDED: <question>` in the slice report and stop that part of the work.
5. **Verify before you claim.** Every code fact you state (in reports or specs) cites `file:line`, or is marked `ASSUMED`. Check current library versions before pinning them.
6. **Tests are the gate.** New behavior gets a test. Never delete or weaken a test to make it pass.

## Architecture rules

- `apps/ui` talks to the backend **only** through `packages/protocol` (zod-validated messages). The UI never imports from `packages/core`, `packages/storage` or `apps/desktop`.
- Protocol messages are **view-model sized**: one round trip per user action. No chains of small fetches.
- `packages/core` imports no Electron or Node-only APIs directly; it receives file system, clock and storage through injected interfaces.
- Database changes happen **only** through new numbered SQL files in `migrations/`. Never edit an applied migration.
- Binary files (images, media) go in the content-addressed file store, never in SQLite blobs.

## Security minimums (always on)

- API keys live in the OS keychain (Electron safeStorage / Windows Credential Manager). Never in config files, SQLite, logs or the repo.
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP. Do not relax these.
- Agent tools that write files, run commands or send data out require user approval in the UI.
- Agent file access is restricted to the open project folder; reject paths outside it.
- Content from outside (web pages, imported notes, captions) is passed to any model as clearly marked untrusted data, never as instructions.
- Do not commit secrets; the gitleaks pre-commit hook must stay enabled.

## Code style

- TypeScript strict mode. No `any` without a comment explaining why.
- Small, named functions; no clever one-liners where a plain loop is clearer.
- Formatting by prettier; lint must pass with zero errors.
- User-facing strings in English for now.

## Testing

- E2E failure evidence is never lost: before Playwright clears `test-results/`, the config moves the previous run's failed-test folders to `test-results-archive/<timestamp>/` (git-ignored; the newest 10 are kept). Look there when a failure from an earlier run needs investigating (`tests/support/archiveResults.ts`).
- The real app data may be a virtualized copy. A terminal that belongs to a Microsoft Store (MSIX) app gives the processes started from it a private, merged view of `%LOCALAPPDATA%` and of HKCU: reads of `%LOCALAPPDATA%\Loam` from such a terminal may show a private copy, and new folders or registry entries may be written only there. Do not trust such reads; start the installed app through `pnpm update-app` (it launches via Explorer and runs installers outside the terminal's package).

## Commits

- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- Commit messages contain no backtick characters. Write the message to a temp file and use `git commit -F`.
- One logical change per commit; never commit with failing tests.

## Out of bounds unless a slice says otherwise

- AI or network calls of any kind.
- Telemetry or analytics.
- Changes to files under `docs/ARCHITECTURE.md` (propose changes in the slice report instead).
