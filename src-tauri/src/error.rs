use serde::Serialize;

/// What the frontend receives when a command fails.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum AppError {
    /// The repository was never opened, or was closed.
    RepositoryNotOpen(String),
    /// libgit2, the `git` binary or the core layer refused the operation.
    Git(String),
    /// The operating system refused something (opening a file, for instance).
    System(String),
    /// GitHub, the keychain or the sign-in refused something.
    GitHub(String),
}

impl From<gitui_core::Error> for AppError {
    fn from(error: gitui_core::Error) -> Self {
        Self::Git(error.to_string())
    }
}

impl From<gitui_forge::Error> for AppError {
    fn from(error: gitui_forge::Error) -> Self {
        Self::GitHub(error.to_string())
    }
}

impl From<tauri_plugin_opener::Error> for AppError {
    fn from(error: tauri_plugin_opener::Error) -> Self {
        Self::System(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
