//! Operations that change the repository beyond staging and committing:
//! branches, tags, stashes, merges and friends, and discarding changes.
//!
//! Everything that rewrites history or touches remotes runs the user's `git`,
//! so hooks, signing and configuration apply.

use std::{fs, path::Path};

use git2::{RepositoryState, build::CheckoutBuilder};
use serde::{Deserialize, Serialize};

use crate::{CancelToken, Error, RemoteCommand, Repo, Result, diff};

/// Which version of a conflicted file to keep whole.
///
/// Git's naming: during a merge `Ours` is the checked-out branch and `Theirs`
/// the branch being merged; during a rebase the two are swapped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// Whether an operation is waiting for the user to resolve conflicts or continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum RepoState {
    Clean,
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
    Other,
}

pub(crate) fn repo_state(state: RepositoryState) -> RepoState {
    match state {
        RepositoryState::Clean => RepoState::Clean,
        RepositoryState::Merge => RepoState::Merge,
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => RepoState::Rebase,
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => RepoState::CherryPick,
        RepositoryState::Revert | RepositoryState::RevertSequence => RepoState::Revert,
        RepositoryState::Bisect => RepoState::Bisect,
        _ => RepoState::Other,
    }
}

/// A saved stash, newest first (`index` 0 is `stash@{0}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub id: String,
}

impl Repo {
    // ---- branches and tags ------------------------------------------------------

    /// Creates `name` at `start_point` (a commit id, branch or tag), checking it
    /// out when asked.
    pub fn create_branch(&mut self, name: &str, start_point: &str, checkout: bool) -> Result<()> {
        if checkout {
            self.run_git(&["switch", "-c", name, start_point], None)?;
        } else {
            self.run_git(&["branch", name, start_point], None)?;
        }
        self.refresh();
        Ok(())
    }

    pub fn rename_branch(&mut self, name: &str, new_name: &str) -> Result<()> {
        self.run_git(&["branch", "-m", name, new_name], None)?;
        self.refresh();
        Ok(())
    }

    /// Deletes a local branch; `force` also drops one that is not merged yet.
    pub fn delete_branch(&mut self, name: &str, force: bool) -> Result<()> {
        self.run_git(&["branch", if force { "-D" } else { "-d" }, name], None)?;
        self.refresh();
        Ok(())
    }

    /// Deletes `origin/feature` on the remote itself.
    pub fn delete_remote_branch(&mut self, name: &str) -> Result<()> {
        let result = self
            .delete_remote_branch_command(name)?
            .run(&CancelToken::new(), &mut |_| {});
        self.refresh();
        result
    }

    pub fn delete_remote_branch_command(&self, name: &str) -> Result<RemoteCommand> {
        let (remote, branch) = self.split_remote_branch(name)?;
        self.remote_command(&["push", &remote, "--delete", &branch])
    }

    /// Pushes `name` to `remote` (the default one when `None`) and tracks it.
    pub fn push_branch(&mut self, name: &str, remote: Option<&str>) -> Result<()> {
        let result = self
            .push_branch_command(name, remote)?
            .run(&CancelToken::new(), &mut |_| {});
        self.refresh();
        result
    }

    pub fn push_branch_command(&self, name: &str, remote: Option<&str>) -> Result<RemoteCommand> {
        let remote = match remote {
            Some(remote) => remote.to_owned(),
            None => self.default_remote()?,
        };
        self.remote_command(&["push", "--progress", "--set-upstream", &remote, name])
    }

    pub fn set_upstream(&mut self, branch: &str, upstream: &str) -> Result<()> {
        self.run_git(
            &["branch", &format!("--set-upstream-to={upstream}"), branch],
            None,
        )?;
        self.refresh();
        Ok(())
    }

    /// Creates a tag at `target`; annotated when a message is given.
    pub fn create_tag(&mut self, name: &str, target: &str, message: Option<&str>) -> Result<()> {
        match message.map(str::trim).filter(|message| !message.is_empty()) {
            Some(message) => {
                self.run_git(&["tag", "-a", "-F", "-", name, target], Some(message))?
            }
            None => self.run_git(&["tag", name, target], None)?,
        };
        self.refresh();
        Ok(())
    }

    pub fn delete_tag(&mut self, name: &str) -> Result<()> {
        self.run_git(&["tag", "-d", name], None)?;
        self.refresh();
        Ok(())
    }

    /// Checks out commit `id`, leaving `HEAD` detached.
    pub fn checkout_commit(&mut self, id: &str) -> Result<()> {
        self.run_git(&["switch", "--detach", id], None)?;
        self.refresh();
        Ok(())
    }

    // ---- history ----------------------------------------------------------------

    /// Merges `reference` into the current branch. Conflicts leave the repository
    /// in the `Merge` state with the conflicted paths in the status.
    pub fn merge(&mut self, reference: &str) -> Result<()> {
        let result = self.run_git(&["merge", "--no-edit", reference], None);
        self.refresh();
        result.map(|_| ())
    }

    /// Rebases the current branch onto `onto`.
    pub fn rebase(&mut self, onto: &str) -> Result<()> {
        let result = self.run_git(&["rebase", onto], None);
        self.refresh();
        result.map(|_| ())
    }

    pub fn cherry_pick(&mut self, id: &str) -> Result<()> {
        let result = self.run_git(&["cherry-pick", id], None);
        self.refresh();
        result.map(|_| ())
    }

