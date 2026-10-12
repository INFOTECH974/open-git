//! Thin Tauri commands over `gitui_core`.
//!
//! Every command is `async` so it runs off the main thread: a synchronous command
//! would block the webview while libgit2 reads the repository or `git` talks to a
//! remote.

use std::time::Duration;

use gitui_core::{
    CommitDetails, ConflictSide, FileContents, FileDiff, GraphRow, RefInfo, RefKind, RemoteCommand,
    Repo, RepoInfo, StashEntry, WorkingTreeStatus,
};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::{error::Result, progress, state::AppState};

// ---- repositories ---------------------------------------------------------------

fn register(app: &AppHandle, state: &AppState, repo: Repo) -> Result<RepoInfo> {
    let info = repo.info()?;
    state.insert(app, info.path.clone(), repo);
    Ok(info)
}

/// Opens the repository containing `path` (searching parent directories) and
/// returns its description. The returned `path` identifies it in later calls.
#[tauri::command(async)]
#[specta::specta]
pub fn open_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RepoInfo> {
    register(&app, &state, Repo::open(&path)?)
}

/// Creates an empty repository in `path` (created when missing) and opens it.
#[tauri::command(async)]
#[specta::specta]
pub fn init_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RepoInfo> {
    register(&app, &state, Repo::init(&path, Vec::new())?)
}

/// Clones `url` into `destination` with the user's `git` and opens the clone.
/// Progress is emitted with `destination` as the path; `cancel_operation` stops it.
#[tauri::command(async)]
#[specta::specta]
pub fn clone_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    destination: String,
) -> Result<RepoInfo> {
    let repo = state.with_operation(&destination, |token| {
        let mut report = progress::reporter(app.clone(), destination.clone(), "clone");
        Ok(Repo::clone_with_progress(
            &url,
            &destination,
            Vec::new(),
            token,
            &mut report,
        )?)
    })?;
    register(&app, &state, repo)
}

/// Stops the network operation running for `path`; `false` when there is none.
#[tauri::command(async)]
#[specta::specta]
pub fn cancel_operation(state: State<'_, AppState>, path: String) -> bool {
    state.cancel(&path)
}

#[tauri::command(async)]
#[specta::specta]
pub fn close_repository(state: State<'_, AppState>, path: String) {
    state.remove(&path);
}

