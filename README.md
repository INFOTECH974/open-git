# gitui

A visual Git client built with Tauri 2, Rust and React. Everything you would do on
the command line should be doable by pointing and dragging: browse the commit graph,
stage and commit, drag a branch onto another to merge or rebase, resolve conflicts,
and work with GitHub pull requests and issues without leaving the window.

## What it does

- **Repositories**: open several in tabs, recent list, clone, init. The window
  refreshes by itself when the repository or the working tree changes.
- **History**: virtualized commit graph with branches and tags, search by message,
  author or id, commit details, diffs by hunk, unified or side by side (CodeMirror).
- **Working tree**: stage and unstage files or single hunks, discard, ignore (adds
  to `.gitignore`), stash, commit and amend, open in editor, reveal in file manager.
- **Branches and tags**: check out on double-click, create, rename, delete, push,
  set upstream, delete on the remote, create tags; cherry-pick and revert commits.
- **Drag & drop**: drop a branch onto another to merge or rebase. Conflicts are listed
  with "keep ours" / "keep theirs" per file, then continue or abort.
- **Remotes**: fetch, pull, push with progress and cancellation, through your own
  `git`, so your SSH keys, credential helpers, hooks and signing apply. Over HTTPS,
  the connected GitHub token is offered to `git` through `GIT_ASKPASS` when no
  credential helper answers.
- **GitHub**: sign in with a personal access token, or through github.com when the
  build carries an OAuth client id. Lists open and closed pull requests and issues,
  creates pull requests and issues, comments, closes, checks out a pull request
  branch, and creates a branch from an issue.
- **Interface**: English and French, system/light/dark theme, resizable panels,
  keyboard navigation.

## Layout

- `crates/core` — Git logic on top of `git2` plus the user's `git` binary, with no
  UI dependency; tested on temporary repositories.
- `crates/forge` — GitHub: token in the OS keychain, device flow, REST calls, askpass.
- `src-tauri` — the Tauri application: thin commands over `core` and `forge`, file
  watcher, progress events, TypeScript bindings generated with `tauri-specta`.
- `src` — the React frontend (Tailwind, shadcn/ui, TanStack Virtual, dnd-kit,
  CodeMirror). `src/dev/mock.ts` is a fake backend for working on the UI in a browser.

## Development

```bash
pnpm install
pnpm tauri dev           # the full application
pnpm dev                 # the UI alone in a browser, against the fake backend
cargo test -p gitui-core -p gitui-forge
cargo clippy --workspace --all-targets
pnpm build               # type check and bundle the frontend
pnpm tauri build         # installers in target/release/bundle/
```

To offer "Sign in with GitHub" (OAuth device flow), create a GitHub OAuth App with
device flow enabled and set `GITUI_GITHUB_CLIENT_ID` to its client id when building.
A personal access token with the `repo` scope always works.

## Releases

Pushing a tag such as `v0.1.0` runs `.github/workflows/release.yml`, which builds the
Windows, macOS and Linux installers and attaches them to a draft GitHub release.

## Status

Usable, young, and not yet published: the name, the license and the application
identifier are still to be decided (see `CLAUDE.md`).
