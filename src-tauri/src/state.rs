use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use gitui_core::{CancelToken, Repo};
use gitui_forge::{Account, GitHub};
use tauri::AppHandle;

use crate::{
    error::{AppError, Result},
    watcher::{self, RepoWatcher},
};

type Shared<T> = Arc<Mutex<T>>;

/// The connected GitHub account and its API client.
#[derive(Clone)]
pub struct GitHubSession {
    pub client: GitHub,
    pub account: Account,
}

/// The repositories the user has opened, keyed by the path `RepoInfo::path` reports.
///
/// Every command takes that path, so the frontend keeps several repositories open
/// at once (one per tab). Each repository has its own lock: a long push on one
/// tab does not block reading another.
#[derive(Default)]
pub struct AppState {
    repos: Mutex<HashMap<String, Shared<Repo>>>,
    watchers: Mutex<HashMap<String, RepoWatcher>>,
    /// The network operation running per path (a clone is keyed by its destination).
    operations: Mutex<HashMap<String, CancelToken>>,
    github: Mutex<Option<GitHubSession>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding a lock leaves the data intact, so keep using it.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl AppState {
    /// Registers an open repository and starts watching it for changes.
    pub fn insert(&self, app: &AppHandle, path: String, repo: Repo) {
        lock(&self.repos).insert(path.clone(), Arc::new(Mutex::new(repo)));
        match watcher::watch(app.clone(), path.clone()) {
            Ok(watcher) => {
                lock(&self.watchers).insert(path, watcher);
            }
            Err(error) => eprintln!("gitui: cannot watch {path}: {error}"),
        }
    }

    pub fn remove(&self, path: &str) {
        lock(&self.watchers).remove(path);
        lock(&self.repos).remove(path);
    }

    /// Runs `f` on the open repository at `path`.
    pub fn with_repo<T>(
        &self,
        path: &str,
        f: impl FnOnce(&mut Repo) -> gitui_core::Result<T>,
    ) -> Result<T> {
        // The map lock is released at the end of this statement.
        let repo = lock(&self.repos)
            .get(path)
            .cloned()
            .ok_or_else(|| AppError::RepositoryNotOpen(path.to_owned()))?;
        let mut repo = lock(&repo);
        Ok(f(&mut repo)?)
    }

    /// Runs a cancellable network operation for `path`, keeping its token
    /// reachable by [`AppState::cancel`] until it finishes.
    pub fn with_operation<T>(
        &self,
        path: &str,
        f: impl FnOnce(&CancelToken) -> Result<T>,
    ) -> Result<T> {
        let token = CancelToken::new();
        lock(&self.operations).insert(path.to_owned(), token.clone());
        let result = f(&token);
        lock(&self.operations).remove(path);
        result
    }

    /// Stops the network operation running for `path`, if any.
    pub fn cancel(&self, path: &str) -> bool {
        match lock(&self.operations).get(path) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn github(&self) -> Option<GitHubSession> {
        lock(&self.github).clone()
    }

    pub fn set_github(&self, session: Option<GitHubSession>) {
        *lock(&self.github) = session;
    }
}
