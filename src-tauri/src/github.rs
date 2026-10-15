//! GitHub commands: the connected accounts and the pull requests, issues and
//! workflow runs of the repository behind a tab's `origin` remote.

use std::ffi::OsString;

use open_git_core::{Repo, add_config};
use open_git_forge::{
    ACCOUNT_ENV, Account, Accounts, Comment, DeviceCode, DevicePoll, GitHub, GitHubRepo, Issue,
    ItemState, PullRequest, RemoteRepository, USERNAME_CONFIG, WorkflowJob, WorkflowRun,
    activate_account, legacy_token, parse_github_url, poll_device, remove_account, save_account,
    start_device_flow,
};
use serde::Serialize;
use tauri::State;

use crate::{
    error::{AppError, Result},
    state::AppState,
};

/// The OAuth App this build signs in with; without it only tokens pasted by the
/// user work. Set `OPEN_GIT_GITHUB_CLIENT_ID` when building.
const CLIENT_ID: Option<&str> = option_env!("OPEN_GIT_GITHUB_CLIENT_ID");

/// The git configuration variable in which a repository names, by its login, the
/// account that works on it. Set in a user's configuration (under an `includeIf`,
/// say), it applies to every repository that names none.
const ACCOUNT_CONFIG: &str = "open-git.account";

/// One step of the device sign-in, as the UI sees it (the token itself never
/// leaves the backend).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum DeviceStatus {
    Pending,
    SlowDown,
    SignedIn(Account),
    Failed(String),
}

/// Where a repository lives on GitHub, and the connected account that works on it.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubLink {
    pub repo: GitHubRepo,
    /// Login of the account used for this repository; `None` when none is connected.
    pub account: Option<String>,
    /// Login of the account the repository names, when it is a connected one.
    /// Without it the account is one that GitHub lets push to the repository,
    /// the active one first (see [`Accounts::for_repository`]).
    pub bound: Option<String>,
}

impl GitHubLink {
    fn new(state: &AppState, accounts: &Accounts, repo: GitHubRepo, named: Option<&str>) -> Self {
        let bound = named.and_then(|login| accounts.find(login));
        let account = accounts.for_repository(named, &repo.owner, |account| {
            state.github_access(&account.login, &repo)
        });
        Self {
            account: account.map(|account| account.login.clone()),
            bound: bound.map(|account| account.login.clone()),
            repo,
        }
    }
}

/// Checks `token` with GitHub, then stores it with the account it belongs to,
/// which becomes the active one.
async fn sign_in(state: &AppState, token: &str) -> Result<Account> {
    let client = GitHub::connect(token)?;
    let account = client.account().await?;
    let accounts = save_account(&account, token)?;
    state.set_github_accounts(accounts, Some((account.login.clone(), client)));
    Ok(account)
}

fn accounts(state: &AppState) -> Result<Accounts> {
    Ok(state.github_accounts()?.unwrap_or_default())
}

/// The URL of `origin` and the account the repository at `path` names.
fn origin(state: &AppState, path: &str) -> Result<(Option<String>, Option<String>)> {
    state.with_repo(path, |repo| {
        Ok((
            repo.remote_url("origin")?,
            repo.config_value(ACCOUNT_CONFIG)?,
        ))
    })
}

/// `None` when `origin` is missing or not on github.com.
fn link(state: &AppState, path: &str) -> Result<Option<GitHubLink>> {
    let (url, named) = origin(state, path)?;
    let Some(repo) = url.as_deref().and_then(parse_github_url) else {
        return Ok(None);
    };
    Ok(Some(GitHubLink::new(
        state,
        &accounts(state)?,
        repo,
        named.as_deref(),
    )))
}

/// The GitHub repository behind a tab, and the account that works on it.
struct Session {
    github: GitHub,
    repo: GitHubRepo,
    login: String,
}

impl Session {
    /// What GitHub answered; a token it refuses flags its account.
    fn answer<T>(&self, state: &AppState, answer: open_git_forge::Result<T>) -> Result<T> {
        answer.map_err(|error| refused(state, &self.login, error))
    }
}

