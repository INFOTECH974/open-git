//! The working tree: what is staged, what is not, and moving files between the two.

use std::{collections::HashSet, path::Path};

use git2::{DiffDelta, IndexAddOption, ObjectType, Repository, Status, StatusOptions};
use serde::Serialize;

use crate::{Error, Result, commit::FileStatus, lossy};

/// A file that differs between two of `HEAD`, the index and the working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    /// Previous path, for renames.
    pub old_path: Option<String>,
    pub status: FileStatus,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    /// Index compared to `HEAD`: what the next commit will contain.
    pub staged: Vec<StatusEntry>,
    /// Working tree compared to the index, untracked files included.
    pub unstaged: Vec<StatusEntry>,
    /// Paths with unresolved merge conflicts.
    pub conflicted: Vec<String>,
}

impl WorkingTreeStatus {
    pub fn is_clean(&self) -> bool {
        self.staged.is_empty() && self.unstaged.is_empty() && self.conflicted.is_empty()
    }
}

const STAGED: Status = Status::INDEX_NEW
    .union(Status::INDEX_MODIFIED)
    .union(Status::INDEX_DELETED)
    .union(Status::INDEX_RENAMED)
    .union(Status::INDEX_TYPECHANGE);
const UNSTAGED: Status = Status::WT_NEW
    .union(Status::WT_MODIFIED)
    .union(Status::WT_DELETED)
    .union(Status::WT_RENAMED)
    .union(Status::WT_TYPECHANGE);

pub(crate) fn status(repo: &Repository) -> Result<WorkingTreeStatus> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let mut result = WorkingTreeStatus::default();
    for entry in repo.statuses(Some(&mut options))?.iter() {
        let flags = entry.status();
        if flags.is_conflicted() {
            result.conflicted.push(lossy(entry.path_bytes()));
            continue;
        }
        if flags.intersects(STAGED)
            && let Some(delta) = entry.head_to_index()
        {
            result.staged.push(entry_from(&delta));
        }
        if flags.intersects(UNSTAGED)
            && let Some(delta) = entry.index_to_workdir()
        {
            result.unstaged.push(entry_from(&delta));
        }
    }
    // libgit2 orders paths case-insensitively on Windows; keep one order everywhere.
    result.staged.sort_by(|a, b| a.path.cmp(&b.path));
    result.unstaged.sort_by(|a, b| a.path.cmp(&b.path));
    result.conflicted.sort();
    Ok(result)
}

fn entry_from(delta: &DiffDelta<'_>) -> StatusEntry {
    let status = FileStatus::from_delta(delta.status());
    StatusEntry {
        path: lossy(delta.new_file().path_bytes().unwrap_or_default()),
        old_path: matches!(status, FileStatus::Renamed | FileStatus::Copied)
            .then(|| lossy(delta.old_file().path_bytes().unwrap_or_default())),
        status,
    }
}

/// Stages `paths`: adds their working tree content to the index, or records their deletion.
pub(crate) fn stage(repo: &Repository, paths: &[String]) -> Result<()> {
    let workdir = repo.workdir().ok_or(Error::Bare)?;
    let mut index = repo.index()?;
    for path in paths {
        let relative = Path::new(path);
        // `symlink_metadata` keeps a dangling symlink stageable.
        if workdir.join(relative).symlink_metadata().is_ok() {
            index.add_path(relative)?;
        } else {
            index.remove_path(relative)?;
        }
    }
    index.write()?;
    Ok(())
}

pub(crate) fn stage_all(repo: &Repository) -> Result<()> {
    let mut index = repo.index()?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    // `add_all` ignores files that disappeared; `update_all` records their deletion.
    index.update_all(["*"], None)?;
    index.write()?;
    Ok(())
}

/// Unstages `paths`: resets their index entries to `HEAD`, or drops them from the
/// index in a repository without commits.
pub(crate) fn unstage(repo: &Repository, paths: &[String]) -> Result<()> {
    let head = repo
        .head()
        .ok()
        .and_then(|head| head.peel(ObjectType::Commit).ok());
    repo.reset_default(head.as_ref(), paths)?;
    Ok(())
}

pub(crate) fn unstage_all(repo: &Repository) -> Result<()> {
    let paths: Vec<String> = status(repo)?
        .staged
        .into_iter()
        .flat_map(|entry| [Some(entry.path), entry.old_path])
        .flatten()
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    unstage(repo, &paths)
}

/// Appends `patterns` to `<workdir>/.gitignore`, creating the file when missing,
/// skipping lines already present and keeping the file's line endings.
pub(crate) fn add_to_gitignore(workdir: &Path, patterns: &[String]) -> Result<()> {
    let file = workdir.join(".gitignore");
    let io = |source| Error::Io {
        path: ".gitignore".to_owned(),
        source,
    };
    let mut content = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(io(error)),
    };

    let added: Vec<String> = {
        let present: HashSet<&[u8]> = content
            .split(|&byte| byte == b'\n')
            .map(|line| line.strip_suffix(b"\r").unwrap_or(line).trim_ascii())
            .collect();
        let mut added: Vec<String> = Vec::new();
        for pattern in patterns {
            let pattern = pattern.trim();
            if pattern.is_empty()
                || present.contains(pattern.as_bytes())
                || added.iter().any(|line| line == pattern)
            {
                continue;
            }
            added.push(pattern.to_owned());
        }
        added
    };
    if added.is_empty() {
        return Ok(());
    }

    let eol: &[u8] = if content.contains(&b'\r') {
        b"\r\n"
    } else {
        b"\n"
    };
    if !content.is_empty() && !content.ends_with(b"\n") {
        content.extend_from_slice(eol);
    }
    for pattern in added {
        content.extend_from_slice(pattern.as_bytes());
        content.extend_from_slice(eol);
    }
    std::fs::write(&file, content).map_err(io)
}
