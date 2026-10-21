#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error("`{path}` was not changed by this commit")]
    PathNotInCommit { path: String },
    #[error("`{path}` has no changes to show")]
    PathNotChanged { path: String },
    #[error("hunk {hunk} does not exist in `{path}`")]
    HunkNotFound { path: String, hunk: u32 },
    #[error("could not run `git`: {source}")]
    Spawn { source: std::io::Error },
    #[error("{command} failed{}: {message}", exit_code(.code))]
    Command {
        command: String,
        code: Option<i32>,
        message: String,
    },
    #[error("could not write `{path}`: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("this repository has no working directory")]
    Bare,
    #[error("the commit message is empty")]
    EmptyMessage,
    #[error("HEAD is detached; check out a branch first")]
    DetachedHead,
    #[error("this repository has no remote to push to")]
    NoRemote,
    #[error("a remote needs a name and a URL")]
    IncompleteRemote,
    #[error("`{name}` does not belong to a configured remote")]
    UnknownRemote { name: String },
    #[error("no merge, rebase, cherry-pick or revert is in progress")]
    NoOperation,
    #[error("the operation was cancelled")]
    Cancelled,
}

fn exit_code(code: &Option<i32>) -> String {
    match code {
        Some(code) => format!(" (exit code {code})"),
        None => String::new(),
    }
}

pub type Result<T> = std::result::Result<T, Error>;