/// Re-reads `HEAD` and forgets the cached history, after the repository changed on disk.
#[tauri::command(async)]
#[specta::specta]
pub fn refresh_repository(state: State<'_, AppState>, path: String) -> Result<RepoInfo> {
    state.with_repo(&path, |repo| {
        repo.refresh();
        repo.info()
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn repository_refs(state: State<'_, AppState>, path: String) -> Result<Vec<RefInfo>> {
    state.with_repo(&path, |repo| repo.refs())
}

/// Opens `file` with the application the system associates with it.
#[tauri::command(async)]
#[specta::specta]
pub fn open_in_editor(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    file: String,
) -> Result<()> {
    let full = state.with_repo(&path, |repo| repo.full_path(&file))?;
    app.opener()
        .open_path(full.to_string_lossy().to_string(), None::<&str>)?;
    Ok(())
}

/// Shows `file` in the system file manager.
#[tauri::command(async)]
#[specta::specta]
pub fn reveal_in_file_manager(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    file: String,
) -> Result<()> {
    let full = state.with_repo(&path, |repo| repo.full_path(&file))?;
    app.opener().reveal_item_in_dir(full)?;
    Ok(())
}

// ---- history --------------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
pub fn commit_count(state: State<'_, AppState>, path: String) -> Result<u32> {
    state.with_repo(&path, |repo| repo.commit_count())
}

/// Rows `offset..offset + limit` of the commit graph, newest first.
#[tauri::command(async)]
#[specta::specta]
pub fn graph_rows(
    state: State<'_, AppState>,
    path: String,
    offset: u32,
    limit: u32,
) -> Result<Vec<GraphRow>> {
    state.with_repo(&path, |repo| repo.graph_rows(offset, limit))
}

/// Row of commit `id` in the graph, or `None` when no branch or tag reaches it.
#[tauri::command(async)]
#[specta::specta]
pub fn commit_index(state: State<'_, AppState>, path: String, id: String) -> Result<Option<u32>> {
    state.with_repo(&path, |repo| repo.commit_index(&id))
}

/// Rows of the commits matching `query` (id prefix, summary, author), at most `limit`.
#[tauri::command(async)]
#[specta::specta]
pub fn search_commits(
    state: State<'_, AppState>,
    path: String,
    query: String,
    limit: u32,
) -> Result<Vec<u32>> {
    state.with_repo(&path, |repo| repo.search_commits(&query, limit))
}

#[tauri::command(async)]
#[specta::specta]
pub fn commit_details(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<CommitDetails> {
    state.with_repo(&path, |repo| repo.commit_details(&id))
}

/// The changes commit `id` made to the file at `file`.
#[tauri::command(async)]
#[specta::specta]
pub fn commit_file_diff(
    state: State<'_, AppState>,
    path: String,
    id: String,
    file: String,
) -> Result<FileDiff> {
    state.with_repo(&path, |repo| repo.commit_file_diff(&id, &file))
}

/// Both versions of `file` around commit `id`.
#[tauri::command(async)]
#[specta::specta]
pub fn commit_file_contents(
    state: State<'_, AppState>,
    path: String,
    id: String,
    file: String,
    old_file: Option<String>,
) -> Result<FileContents> {
    state.with_repo(&path, |repo| {
        repo.commit_file_contents(&id, &file, old_file.as_deref())
    })
}

// ---- working tree ---------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
pub fn working_tree_status(state: State<'_, AppState>, path: String) -> Result<WorkingTreeStatus> {
    state.with_repo(&path, |repo| repo.status())
}

/// Stages `files`; a file missing from the working tree has its deletion staged.
#[tauri::command(async)]
#[specta::specta]
pub fn stage_files(state: State<'_, AppState>, path: String, files: Vec<String>) -> Result<()> {
    state.with_repo(&path, |repo| repo.stage(&files))
}

#[tauri::command(async)]
#[specta::specta]
pub fn unstage_files(state: State<'_, AppState>, path: String, files: Vec<String>) -> Result<()> {
    state.with_repo(&path, |repo| repo.unstage(&files))
}

#[tauri::command(async)]
#[specta::specta]
pub fn stage_all(state: State<'_, AppState>, path: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.stage_all())
}

#[tauri::command(async)]
#[specta::specta]
pub fn unstage_all(state: State<'_, AppState>, path: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.unstage_all())
}

/// Stages hunk `hunk` (0-based, as `workdir_file_diff` lists them) of `file`.
#[tauri::command(async)]
#[specta::specta]
pub fn stage_hunk(
    state: State<'_, AppState>,
    path: String,
    file: String,
    old_file: Option<String>,
    hunk: u32,
) -> Result<()> {
    state.with_repo(&path, |repo| {
        repo.stage_hunk(&file, old_file.as_deref(), hunk)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn unstage_hunk(
    state: State<'_, AppState>,
    path: String,
    file: String,
    old_file: Option<String>,
    hunk: u32,
) -> Result<()> {
    state.with_repo(&path, |repo| {
        repo.unstage_hunk(&file, old_file.as_deref(), hunk)
    })
}

/// Throws away the unstaged changes to `files`: tracked files are restored from
/// the index, untracked ones deleted.
#[tauri::command(async)]
#[specta::specta]
pub fn discard_files(state: State<'_, AppState>, path: String, files: Vec<String>) -> Result<()> {
    state.with_repo(&path, |repo| repo.discard(&files))
}

#[tauri::command(async)]
#[specta::specta]
pub fn discard_all(state: State<'_, AppState>, path: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.discard_all())
}

/// The unstaged (`staged == false`) or staged (`staged == true`) changes to `file`.
/// `old_file` is the previous path of a renamed file.
#[tauri::command(async)]
#[specta::specta]
pub fn workdir_file_diff(
    state: State<'_, AppState>,
    path: String,
    file: String,
    old_file: Option<String>,
    staged: bool,
) -> Result<FileDiff> {
    state.with_repo(&path, |repo| {
        repo.workdir_file_diff(&file, old_file.as_deref(), staged)
    })
}

/// Both versions of `file` for its unstaged or staged changes.
#[tauri::command(async)]
#[specta::specta]
pub fn workdir_file_contents(
    state: State<'_, AppState>,
    path: String,
    file: String,
    old_file: Option<String>,
    staged: bool,
) -> Result<FileContents> {
    state.with_repo(&path, |repo| {
        repo.workdir_file_contents(&file, old_file.as_deref(), staged)
    })
}

/// Appends `patterns` to the root `.gitignore`, creating it when missing.
#[tauri::command(async)]
#[specta::specta]
pub fn ignore_paths(state: State<'_, AppState>, path: String, patterns: Vec<String>) -> Result<()> {
    state.with_repo(&path, |repo| repo.add_to_gitignore(&patterns))
}

/// Commits the staged changes with the user's `git` (or amends the last commit);
/// returns the new commit id.
#[tauri::command(async)]
#[specta::specta]
pub fn commit(
    state: State<'_, AppState>,
    path: String,
    message: String,
    amend: bool,
) -> Result<String> {
    state.with_repo(&path, |repo| repo.commit(&message, amend))
}

// ---- branches and tags ----------------------------------------------------------

/// Checks out a branch or tag by the name the refs list reports.
#[tauri::command(async)]
#[specta::specta]
pub fn checkout(
    state: State<'_, AppState>,
    path: String,
    name: String,
    kind: RefKind,
) -> Result<()> {
    state.with_repo(&path, |repo| repo.checkout(&name, kind))
}

/// Checks out commit `id`, leaving `HEAD` detached.
#[tauri::command(async)]
#[specta::specta]
pub fn checkout_commit(state: State<'_, AppState>, path: String, id: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.checkout_commit(&id))
}

/// Creates branch `name` at `start_point` (a commit id, branch or tag).
#[tauri::command(async)]
#[specta::specta]
pub fn create_branch(
    state: State<'_, AppState>,
    path: String,
    name: String,
    start_point: String,
    checkout: bool,
) -> Result<()> {
    state.with_repo(&path, |repo| {
        repo.create_branch(&name, &start_point, checkout)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn rename_branch(
    state: State<'_, AppState>,
    path: String,
    name: String,
    new_name: String,
) -> Result<()> {
    state.with_repo(&path, |repo| repo.rename_branch(&name, &new_name))
}

/// Deletes a local branch; `force` also drops one that is not merged yet.
#[tauri::command(async)]
#[specta::specta]
pub fn delete_branch(
    state: State<'_, AppState>,
    path: String,
    name: String,
    force: bool,
) -> Result<()> {
    state.with_repo(&path, |repo| repo.delete_branch(&name, force))
}

/// Deletes `origin/feature` on the remote itself.
#[tauri::command(async)]
#[specta::specta]
pub fn delete_remote_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<()> {
    run_remote(&app, &state, &path, "push", |repo| {
        repo.delete_remote_branch_command(&name)
    })
}

/// Pushes branch `name` to `remote` (the default one when `None`) and tracks it.
#[tauri::command(async)]
#[specta::specta]
pub fn push_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
    remote: Option<String>,
) -> Result<()> {
    run_remote(&app, &state, &path, "push", |repo| {
        repo.push_branch_command(&name, remote.as_deref())
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn set_upstream(
    state: State<'_, AppState>,
    path: String,
    branch: String,
    upstream: String,
) -> Result<()> {
    state.with_repo(&path, |repo| repo.set_upstream(&branch, &upstream))
}

/// Creates a tag at `target`; annotated when `message` is given.
#[tauri::command(async)]
#[specta::specta]
pub fn create_tag(
    state: State<'_, AppState>,
    path: String,
    name: String,
    target: String,
    message: Option<String>,
) -> Result<()> {
    state.with_repo(&path, |repo| {
        repo.create_tag(&name, &target, message.as_deref())
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn delete_tag(state: State<'_, AppState>, path: String, name: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.delete_tag(&name))
}

// ---- merges and friends ---------------------------------------------------------

/// Merges `reference` into the current branch; conflicts leave the repository in
/// the merge state with the conflicted paths in the status.
#[tauri::command(async)]
#[specta::specta]
pub fn merge(state: State<'_, AppState>, path: String, reference: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.merge(&reference))
}

/// Rebases the current branch onto `onto`.
#[tauri::command(async)]
#[specta::specta]
pub fn rebase(state: State<'_, AppState>, path: String, onto: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.rebase(&onto))
}

#[tauri::command(async)]
#[specta::specta]
pub fn cherry_pick(state: State<'_, AppState>, path: String, id: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.cherry_pick(&id))
}

#[tauri::command(async)]
#[specta::specta]
pub fn revert(state: State<'_, AppState>, path: String, id: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.revert(&id))
}

/// Abandons the merge, rebase, cherry-pick or revert in progress.
#[tauri::command(async)]
#[specta::specta]
pub fn abort_operation(state: State<'_, AppState>, path: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.abort_operation())
}

/// Finishes the operation in progress once its conflicts are staged.
#[tauri::command(async)]
#[specta::specta]
pub fn continue_operation(state: State<'_, AppState>, path: String) -> Result<()> {
    state.with_repo(&path, |repo| repo.continue_operation())
}

/// Resolves the conflict in `file` by keeping one side whole, then stages it.
#[tauri::command(async)]
#[specta::specta]
pub fn resolve_conflict(
    state: State<'_, AppState>,
    path: String,
    file: String,
    side: ConflictSide,
) -> Result<()> {
    state.with_repo(&path, |repo| repo.resolve_conflict(&file, side))
}

// ---- stashes --------------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
pub fn stash_list(state: State<'_, AppState>, path: String) -> Result<Vec<StashEntry>> {
    state.with_repo(&path, |repo| repo.stash_list())
}

/// Saves the working tree and index to a new stash and restores `HEAD`.
#[tauri::command(async)]
#[specta::specta]
pub fn stash_push(
    state: State<'_, AppState>,
    path: String,
    message: String,
    include_untracked: bool,
) -> Result<()> {
    state.with_repo(&path, |repo| repo.stash_push(&message, include_untracked))
}

#[tauri::command(async)]
#[specta::specta]
pub fn stash_apply(state: State<'_, AppState>, path: String, index: u32) -> Result<()> {
    state.with_repo(&path, |repo| repo.stash_apply(index))
}

#[tauri::command(async)]
#[specta::specta]
pub fn stash_pop(state: State<'_, AppState>, path: String, index: u32) -> Result<()> {
    state.with_repo(&path, |repo| repo.stash_pop(index))
}

#[tauri::command(async)]
#[specta::specta]
pub fn stash_drop(state: State<'_, AppState>, path: String, index: u32) -> Result<()> {
    state.with_repo(&path, |repo| repo.stash_drop(index))
}

// ---- remotes --------------------------------------------------------------------

/// Runs a command that talks to a remote: its progress goes to the frontend as
/// `operation`, `cancel_operation` stops it, and the repository stays free for
/// other commands while `git` is on the network.
fn run_remote(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    operation: &'static str,
    prepare: impl FnOnce(&Repo) -> gitui_core::Result<RemoteCommand>,
) -> Result<()> {
    let command = state.with_repo(path, |repo| prepare(repo))?;
    let result = state.with_operation(path, |token| {
        let mut report = progress::reporter(app.clone(), path.to_owned(), operation);
        Ok(command.run(token, &mut report)?)
    });
    // Even a command that failed may have moved references. The repository may
    // also have been closed meanwhile, which leaves nothing to forget.
    let _ = state.with_repo(path, |repo| {
        repo.refresh();
        Ok(())
    });
    result
}

/// Fetches every remote and prunes branches deleted upstream.
#[tauri::command(async)]
#[specta::specta]
pub fn fetch(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<()> {
    run_remote(&app, &state, &path, "fetch", Repo::fetch_command)
}

/// How long the automatic fetch may take before it is abandoned.
const BACKGROUND_FETCH_TIMEOUT: Duration = Duration::from_secs(45);

/// Fetches every remote on the application's own initiative and tells whether a
/// branch or tag moved. Unlike [`fetch`] it never asks for credentials, and it
/// leaves the repository free for other commands while `git` runs.
#[tauri::command(async)]
#[specta::specta]
pub fn fetch_in_background(state: State<'_, AppState>, path: String) -> Result<bool> {
    let (fetch, before) =
        state.with_repo(&path, |repo| Ok((repo.background_fetch()?, repo.refs()?)))?;
    fetch.run_within(BACKGROUND_FETCH_TIMEOUT)?;
    let after = state.with_repo(&path, |repo| repo.refs())?;
    Ok(before != after)
}

/// `git pull` on the current branch, honouring the user's `pull.rebase` setting.
#[tauri::command(async)]
#[specta::specta]
pub fn pull(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<()> {
    run_remote(&app, &state, &path, "pull", Repo::pull_command)
}

/// Pushes the current branch, setting its upstream on the first push.
#[tauri::command(async)]
#[specta::specta]
pub fn push(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<()> {
    run_remote(&app, &state, &path, "push", Repo::push_command)
}
