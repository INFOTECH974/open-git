//! Tells the frontend when a repository changes on disk, so it refreshes
//! without a manual click.

use std::{path::PathBuf, time::Duration};

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::Serialize;
use tauri::AppHandle;
use tauri_specta::Event;

/// What changed: the history (refs, `HEAD`, index) or only the working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    History,
    WorkingTree,
}

/// Emitted at most every few hundred milliseconds per repository.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChanged {
    /// The repository path, as `RepoInfo::path` reports it.
    pub path: String,
    pub kind: ChangeKind,
}

/// Stops watching when dropped.
pub struct RepoWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

const QUIET_PERIOD: Duration = Duration::from_millis(300);

pub fn watch(app: AppHandle, repo_path: String) -> notify::Result<RepoWatcher> {
    let root = PathBuf::from(&repo_path);
    let git_dir = root.join(".git");
    // A separate handle, only used to skip ignored files such as build output.
    let ignores = git2::Repository::open(&root).ok();
    let watched = root.clone();

    let mut debouncer = new_debouncer(QUIET_PERIOD, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let mut history = false;
        let mut worktree = false;
        for event in events {
            if let Ok(inside_git) = event.path.strip_prefix(&git_dir) {
                let first = inside_git
                    .components()
                    .next()
                    .map(|component| component.as_os_str().to_string_lossy().into_owned())
                    .unwrap_or_default();
                // The object store churns on every operation; lock files come and go.
                // Every fetch rewrites `FETCH_HEAD`, even one that brings nothing: the
                // references it moves are what counts.
                if matches!(first.as_str(), "objects" | "logs" | "lfs" | "FETCH_HEAD")
                    || first.ends_with(".lock")
                {
                    continue;
                }
                history = true;
            } else if let Ok(relative) = event.path.strip_prefix(&root) {
                let ignored = ignores
                    .as_ref()
                    .and_then(|repo| repo.is_path_ignored(relative).ok())
                    .unwrap_or(false);
                if !ignored {
                    worktree = true;
                }
            }
        }
        let kind = if history {
            ChangeKind::History
        } else if worktree {
            ChangeKind::WorkingTree
        } else {
            return;
        };
        let _ = RepositoryChanged {
            path: repo_path.clone(),
            kind,
        }
        .emit(&app);
    })?;
    debouncer
        .watcher()
        .watch(&watched, RecursiveMode::Recursive)?;
    Ok(RepoWatcher {
        _debouncer: debouncer,
    })
}
