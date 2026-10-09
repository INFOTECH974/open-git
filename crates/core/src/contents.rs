//! Whole-file contents on both sides of a change, for side-by-side views.

use std::path::Path;

use git2::{Oid, Repository, Tree};
use serde::Serialize;

use crate::{Error, Result};

/// Files beyond this size are not sent to the UI.
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    /// Content before the change; `None` for an added file.
    pub old: Option<String>,
    /// Content after the change; `None` for a deleted file.
    pub new: Option<String>,
    /// Either side looks binary; the texts are then empty.
    pub binary: bool,
    /// Either side exceeds the size limit; the texts are then empty.
    pub too_large: bool,
}

impl FileContents {
    fn from_sides(old: Option<Vec<u8>>, new: Option<Vec<u8>>) -> Self {
        let binary = [&old, &new]
            .iter()
            .any(|side| side.as_deref().is_some_and(looks_binary));
        let too_large = [&old, &new]
            .iter()
            .any(|side| side.as_deref().is_some_and(|bytes| bytes.len() > MAX_BYTES));
        let text = |bytes: Option<Vec<u8>>| {
            bytes.map(|bytes| {
                if binary || too_large {
                    String::new()
                } else {
                    String::from_utf8_lossy(&bytes).into_owned()
                }
            })
        };
        Self {
            old: text(old),
            new: text(new),
            binary,
            too_large,
        }
    }
}

/// Git's own heuristic: a NUL byte in the first 8000 bytes.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&byte| byte == 0)
}

fn blob_in_tree(repo: &Repository, tree: Option<&Tree<'_>>, path: &str) -> Result<Option<Vec<u8>>> {
    let Some(tree) = tree else {
        return Ok(None);
    };
    match tree.get_path(Path::new(path)) {
        Ok(entry) => {
            let object = entry.to_object(repo)?;
            Ok(object.as_blob().map(|blob| blob.content().to_vec()))
        }
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn blob_in_index(repo: &Repository, path: &str) -> Result<Option<Vec<u8>>> {
    let index = repo.index()?;
    match index.get_path(Path::new(path), 0) {
        Some(entry) => Ok(Some(repo.find_blob(entry.id)?.content().to_vec())),
        None => Ok(None),
    }
}

fn file_in_workdir(repo: &Repository, path: &str) -> Result<Option<Vec<u8>>> {
    let workdir = repo.workdir().ok_or(Error::Bare)?;
    match std::fs::read(workdir.join(path)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(Error::Io {
            path: path.to_owned(),
            source,
        }),
    }
}

/// `path` in commit `id` and `old_path` (or `path`) in its first parent.
pub(crate) fn commit_file(
    repo: &Repository,
    id: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileContents> {
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let tree = commit.tree()?;
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };
    let old = blob_in_tree(repo, parent_tree.as_ref(), old_path.unwrap_or(path))?;
    let new = blob_in_tree(repo, Some(&tree), path)?;
    if old.is_none() && new.is_none() {
        return Err(Error::PathNotInCommit {
            path: path.to_owned(),
        });
    }
    Ok(FileContents::from_sides(old, new))
}

/// Unstaged: index against working tree. Staged: `HEAD` against index.
pub(crate) fn workdir_file(
    repo: &Repository,
    path: &str,
    old_path: Option<&str>,
    staged: bool,
) -> Result<FileContents> {
    let (old, new) = if staged {
        let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        (
            blob_in_tree(repo, head_tree.as_ref(), old_path.unwrap_or(path))?,
            blob_in_index(repo, path)?,
        )
    } else {
        (
            blob_in_index(repo, old_path.unwrap_or(path))?,
            file_in_workdir(repo, path)?,
        )
    };
    if old.is_none() && new.is_none() {
        return Err(Error::PathNotChanged {
            path: path.to_owned(),
        });
    }
    Ok(FileContents::from_sides(old, new))
}
