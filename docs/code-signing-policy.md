# Code signing policy

**Status: in preparation.** Loam's releases are not code-signed yet. Until they are, each release lists the SHA-256 checksum of its installer so you can check the file you downloaded.

## What is signed

Only files built from this repository:

- the Windows installer, `Loam Setup <version>.exe`;
- the app executable, `Loam.exe`.

Files from other projects are not signed under this policy. That includes the Electron runtime libraries and the optional model and runtime that Loam downloads at the user's request.

## How releases are built

- Every release is built by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) from this public repository, when a version tag is pushed. Releases are not built on a personal computer.
- The workflow checks that every shipped dependency has a permissive license, runs the lint, typecheck and unit test checks, and builds the installer. It then checks that the tag matches the app version and attaches the installer, with its SHA-256 file, to a **draft** release.
- The maintainer reviews each draft and publishes it by hand. Each signing request is approved by hand in the same way.

## Team roles

Loam has one maintainer, who holds every role:

| Role               | Who                                           | Responsibility                                                       |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------- |
| Author (committer) | [Small-Piece](https://github.com/Small-Piece) | Writes and commits changes to this repository                        |
| Reviewer           | [Small-Piece](https://github.com/Small-Piece) | Reviews every contribution from outside the team before it is merged |
| Approver           | [Small-Piece](https://github.com/Small-Piece) | Approves each release and each signing request                       |

## Account security

The maintainer's GitHub account uses multi-factor authentication.

## Privacy

Loam does not transfer information to other networked systems unless the user asks for it. See the [privacy statement](privacy.md).
