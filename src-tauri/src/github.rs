//! GitHub commands: the connected account and the pull requests, issues and
//! workflow runs of the repository behind a tab's `origin` remote.

use open_git_forge::{
    Account, Comment, DeviceCode, DevicePoll, GitHub, GitHubRepo, Issue, ItemState, PullRequest,
    RemoteRepository, WorkflowJob, WorkflowRun, clear_token, load_token, parse_github_url,
    poll_device, save_token, start_device_flow,
};
use serde::Serialize;
use tauri::State;

use crate::{
    error::{AppError, Result},
    state::{AppState, GitHubSession},
};

/// The OAuth App this build signs in with; without it only tokens pasted by the
/// user work. Set `OPEN_GIT_GITHUB_CLIENT_ID` when building.
const CLIENT_ID: Option<&str> = option_env!("OPEN_GIT_GITHUB_CLIENT_ID");

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

async fn sign_in(state: &AppState, token: &str) -> Result<Account> {
    let client = GitHub::connect(token)?;
    let account = client.account().await?;
    save_token(token)?;
    state.set_github(Some(GitHubSession {
        client,
        account: account.clone(),
    }));
    Ok(account)
}

fn session(state: &AppState) -> Result<GitHubSession> {
    state
        .github()
        .ok_or_else(|| AppError::GitHub(open_git_forge::Error::SignedOut.to_string()))
}

fn github_repo(state: &AppState, path: &str) -> Result<GitHubRepo> {
    let url = state
        .with_repo(path, |repo| repo.remote_url("origin"))?
        .ok_or_else(|| AppError::GitHub("this repository has no `origin` remote".to_owned()))?;
    parse_github_url(&url)
        .ok_or_else(|| AppError::GitHub(open_git_forge::Error::NotGitHub { url }.to_string()))
}

// ---- account --------------------------------------------------------------------

/// The connected account, signing in with the stored token on first use.
#[tauri::command]
#[specta::specta]
pub async fn github_account(state: State<'_, AppState>) -> Result<Option<Account>> {
    if let Some(session) = state.github() {
        return Ok(Some(session.account));
    }
    let Some(token) = load_token().map_err(|error| AppError::GitHub(error.to_string()))? else {
        return Ok(None);
    };
    Ok(Some(sign_in(&state, &token).await?))
}

/// Signs in with a personal access token typed by the user.
#[tauri::command]
#[specta::specta]
pub async fn github_sign_in(state: State<'_, AppState>, token: String) -> Result<Account> {
    sign_in(&state, token.trim()).await
}

#[tauri::command]
#[specta::specta]
pub async fn github_sign_out(state: State<'_, AppState>) -> Result<()> {
    clear_token()?;
    state.set_github(None);
    Ok(())
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

/// The repositories the connected account can clone, most recently pushed first.
#[tauri::command]
#[specta::specta]
pub async fn github_repositories(state: State<'_, AppState>) -> Result<Vec<RemoteRepository>> {
    Ok(session(&state)?.client.repositories().await?)
}

// ---- repository -----------------------------------------------------------------

/// The GitHub repository behind `origin`, or `None` when it is not on github.com.
#[tauri::command]
#[specta::specta]
pub async fn github_repository(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<GitHubRepo>> {
    let url = state.with_repo(&path, |repo| repo.remote_url("origin"))?;
    Ok(url.as_deref().and_then(parse_github_url))
}

#[tauri::command]
#[specta::specta]
pub async fn github_pull_requests(
    state: State<'_, AppState>,
    path: String,
    item_state: ItemState,
) -> Result<Vec<PullRequest>> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?
        .client
        .pull_requests(&repo, item_state)
        .await?)
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
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?
        .client
        .create_pull_request(&repo, &title, &body, &head, &base, draft)
        .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn github_issues(
    state: State<'_, AppState>,
    path: String,
    item_state: ItemState,
) -> Result<Vec<Issue>> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?.client.issues(&repo, item_state).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn github_create_issue(
    state: State<'_, AppState>,
    path: String,
    title: String,
    body: String,
) -> Result<Issue> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?
        .client
        .create_issue(&repo, &title, &body)
        .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn github_issue_comments(
    state: State<'_, AppState>,
    path: String,
    number: u32,
) -> Result<Vec<Comment>> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?
        .client
        .issue_comments(&repo, number as u64)
        .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn github_comment_issue(
    state: State<'_, AppState>,
    path: String,
    number: u32,
    body: String,
) -> Result<Comment> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?
        .client
        .comment_issue(&repo, number as u64, &body)
        .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn github_close_issue(
    state: State<'_, AppState>,
    path: String,
    number: u32,
) -> Result<Issue> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?
        .client
        .close_issue(&repo, number as u64)
        .await?)
}

/// The latest runs of the repository's workflows, newest first. The UI calls
/// this every few seconds while one of them runs.
#[tauri::command]
#[specta::specta]
pub async fn github_workflow_runs(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<WorkflowRun>> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?.client.workflow_runs(&repo).await?)
}

/// The jobs of a workflow run, each with its steps.
#[tauri::command]
#[specta::specta]
pub async fn github_workflow_jobs(
    state: State<'_, AppState>,
    path: String,
    run: u64,
) -> Result<Vec<WorkflowJob>> {
    let repo = github_repo(&state, &path)?;
    Ok(session(&state)?.client.workflow_jobs(&repo, run).await?)
}
