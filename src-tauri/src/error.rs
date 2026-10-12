use serde::Serialize;

/// What the frontend receives when a command fails.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum AppError {
    /// The repository was never opened, or was closed.
    RepositoryNotOpen(String),
    /// libgit2, the `git` binary or the core layer refused the operation.
    Git(String),
    /// The user stopped the operation: nothing went wrong.
    Cancelled(String),
    /// The operating system refused something (opening a file, for instance).
    System(String),
    /// GitHub, the keychain or the sign-in refused something.
    GitHub(String),
    /// The model provider, or the keychain holding its key, refused something.
    Ai(String),
    /// The update of the application could not be found, checked or installed.
    Update(String),
}

impl From<tauri_plugin_updater::Error> for AppError {
    fn from(error: tauri_plugin_updater::Error) -> Self {
        Self::Update(error.to_string())
    }
}

impl From<open_git_ai::Error> for AppError {
    fn from(error: open_git_ai::Error) -> Self {
        Self::Ai(error.to_string())
    }
}

impl From<open_git_core::Error> for AppError {
    fn from(error: open_git_core::Error) -> Self {
        match error {
            open_git_core::Error::Cancelled => Self::Cancelled(error.to_string()),
            _ => Self::Git(error.to_string()),
        }
    }
}

impl From<open_git_forge::Error> for AppError {
    fn from(error: open_git_forge::Error) -> Self {
        Self::GitHub(error.to_string())
    }
}

impl From<tauri_plugin_opener::Error> for AppError {
    fn from(error: tauri_plugin_opener::Error) -> Self {
        Self::System(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
