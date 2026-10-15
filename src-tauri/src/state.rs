use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use open_git_core::{CancelToken, Repo};
use open_git_forge::{Access, Accounts, GitHub, GitHubRepo, account_token, load_accounts};
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
    /// What each account may do with each repository GitHub was asked about, by
    /// login and `owner/name`, both in lower case.
    access: HashMap<(String, String), Access>,
    /// Whether the tokens were shown to GitHub since the start.
    checked: bool,
}

fn access_key(login: &str, repo: &GitHubRepo) -> (String, String) {
    (
        login.to_ascii_lowercase(),
        format!("{}/{}", repo.owner, repo.name).to_ascii_lowercase(),
    )
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
    /// that left are dropped, and `client` is kept for the account named with it,
    /// whose token is new: what GitHub said of the previous one no longer holds.
    pub fn set_github_accounts(&self, mut accounts: Accounts, client: Option<(String, GitHub)>) {
        let mut github = lock(&self.github);
        let renewed = client.as_ref().map(|(login, _)| login.to_ascii_lowercase());
        let kept = |login: &str| {
            accounts.find(login).is_some()
                && renewed.as_deref() != Some(login.to_ascii_lowercase().as_str())
        };
        let refused = github
            .accounts
            .take()
            .map(|previous| previous.refused)
            .unwrap_or_default()
            .into_iter()
            .filter(|login| kept(login))
            .collect();
        github.clients.retain(|login, _| kept(login));
        github.access.retain(|(login, _), _| kept(login));
        if let Some((login, client)) = client {
            github.clients.insert(login, client);
        }
        accounts.refused = refused;
        github.accounts = Some(accounts);
        github.read = true;
    }

    /// Takes note that GitHub no longer accepts the token of `login`.
    pub fn refuse_github_account(&self, login: &str) {
        let mut github = lock(&self.github);
        if let Some(accounts) = github.accounts.as_mut()
            && let Some(account) = accounts.find(login)
            && !accounts.is_refused(login)
        {
            let login = account.login.clone();
            accounts.refused.push(login);
        }
    }

    /// Whether the tokens still have to be shown to GitHub; true only once.
    pub fn start_github_check(&self) -> bool {
        !std::mem::replace(&mut lock(&self.github).checked, true)
    }

    /// What `login` may do with `repo`, when GitHub was asked.
    pub fn github_access(&self, login: &str, repo: &GitHubRepo) -> Option<Access> {
        let github = lock(&self.github);
        if github
            .accounts
            .as_ref()
            .is_some_and(|accounts| accounts.is_refused(login))
        {
            return Some(Access::Refused);
        }
        github.access.get(&access_key(login, repo)).copied()
    }

    pub fn set_github_access(&self, login: &str, repo: &GitHubRepo, access: Access) {
        if access == Access::Refused {
            self.refuse_github_account(login);
        }
        lock(&self.github)
            .access
            .insert(access_key(login, repo), access);
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
