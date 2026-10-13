# Contributing to Loam

Thank you for helping. Loam is small and maintained by one person, so the way of working is kept simple and predictable.

## The easiest contribution: a starter kit

A starter kit sets up a new creative bible for a kind of game: its sections, their order, a short template per section and optional fields. Kits are plain folders of JSON and Markdown in [`starter-kits/`](starter-kits/), described in [`starter-kits/README.md`](starter-kits/README.md). No code is needed. A good kit:

- includes the `pillars`, `decisions` and `ideas` sections, which the decision tools use;
- keeps templates short: a few headings, not a form;
- uses original wording, not text from existing games or books.

## Reporting bugs and asking for features

Use the issue templates. For a bug, include the version (About in the left rail) and, if you can, the lines around the problem from `%LOCALAPPDATA%\Loam\logs\main.log`. Loam already hides paths outside its own folders in that log; please remove your user name from any paths that remain.

## Building and testing

You need Node.js 24 or newer and pnpm (`corepack enable`).

```powershell
pnpm install
pnpm dev                          # run the app from source
pnpm lint; pnpm typecheck         # zero errors and warnings
pnpm format:check                 # prettier; pnpm format fixes it
pnpm test:unit                    # Vitest
pnpm build:app; pnpm test:e2e     # Playwright against the built app
```

End-to-end tests always run the app with its own temporary data folder, so they never touch your real library.

## How changes are made

- **Small specs.** Each change starts from a short description: what it does, how we know it is done ("done when"), and what is out of scope. For anything bigger than a fix, open an issue first so we can agree on that before you write code.
- **Tests are the gate.** New behavior comes with a test. Tests are never weakened or deleted to make a change pass.
- **A short report per change.** The pull request says what was built, how it was tested and anything that turned out differently from the plan.
- **Keep the boundaries.** The UI talks to the backend only through the typed protocol in `packages/protocol`; `packages/core` stays free of Electron and Node-only APIs; database changes go in new numbered files in `migrations/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Dependencies.** Prefer the standard library and what is already used. A new dependency needs a reason in the pull request and a permissive license (MIT, Apache-2.0, BSD, ISC); `pnpm notices` checks the shipped ones.
- **Commits.** [Conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), one logical change each.

## Privacy rules for code

Loam promises no telemetry and no network access unless the user asks. Contributions must keep it that way: no analytics, no crash reporting, no calls home. The only network access today is downloading the optional local model after the user clicks Download.

## License

By contributing, you agree that your contribution is released under the project's [MIT License](LICENSE).