/// The session of the repository at `path`.
fn session(state: &AppState, path: &str) -> Result<Session> {
    let (url, named) = origin(state, path)?;
    let url =
        url.ok_or_else(|| AppError::GitHub("this repository has no `origin` remote".to_owned()))?;
    let repo = parse_github_url(&url)
        .ok_or_else(|| AppError::GitHub(open_git_forge::Error::NotGitHub { url }.to_string()))?;
    let link = GitHubLink::new(state, &accounts(state)?, repo, named.as_deref());
    let login = link.account.ok_or(open_git_forge::Error::SignedOut)?;
    Ok(Session {
        github: state.github_client(&login)?,
        repo: link.repo,
        login,
    })
}

/// `error`, said plainly when it is GitHub turning down the token of `login`,
/// which is then flagged: another account takes over where one can.
fn refused(state: &AppState, login: &str, error: open_git_forge::Error) -> AppError {
    if error.is_unauthorized() {
        state.refuse_github_account(login);
        return AppError::TokenRefused(format!(
            "GitHub no longer accepts the token of {login}: connect this account again"
        ));
    }
    error.into()
}

/// Asks GitHub what each connected account may do with `repo`, all at once,
/// for those not asked yet. An account that could not be asked (no network)
/// stays unknown, and is asked again next time.
async fn probe(state: &AppState, accounts: &Accounts, repo: &GitHubRepo) {
    // A single account has no rival to be chosen over.
    if accounts.accounts.len() < 2 {
        return;
    }
    let probes: Vec<_> = accounts
        .accounts
        .iter()
        .filter(|account| state.github_access(&account.login, repo).is_none())
        .filter_map(|account| {
            let client = state.github_client(&account.login).ok()?;
            let (login, repo) = (account.login.clone(), repo.clone());
            Some(tauri::async_runtime::spawn(async move {
                let access = client.access(&repo).await;
                (login, access)
            }))
        })
        .collect();
    for probe in probes {
        if let Ok((login, Ok(access))) = probe.await {
            state.set_github_access(&login, repo, access);
        }
    }
}

/// Shows every token to GitHub once per run, so that the accounts it no longer
/// accepts are flagged before anything fails for them.
async fn check_tokens(state: &AppState) {
    if !state.start_github_check() {
        return;
    }
    let Ok(accounts) = accounts(state) else {
        return;
    };
    let checks: Vec<_> = accounts
        .accounts
        .iter()
        .filter_map(|account| {
            let client = state.github_client(&account.login).ok()?;
            let login = account.login.clone();
            Some(tauri::async_runtime::spawn(async move {
                let answer = client.account().await;
                (login, answer)
            }))
        })
        .collect();
    for check in checks {
        if let Ok((login, Err(error))) = check.await
            && error.is_unauthorized()
        {
            state.refuse_github_account(&login);
        }
    }
}

// ---- git as an account -----------------------------------------------------------

/// Makes the `git` about to run with `env` act as the account `login` on GitHub.
///
/// The user's credential helpers still answer first, but for that account: they
/// no longer hand the token of one account to the repository of another. With a
/// single account there is no one to tell it apart from, and nothing is added.
pub fn act_as(state: &AppState, login: &str, env: &mut Vec<(OsString, OsString)>) {
    if several(state) {
        env.push((ACCOUNT_ENV.into(), login.into()));
        add_config(env, USERNAME_CONFIG, login);
    }
}

/// Whether there are accounts to tell apart.
fn several(state: &AppState) -> bool {
    state
        .github_accounts()
        .ok()
        .flatten()
        .is_some_and(|accounts| accounts.accounts.len() > 1)
}

/// [`act_as`] the account that works on the repository at `path`, when its
/// `origin` is on GitHub.
pub fn identify(state: &AppState, path: &str, env: &mut Vec<(OsString, OsString)>) {
    if several(state)
        && let Ok(Some(link)) = link(state, path)
        && let Some(login) = link.account
    {
        act_as(state, &login, env);
    }
}

/// The account a clone of `url` is made with, and then keeps: the connected one
/// named `login`, when `url` is on GitHub.
pub fn clone_account(state: &AppState, url: &str, login: Option<&str>) -> Option<String> {
    parse_github_url(url)?;
    let accounts = state.github_accounts().ok()??;
    Some(accounts.find(login?)?.login.clone())
}

