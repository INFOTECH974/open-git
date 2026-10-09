use git2::{Commit, Diff, DiffOptions, Oid, Patch, Repository};
use serde::Serialize;

use crate::{Error, Result, commit::FileStatus, lossy};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
    /// Git's "\ No newline at end of file" marker.
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    /// The line without its terminator.
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Hunk {
    /// The `@@ -1,3 +1,4 @@` line.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// The changes made to one file.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

/// Diffs a commit against its first parent, or against the empty tree for a root commit.
pub(crate) fn commit_diff<'repo>(
    repo: &'repo Repository,
    commit: &Commit<'_>,
) -> Result<Diff<'repo>> {
    let tree = commit.tree()?;
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
    diff.find_similar(None)?;
    Ok(diff)
}

pub(crate) fn commit_file(repo: &Repository, commit_id: &str, path: &str) -> Result<FileDiff> {
    let commit = repo.find_commit(Oid::from_str(commit_id)?)?;
    let diff = commit_diff(repo, &commit)?;
    let index = delta_index(&diff, path).ok_or_else(|| Error::PathNotInCommit {
        path: path.to_owned(),
    })?;
    read_file_diff(&diff, index, path)
}

/// The diff of one working tree file: working tree against index when
/// `staged == false`, index against `HEAD` when `staged == true`.
///
/// `old_path` lets a rename be detected when the file was moved.
fn workdir_diff<'repo>(
    repo: &'repo Repository,
    path: &str,
    old_path: Option<&str>,
    staged: bool,
) -> Result<Diff<'repo>> {
    let mut options = DiffOptions::new();
    options
        .pathspec(path)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    if let Some(old_path) = old_path {
        options.pathspec(old_path);
    }
    let mut diff = if staged {
        let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut options))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut options))?
    };
    diff.find_similar(None)?;
    Ok(diff)
}

pub(crate) fn workdir_file(
    repo: &Repository,
    path: &str,
    old_path: Option<&str>,
    staged: bool,
) -> Result<FileDiff> {
    let diff = workdir_diff(repo, path, old_path, staged)?;
    let index = delta_index(&diff, path).ok_or_else(|| Error::PathNotChanged {
        path: path.to_owned(),
    })?;
    read_file_diff(&diff, index, path)
}

/// A unified patch holding only hunk `hunk` of the working tree diff of `path`,
/// ready for `git apply --cached`.
pub(crate) fn hunk_patch(
    repo: &Repository,
    path: &str,
    old_path: Option<&str>,
    hunk: u32,
    staged: bool,
) -> Result<String> {
    let diff = workdir_diff(repo, path, old_path, staged)?;
    let index = delta_index(&diff, path).ok_or_else(|| Error::PathNotChanged {
        path: path.to_owned(),
    })?;
    let mut patch = Patch::from_diff(&diff, index)?.ok_or_else(|| Error::PathNotChanged {
        path: path.to_owned(),
    })?;
    let text = lossy(&patch.to_buf()?);

    // The header runs up to the first hunk; every later `@@` line starts a hunk.
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    for line in text.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            hunks.push(String::new());
        }
        match hunks.last_mut() {
            Some(current) => current.push_str(line),
            None => header.push_str(line),
        }
    }
    let selected = hunks
        .get(hunk as usize)
        .ok_or_else(|| Error::HunkNotFound {
            path: path.to_owned(),
            hunk,
        })?;
    Ok(format!("{header}{selected}"))
}

/// Position of the delta whose new path is `path`.
fn delta_index(diff: &Diff<'_>, path: &str) -> Option<usize> {
    diff.deltas()
        .position(|delta| delta.new_file().path_bytes() == Some(path.as_bytes()))
}

fn read_file_diff(diff: &Diff<'_>, index: usize, path: &str) -> Result<FileDiff> {
    // No patch is produced for binary files.
    let patch = Patch::from_diff(diff, index)?;
    let delta = diff.get_delta(index).expect("index comes from the diff");
    let status = FileStatus::from_delta(delta.status());
    let hunks = match &patch {
        Some(patch) => (0..patch.num_hunks())
            .map(|hunk| read_hunk(patch, hunk))
            .collect::<Result<_>>()?,
        None => Vec::new(),
    };

    Ok(FileDiff {
        path: path.to_owned(),
        old_path: matches!(status, FileStatus::Renamed | FileStatus::Copied)
            .then(|| lossy(delta.old_file().path_bytes().unwrap_or_default())),
        status,
        binary: delta.flags().is_binary(),
        hunks,
    })
}

fn read_hunk(patch: &Patch<'_>, hunk_index: usize) -> Result<Hunk> {
    let (hunk, line_count) = patch.hunk(hunk_index)?;
    let lines = (0..line_count)
        .map(|line_index| {
            let line = patch.line_in_hunk(hunk_index, line_index)?;
            let kind = match line.origin() {
                '+' => DiffLineKind::Addition,
                '-' => DiffLineKind::Deletion,
                ' ' => DiffLineKind::Context,
                _ => DiffLineKind::NoNewline,
            };
            Ok(DiffLine {
                kind,
                old_lineno: line.old_lineno(),
                new_lineno: line.new_lineno(),
                content: lossy(line.content()).trim_matches(['\r', '\n']).to_owned(),
            })
        })
        .collect::<Result<_>>()?;

    Ok(Hunk {
        header: lossy(hunk.header()).trim_end().to_owned(),
        lines,
    })
}
