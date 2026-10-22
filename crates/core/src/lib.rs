//! Git operations for Open GIT, independent of any UI framework.
//!
//! Reading (history, refs, diffs, status, staging) goes through libgit2; writing
//! history and talking to remotes (commit, checkout, merge, fetch, pull, push)
//! runs the user's `git` binary, see [`exec`].

mod commit;
mod contents;
mod diff;
mod error;
mod exec;
mod graph;
mod ops;
mod refs;
mod repo;
mod status;

pub use commit::{CommitDetails, FileChange, FileStatus, Signature};
pub use contents::FileContents;
pub use diff::{DiffLine, DiffLineKind, FileDiff, Hunk};
pub use error::{Error, Result};
pub use exec::{ASKPASS_ENV, CancelToken, add_config, set_askpass};
pub use graph::{GraphRow, LaneRef, RowLayout};
pub use ops::{ConflictSide, RepoState, StashEntry};
pub use refs::{RefInfo, RefKind};
pub use repo::{
    HeadInfo, Identity, Progress, PullMode, RemoteCommand, Repo, RepoInfo, StagedChanges,
};
pub use status::{StatusEntry, WorkingTreeStatus};

/// Git stores names, messages and paths as bytes; the UI only deals in strings.
fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