/// Makes `repo` name `login` as the account that works on it.
pub fn bind(repo: &Repo, login: &str) -> open_git_core::Result<()> {
    repo.set_config_value(ACCOUNT_CONFIG, Some(login))
}

// ---- accounts -------------------------------------------------------------------

/// The connected accounts, those whose token GitHub no longer accepts flagged.
/// The token a version that knew a single account left in the keychain becomes
/// the first of them.
#[tauri::command]
#[specta::specta]
pub async fn github_accounts(state: State<'_, AppState>) -> Result<Accounts> {
    if state.github_accounts()?.is_none()
        && let Some(token) = legacy_token()?
    {
        sign_in(&state, &token).await?;
    }
    check_tokens(&state).await;
    accounts(&state)
}

/// Connects the account a personal access token typed by the user belongs to.
#[tauri::command]
#[specta::specta]
pub async fn github_sign_in(state: State<'_, AppState>, token: String) -> Result<Account> {
    sign_in(&state, token.trim()).await
}

/// Forgets the account `login` and its token; resolves to the accounts left.
#[tauri::command]
#[specta::specta]
pub async fn github_sign_out(state: State<'_, AppState>, login: String) -> Result<Accounts> {
    let accounts = remove_account(&login)?;
    state.set_github_accounts(accounts.clone(), None);
    Ok(accounts)
}

/// Makes `login` the active account: the one that works wherever a repository
/// names no other.
#[tauri::command]
#[specta::specta]
pub async fn github_switch_account(state: State<'_, AppState>, login: String) -> Result<Accounts> {
    let accounts = activate_account(&login)?;
    state.set_github_accounts(accounts.clone(), None);
    Ok(accounts)
}

/// Whether this build can sign in through github.com rather than a pasted token.
#[tauri::command]
#[specta::specta]
pub fn github_device_available() -> bool {
    CLIENT_ID.is_some()
}

