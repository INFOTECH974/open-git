use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use open_git_core::{CancelToken, Repo};
use open_git_forge::{Accounts, GitHub, account_token, load_accounts};
use tauri::AppHandle;

use crate::{
    error::{AppError, Result},
    watcher::{self, RepoWatcher},
};

type Shared<T> = Arc<Mutex<T>>;

/// The connected GitHub accounts and the API client of each one that was used.
#[derive(Default)]
struct GitHubState {
    /// Whether the keychain was read: it is asked once, not before every fetch.
    read: bool,
    /// What the keychain lists; `None` as long as it lists nothing a version
    /// that knows several accounts wrote.
    accounts: Option<Accounts>,
    /// By login. A client keeps the answers GitHub gave it (see `GitHub::poll`),
    /// which are those of its account.
    clients: HashMap<String, GitHub>,
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
    github: Mutex<GitHubState>,
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
            Err(error) => eprintln!("open-git: cannot watch {path}: {error}"),
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
        f: impl FnOnce(&mut Repo) -> open_git_core::Result<T>,
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

    /// The connected GitHub accounts, read from the keychain on first use.
    /// `None` when no account was ever connected by a version that knows several.
    pub fn github_accounts(&self) -> open_git_forge::Result<Option<Accounts>> {
        let mut github = lock(&self.github);
        if !github.read {
            github.accounts = load_accounts()?;
            github.read = true;
        }
        Ok(github.accounts.clone())
    }

    /// Takes note of what the keychain now lists. The clients of the accounts
    /// that left are dropped, and `client` is kept for the account named with it.
    pub fn set_github_accounts(&self, accounts: Accounts, client: Option<(String, GitHub)>) {
        let mut github = lock(&self.github);
        github
            .clients
            .retain(|login, _| accounts.find(login).is_some());
        if let Some((login, client)) = client {
            github.clients.insert(login, client);
        }
        github.accounts = Some(accounts);
        github.read = true;
    }

    /// The API client of the connected account `login`, built from its token the
    /// first time. Call it from an `async` command: the client needs the runtime.
    pub fn github_client(&self, login: &str) -> open_git_forge::Result<GitHub> {
        if let Some(client) = lock(&self.github).clients.get(login) {
            return Ok(client.clone());
        }
        let token = account_token(login)?.ok_or(open_git_forge::Error::SignedOut)?;
        let client = GitHub::connect(&token)?;
        lock(&self.github)
            .clients
            .insert(login.to_owned(), client.clone());
        Ok(client)
    }
}
