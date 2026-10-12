//! The commit message assistant: the user's API keys (kept in the keychain,
//! never sent to the frontend), the assistants installed on the machine, and
//! the request to the model.

use open_git_ai::{
    AiModel, Changes, CommitSuggestion, Error, Provider, clear_key, cli_available, cli_models,
    list_models, load_key, save_key, suggest_commit_message,
};
use tauri::State;

use crate::{error::Result, state::AppState};

fn key(provider: Provider) -> Result<String> {
    Ok(load_key(provider)?.ok_or(Error::NoKey(provider.label()))?)
}

/// The providers that can be used now: a key is stored for them, or their
/// program is installed.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_providers() -> Result<Vec<Provider>> {
    let mut usable = Vec::new();
    for provider in Provider::ALL {
        let found = if provider.program().is_some() {
            cli_available(provider)
        } else {
            load_key(provider)?.is_some()
        };
        if found {
            usable.push(provider);
        }
    }
    Ok(usable)
}

/// Checks `key` by listing what it can use, then stores it. Returns that list.
#[tauri::command]
#[specta::specta]
pub async fn ai_save_key(provider: Provider, key: String) -> Result<Vec<AiModel>> {
    let key = key.trim();
    let models = list_models(provider, key).await?;
    save_key(provider, key)?;
    Ok(models)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ai_clear_key(provider: Provider) -> Result<()> {
    Ok(clear_key(provider)?)
}

/// The models to choose from, newest first: what the stored key can use, or
/// the few names an installed program accepts besides its own default.
#[tauri::command]
#[specta::specta]
pub async fn ai_models(provider: Provider) -> Result<Vec<AiModel>> {
    if provider.program().is_some() {
        return Ok(cli_models(provider));
    }
    Ok(list_models(provider, &key(provider)?).await?)
}

/// Sends the staged changes of `path` (what the amended commit would hold, with
/// `amend`) to `model` and returns the message it proposes. An empty `model`
/// leaves an installed program its own default.
#[tauri::command]
#[specta::specta]
pub async fn ai_commit_message(
    state: State<'_, AppState>,
    path: String,
    provider: Provider,
    model: String,
    amend: bool,
) -> Result<CommitSuggestion> {
    let key = match provider.program() {
        Some(_) => None,
        None => Some(key(provider)?),
    };
    // The repository is only held while `git` reads the diff, not during the request.
    let staged = state.with_repo(&path, |repo| repo.staged_changes(amend))?;
    let changes = Changes {
        files: &staged.files,
        patch: &staged.patch,
        recent_subjects: &staged.recent_subjects,
    };
    Ok(suggest_commit_message(provider, key.as_deref(), &model, changes).await?)
}