#[tauri::command]
#[specta::specta]
pub async fn github_device_start() -> Result<DeviceCode> {
    let client_id =
        CLIENT_ID.ok_or_else(|| AppError::GitHub(open_git_forge::Error::NoClientId.to_string()))?;
    Ok(start_device_flow(client_id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn github_device_poll(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<DeviceStatus> {
    let client_id =
        CLIENT_ID.ok_or_else(|| AppError::GitHub(open_git_forge::Error::NoClientId.to_string()))?;
    Ok(match poll_device(client_id, &device_code).await? {
        DevicePoll::Pending => DeviceStatus::Pending,
        DevicePoll::SlowDown => DeviceStatus::SlowDown,
        DevicePoll::Failed(reason) => DeviceStatus::Failed(reason),
        DevicePoll::Token(token) => DeviceStatus::SignedIn(sign_in(&state, &token).await?),
    })
}

/// The repositories the account `login` (the active one when `None`) can clone,
/// most recently pushed first.
#[tauri::command]
#[specta::specta]
pub async fn github_repositories(
    state: State<'_, AppState>,
    login: Option<String>,
) -> Result<Vec<RemoteRepository>> {
    let accounts = accounts(&state)?;
    let account = match &login {
        Some(login) => {
            accounts
                .find(login)
                .ok_or_else(|| open_git_forge::Error::UnknownAccount {
                    login: login.clone(),
                })?
        }
        None => accounts.active().ok_or(open_git_forge::Error::SignedOut)?,
    };
    let repositories = state.github_client(&account.login)?.repositories().await;
    repositories.map_err(|error| refused(&state, &account.login, error))
}

// ---- repository -----------------------------------------------------------------

/// The GitHub repository behind `origin` and the account that works on it, or
/// `None` when `origin` is not on github.com. Unless the repository names its
/// account, GitHub is first asked what each account may do with it.
#[tauri::command]
#[specta::specta]
pub async fn github_repository(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<GitHubLink>> {
    let (url, named) = origin(&state, &path)?;
    let Some(repo) = url.as_deref().and_then(parse_github_url) else {
        return Ok(None);
    };
    let accounts = accounts(&state)?;
    if named
        .as_deref()
        .and_then(|login| accounts.find(login))
        .is_none()
    {
        probe(&state, &accounts, &repo).await;
    }
    Ok(Some(GitHubLink::new(
        &state,
        &accounts,
        repo,
        named.as_deref(),
    )))
}

/// Makes the repository at `path` name `login` as the account that works on it;
/// with `None` the account is chosen automatically again.
#[tauri::command(async)]
#[specta::specta]
pub fn github_set_repository_account(
    state: State<'_, AppState>,
    path: String,
    login: Option<String>,
) -> Result<()> {
    let login = match login {
        Some(login) => {
            let accounts = accounts(&state)?;
            let account = accounts
                .find(&login)
                .ok_or(open_git_forge::Error::UnknownAccount { login })?;
            Some(account.login.clone())
        }
        None => None,
    };
    state.with_repo(&path, |repo| {
        repo.set_config_value(ACCOUNT_CONFIG, login.as_deref())
    })
}

#[tauri::command]
#[specta::specta]
pub async fn github_pull_requests(
    state: State<'_, AppState>,
    path: String,
    item_state: ItemState,
) -> Result<Vec<PullRequest>> {
    let session = session(&state, &path)?;
    let answer = session
        .github
        .pull_requests(&session.repo, item_state)
        .await;
    session.answer(&state, answer)
}

#[tauri::command]
#[specta::specta]
pub async fn github_create_pull_request(
    state: State<'_, AppState>,
    path: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: bool,
) -> Result<PullRequest> {
    let session = session(&state, &path)?;
    let created = session
        .github
        .create_pull_request(&session.repo, &title, &body, &head, &base, draft)
        .await;
    session.answer(&state, created)
}

#[tauri::command]
#[specta::specta]
pub async fn github_issues(
    state: State<'_, AppState>,
    path: String,
    item_state: ItemState,
) -> Result<Vec<Issue>> {
    let session = session(&state, &path)?;
    let answer = session.github.issues(&session.repo, item_state).await;
    session.answer(&state, answer)
}

#[tauri::command]
#[specta::specta]
pub async fn github_create_issue(
    state: State<'_, AppState>,
    path: String,
    title: String,
    body: String,
) -> Result<Issue> {
    let session = session(&state, &path)?;
    let answer = session
        .github
        .create_issue(&session.repo, &title, &body)
        .await;
    session.answer(&state, answer)
}

#[tauri::command]
#[specta::specta]
pub async fn github_issue_comments(
    state: State<'_, AppState>,
    path: String,
    number: u32,
) -> Result<Vec<Comment>> {
    let session = session(&state, &path)?;
    let answer = session
        .github
        .issue_comments(&session.repo, number as u64)
        .await;
    session.answer(&state, answer)
}

#[tauri::command]
#[specta::specta]
pub async fn github_comment_issue(
    state: State<'_, AppState>,
    path: String,
    number: u32,
    body: String,
) -> Result<Comment> {
    let session = session(&state, &path)?;
    let answer = session
        .github
        .comment_issue(&session.repo, number as u64, &body)
        .await;
    session.answer(&state, answer)
}

#[tauri::command]
#[specta::specta]
pub async fn github_close_issue(
    state: State<'_, AppState>,
    path: String,
    number: u32,
) -> Result<Issue> {
    let session = session(&state, &path)?;
    let answer = session
        .github
        .close_issue(&session.repo, number as u64)
        .await;
    session.answer(&state, answer)
}

/// The latest runs of the repository's workflows, newest first. The UI calls
/// this every few seconds while one of them runs.
#[tauri::command]
#[specta::specta]
pub async fn github_workflow_runs(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<WorkflowRun>> {
    let session = session(&state, &path)?;
    let answer = session.github.workflow_runs(&session.repo).await;
    session.answer(&state, answer)
}

/// The jobs of a workflow run, each with its steps.
#[tauri::command]
#[specta::specta]
pub async fn github_workflow_jobs(
    state: State<'_, AppState>,
    path: String,
    run: u64,
) -> Result<Vec<WorkflowJob>> {
    let session = session(&state, &path)?;
    let answer = session.github.workflow_jobs(&session.repo, run).await;
    session.answer(&state, answer)
}
