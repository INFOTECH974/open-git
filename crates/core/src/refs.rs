use git2::{ReferenceType, Repository};
use serde::{Deserialize, Serialize};

use crate::{Result, lossy};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

/// A branch or tag and the commit it points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RefInfo {
    /// Short name, such as `main`, `origin/main` or `v1.0`.
    pub name: String,
    pub kind: RefKind,
    /// Id of the commit the ref resolves to.
    pub target: String,
}

pub(crate) fn list(repo: &Repository) -> Result<Vec<RefInfo>> {
    let mut refs = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        let kind = if reference.is_branch() {
            RefKind::LocalBranch
        } else if reference.is_remote() {
            RefKind::RemoteBranch
        } else if reference.is_tag() {
            RefKind::Tag
        } else {
            continue;
        };
        // `refs/remotes/origin/HEAD` only aliases another remote branch.
        if reference.kind() == Some(ReferenceType::Symbolic) {
            continue;
        }
        // Tags can point at trees or blobs, which have no place in the graph.
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        refs.push(RefInfo {
            name: lossy(reference.shorthand_bytes()),
            kind,
            target: commit.id().to_string(),
        });
    }
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(refs)
}