    pub fn revert(&mut self, id: &str) -> Result<()> {
        let result = self.run_git(&["revert", "--no-edit", id], None);
        self.refresh();
        result.map(|_| ())
    }

    /// Abandons the merge, rebase, cherry-pick or revert in progress.
    pub fn abort_operation(&mut self) -> Result<()> {
        let args: &[&str] = match self.git.state() {
            RepositoryState::Merge => &["merge", "--abort"],
            RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge => &["rebase", "--abort"],
            RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
                &["cherry-pick", "--abort"]
            }
            RepositoryState::Revert | RepositoryState::RevertSequence => &["revert", "--abort"],
            _ => return Err(Error::NoOperation),
        };
        self.run_git(args, None)?;
        self.refresh();
        Ok(())
    }

    /// Resolves the conflict in `path` by keeping one side whole, then stages it.
    pub fn resolve_conflict(&self, path: &str, side: ConflictSide) -> Result<()> {
        let flag = match side {
            ConflictSide::Ours => "--ours",
            ConflictSide::Theirs => "--theirs",
        };
        self.run_git(&["checkout", flag, "--", path], None)?;
        self.stage(&[path.to_owned()])
    }

    /// Finishes the operation in progress once its conflicts are staged.
    pub fn continue_operation(&mut self) -> Result<()> {
        let args: &[&str] = match self.git.state() {
            RepositoryState::Merge => &["commit", "--no-edit"],
            RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge => &["rebase", "--continue"],
            RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
                &["cherry-pick", "--continue"]
            }
            RepositoryState::Revert | RepositoryState::RevertSequence => &["revert", "--continue"],
            _ => return Err(Error::NoOperation),
        };
        self.run_git(args, None)?;
        self.refresh();
        Ok(())
    }

    // ---- stashes ----------------------------------------------------------------

    pub fn stash_list(&mut self) -> Result<Vec<StashEntry>> {
        let mut entries = Vec::new();
        self.git.stash_foreach(|index, message, id| {
            entries.push(StashEntry {
                index: index as u32,
                message: message.to_owned(),
                id: id.to_string(),
            });
            true
        })?;
        Ok(entries)
    }

    /// Saves the working tree and index to a new stash and restores `HEAD`.
    pub fn stash_push(&mut self, message: &str, include_untracked: bool) -> Result<()> {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        let message = message.trim();
        if !message.is_empty() {
            args.push("-m");
            args.push(message);
        }
        self.run_git(&args, None)?;
        self.refresh();
        Ok(())
    }

    pub fn stash_apply(&mut self, index: u32) -> Result<()> {
        let result = self.run_git(&["stash", "apply", &format!("stash@{{{index}}}")], None);
        self.refresh();
        result.map(|_| ())
    }

    pub fn stash_pop(&mut self, index: u32) -> Result<()> {
        let result = self.run_git(&["stash", "pop", &format!("stash@{{{index}}}")], None);
        self.refresh();
        result.map(|_| ())
    }

    pub fn stash_drop(&mut self, index: u32) -> Result<()> {
        self.run_git(&["stash", "drop", &format!("stash@{{{index}}}")], None)?;
        self.refresh();
        Ok(())
    }

    // ---- working tree -----------------------------------------------------------

    /// Throws away the unstaged changes to `paths`: tracked files are restored
    /// from the index, untracked ones are deleted.
    pub fn discard(&self, paths: &[String]) -> Result<()> {
        let workdir = self.workdir()?;
        let index = self.git.index()?;
        let mut tracked = Vec::new();
        for path in paths {
            if index.get_path(Path::new(path), 0).is_some() {
                tracked.push(path.as_str());
                continue;
            }
            match fs::remove_file(workdir.join(path)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(Error::Io {
                        path: path.clone(),
                        source,
                    });
                }
            }
        }
        if !tracked.is_empty() {
            let mut options = CheckoutBuilder::new();
            options.force();
            for path in tracked {
                options.path(path);
            }
            self.git.checkout_index(None, Some(&mut options))?;
        }
        Ok(())
    }

    /// Throws away every unstaged change.
    pub fn discard_all(&self) -> Result<()> {
        let paths: Vec<String> = self
            .status()?
            .unstaged
            .into_iter()
            .flat_map(|entry| [Some(entry.path), entry.old_path])
            .flatten()
            .collect();
        if paths.is_empty() {
            return Ok(());
        }
        self.discard(&paths)
    }

    /// Stages hunk `hunk` (0-based, as `workdir_file_diff` numbers them) of `path`.
    pub fn stage_hunk(&self, path: &str, old_path: Option<&str>, hunk: u32) -> Result<()> {
        let patch = diff::hunk_patch(&self.git, path, old_path, hunk, false)?;
        self.run_git(
            &["apply", "--cached", "--whitespace=nowarn", "-"],
            Some(&patch),
        )?;
        Ok(())
    }

    /// Unstages hunk `hunk` of the staged changes to `path`.
    pub fn unstage_hunk(&self, path: &str, old_path: Option<&str>, hunk: u32) -> Result<()> {
        let patch = diff::hunk_patch(&self.git, path, old_path, hunk, true)?;
        self.run_git(
            &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
            Some(&patch),
        )?;
        Ok(())
    }
}
