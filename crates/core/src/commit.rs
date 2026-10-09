use git2::{Delta, Diff, Oid, Patch, Repository};
use serde::Serialize;

use crate::{Result, diff::commit_diff, lossy};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
}

impl Signature {
    fn from_git(signature: &git2::Signature<'_>) -> Self {
        Self {
            name: lossy(signature.name_bytes()),
            email: lossy(signature.email_bytes()),
            time: signature.when().seconds(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    TypeChanged,
    /// Unresolved merge conflict (working tree only).
    Conflicted,
}

impl FileStatus {
    pub(crate) fn from_delta(delta: Delta) -> Self {
        match delta {
            // An untracked file is shown as an addition the user has not staged yet.
            Delta::Added | Delta::Untracked => Self::Added,
            Delta::Deleted => Self::Deleted,
            Delta::Renamed => Self::Renamed,
            Delta::Copied => Self::Copied,
            Delta::Typechange => Self::TypeChanged,
            Delta::Conflicted => Self::Conflicted,
            _ => Self::Modified,
        }
    }
}

/// A file touched by a commit, compared to the commit's first parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Previous path, for renames and copies.
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CommitDetails {
    pub id: String,
    pub summary: String,
    /// The message without its summary line.
    pub body: String,
    pub author: Signature,
    pub committer: Signature,
    pub parents: Vec<String>,
    pub files: Vec<FileChange>,
}

pub(crate) fn details(repo: &Repository, id: &str) -> Result<CommitDetails> {
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let diff = commit_diff(repo, &commit)?;
    let files = (0..diff.deltas().len())
        .map(|index| file_change(&diff, index))
        .collect::<Result<_>>()?;

    Ok(CommitDetails {
        id: commit.id().to_string(),
        summary: lossy(commit.summary_bytes().unwrap_or_default()),
        body: lossy(commit.body_bytes().unwrap_or_default()),
        author: Signature::from_git(&commit.author()),
        committer: Signature::from_git(&commit.committer()),
        parents: commit.parent_ids().map(|id| id.to_string()).collect(),
        files,
    })
}

fn file_change(diff: &Diff<'_>, index: usize) -> Result<FileChange> {
    // libgit2 only learns whether a file is binary once it has loaded its content.
    let patch = Patch::from_diff(diff, index)?;
    let delta = diff.get_delta(index).expect("index comes from the diff");
    let (additions, deletions) = match &patch {
        Some(patch) => {
            let (_, additions, deletions) = patch.line_stats()?;
            (additions as u32, deletions as u32)
        }
        None => (0, 0),
    };
    let status = FileStatus::from_delta(delta.status());

    Ok(FileChange {
        path: lossy(delta.new_file().path_bytes().unwrap_or_default()),
        old_path: matches!(status, FileStatus::Renamed | FileStatus::Copied)
            .then(|| lossy(delta.old_file().path_bytes().unwrap_or_default())),
        status,
        additions,
        deletions,
        binary: delta.flags().is_binary(),
    })
}
