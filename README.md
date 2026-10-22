# Open GIT

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
- **Commit messages by AI**: a button in the commit form sends the staged diff to a
  model and fills in the summary and description. It runs Claude Code (`claude`) or
  Codex (`codex`) when they are installed, with the account they are signed in to;
  or it calls the Anthropic or OpenAI API with your own key, kept in the OS keychain.
- **Interface**: English and French, system/light/dark theme, resizable panels,
  keyboard navigation.
- **Updates**: an installed copy looks at the latest GitHub release when it starts
  (and every few hours), then downloads, checks and installs it on request. The
  version and "Check for updates" are behind the application name, top left.

## Installing on macOS

The macOS builds are signed ad hoc, not with an Apple Developer ID, and are not
notarized. The first time you open the app, macOS says it cannot verify it:

1. Open the `.dmg` and drag **Open GIT** into **Applications**.
2. Open it once; macOS refuses and offers only "Done" or "Move to Trash". Choose "Done".
3. Go to **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to the message about Open GIT, then confirm.

macOS remembers the choice for this copy.
Releases up to 0.2.6 were not signed at all, and macOS called them "damaged". To open
one of those, remove the quarantine flag in a terminal:

```bash
xattr -cr "/Applications/Open GIT.app"
```

## Layout

- `crates/core` — Git logic on top of `git2` plus the user's `git` binary, with no
  UI dependency; tested on temporary repositories.
- `crates/forge` — GitHub: token in the OS keychain, device flow, REST calls, askpass.
- `crates/ai` — the commit message assistant: the `claude` and `codex` programs run
  headless, the Anthropic and OpenAI HTTP APIs with keys in the OS keychain, and the
  prompt built from the staged changes.
- `src-tauri` — the Tauri application: thin commands over `core`, `forge` and `ai`, file
  watcher, progress events, TypeScript bindings generated with `tauri-specta`.
- `src` — the React frontend (Tailwind, shadcn/ui, TanStack Virtual, dnd-kit,
  CodeMirror). `src/dev/mock.ts` is a fake backend for working on the UI in a browser.

## Development

```bash
pnpm install
pnpm tauri dev           # the full application
pnpm dev                 # the UI alone in a browser, against the fake backend
cargo test -p open-git-core -p open-git-forge -p open-git-ai
cargo clippy --workspace --all-targets
pnpm build               # type check and bundle the frontend
pnpm tauri build         # installers in target/release/bundle/
```

To offer "Sign in with GitHub" (OAuth device flow), create a GitHub OAuth App with
device flow enabled and put its client id in `OPEN_GIT_GITHUB_CLIENT_ID`, which
`.cargo/config.toml` provides to every build.
A personal access token with the `repo` scope always works.

## Releases

Pushing a tag such as `v0.1.0` runs `.github/workflows/release.yml`, which builds the
Windows, macOS and Linux installers and attaches them to a draft GitHub release.
Publishing the draft is what makes the installed copies offer the update.

1. Set the new version in `src-tauri/tauri.conf.json` (the one that counts: the
   workflow refuses a tag that differs from it), and in `Cargo.toml` and
   `package.json` to keep them alike.
2. Commit, then `git tag v0.2.0 && git push origin main v0.2.0`.
3. When the workflow is done, publish the draft release.

The installers are signed for the updater with a key pair made by
`pnpm tauri signer generate`: the public key is in `tauri.conf.json`, the private
key is the repository secret `TAURI_SIGNING_PRIVATE_KEY`
(`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when it has a password). Losing it means the
copies already installed can no longer be updated. The application reads
`releases/latest/download/latest.json`, which GitHub only serves without
authentication for a public repository.

## Status

Usable, young, and not yet published: the name, the license and the application
identifier are still to be decided (see `CLAUDE.md`).
