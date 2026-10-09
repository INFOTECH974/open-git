use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use git2::{BranchType, ErrorCode, Repository};
use serde::Serialize;

use crate::{
    CommitDetails, Error, FileContents, FileDiff, GraphRow, RefInfo, RefKind, RepoState, Result,
    WorkingTreeStatus, commit, contents, diff,
    exec::{self, CancelToken},
    graph::Graph,
    lossy, ops, refs, status,
};

/// Receives the lines `git` prints while a network operation runs.
pub type Progress<'a> = &'a mut dyn FnMut(&str);

/// What `HEAD` points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HeadInfo {
    /// The checked-out branch; `None` when `HEAD` is detached.
    pub branch: Option<String>,
    /// The checked-out commit; `None` in a repository without commits.
    pub target: Option<String>,
    /// The remote-tracking branch `branch` follows, such as `origin/main`.
    pub upstream: Option<String>,
    /// Commits on `branch` that `upstream` lacks.
    pub ahead: u32,
    /// Commits on `upstream` that `branch` lacks.
    pub behind: u32,
}

/// Who commits are attributed to, from `user.name` and `user.email`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Identity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RepoInfo {
    pub name: String,
    /// The working directory, or the git directory of a bare repository.
    pub path: String,
    pub head: HeadInfo,
    /// Whether a merge, rebase, cherry-pick or revert is waiting to be finished.
    pub state: RepoState,
    /// `None` when `user.name` or `user.email` is not configured.
    pub author: Option<Identity>,
    pub remotes: Vec<String>,
}

/// An open repository.
pub struct Repo {
    pub(crate) git: Repository,
    graph: Option<Graph>,
    pub(crate) git_env: Vec<(OsString, OsString)>,
}

impl Repo {
    /// Opens the repository containing `path`, searching its parent directories.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            git: Repository::discover(path)?,
            graph: None,
            git_env: Vec::new(),
        })
    }

    /// Creates a repository in `path` with the user's `git`, so their
    /// `init.defaultBranch` and templates apply, and opens it.
    pub fn init(path: impl AsRef<Path>, git_env: Vec<(OsString, OsString)>) -> Result<Self> {
        let path = path.as_ref();
        std::fs::create_dir_all(path).map_err(|source| Error::Io {
            path: path.to_string_lossy().into_owned(),
            source,
        })?;
        exec::git(path, &git_env, &["init"], None)?;
        let mut repo = Self::open(path)?;
        repo.git_env = git_env;
        Ok(repo)
    }

    /// Clones `url` into `destination` with the user's `git` and opens the clone.
    pub fn clone(
        url: &str,
        destination: impl AsRef<Path>,
        git_env: Vec<(OsString, OsString)>,
    ) -> Result<Self> {
        Self::clone_with_progress(url, destination, git_env, &CancelToken::new(), &mut |_| {})
    }

    /// [`Repo::clone`] reporting git's progress lines, and stoppable through `token`.
    pub fn clone_with_progress(
        url: &str,
        destination: impl AsRef<Path>,
        git_env: Vec<(OsString, OsString)>,
        token: &CancelToken,
        progress: Progress<'_>,
    ) -> Result<Self> {
        let destination = destination.as_ref();
        let parent = destination.parent().unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent).map_err(|source| Error::Io {
            path: parent.to_string_lossy().into_owned(),
            source,
        })?;
        let name = destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_owned());
        exec::git_with_progress(
            parent,
            &git_env,
            &["clone", "--progress", "--", url, &name],
            token,
            progress,
        )?;
        let mut repo = Self::open(destination)?;
        repo.git_env = git_env;
        Ok(repo)
    }

    /// Extra environment for the `git` processes this repository spawns.
    ///
    /// Tests use it to keep `git` away from the user's configuration.
    pub fn set_git_env(&mut self, env: Vec<(OsString, OsString)>) {
        self.git_env = env;
    }

    pub(crate) fn workdir(&self) -> Result<&Path> {
        self.git.workdir().ok_or(Error::Bare)
    }

    pub fn info(&self) -> Result<RepoInfo> {
        let root = self.git.workdir().unwrap_or_else(|| self.git.path());
        let author = self.git.signature().ok().map(|signature| Identity {
            name: lossy(signature.name_bytes()),
            email: lossy(signature.email_bytes()),
        });
        Ok(RepoInfo {
            name: root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: root
                .to_string_lossy()
                .trim_end_matches(['/', '\\'])
                .to_owned(),
            head: self.head()?,
            state: ops::repo_state(self.git.state()),
            author,
            remotes: self.remote_names()?,
        })
    }

    fn head(&self) -> Result<HeadInfo> {
        let mut info = HeadInfo {
            branch: None,
            target: None,
            upstream: None,
            ahead: 0,
            behind: 0,
        };
        match self.git.head() {
            Ok(head) => {
                info.target = head.target().map(|id| id.to_string());
                if head.is_branch() {
                    let name = lossy(head.shorthand_bytes());
                    self.fill_upstream(&name, &mut info)?;
                    info.branch = Some(name);
                }
            }
            Err(error) if error.code() == ErrorCode::UnbornBranch => {
                let head = self.git.find_reference("HEAD")?;
                info.branch = head
                    .symbolic_target_bytes()
                    .map(|target| lossy(target.strip_prefix(b"refs/heads/").unwrap_or(target)));
            }
            Err(error) => return Err(error.into()),
        }
        Ok(info)
    }

    fn fill_upstream(&self, branch: &str, info: &mut HeadInfo) -> Result<()> {
        let local = self.git.find_branch(branch, BranchType::Local)?;
        let Ok(upstream) = local.upstream() else {
            return Ok(());
        };
        info.upstream = Some(lossy(upstream.name_bytes()?));
        if let (Some(local_id), Some(upstream_id)) = (local.get().target(), upstream.get().target())
        {
            let (ahead, behind) = self.git.graph_ahead_behind(local_id, upstream_id)?;
            info.ahead = ahead as u32;
            info.behind = behind as u32;
        }
        Ok(())
    }

    /// Branches and tags, sorted by name.
    pub fn refs(&self) -> Result<Vec<RefInfo>> {
        refs::list(&self.git)
    }

    /// Forgets the cached history so the next graph query reads the repository again.
    pub fn refresh(&mut self) {
        self.graph = None;
    }

    /// Number of commits reachable from the branches, tags and `HEAD`.
    pub fn commit_count(&mut self) -> Result<u32> {
        Ok(self.graph()?.len() as u32)
    }

    /// Rows `offset..offset + limit` of the commit graph, newest first.
    pub fn graph_rows(&mut self, offset: u32, limit: u32) -> Result<Vec<GraphRow>> {
        self.graph()?;
        let graph = self.graph.as_mut().expect("graph was just loaded");
        graph.rows(&self.git, offset as usize, limit as usize)
    }

    /// Row of commit `id` in the graph; `None` when no branch or tag reaches it.
    pub fn commit_index(&mut self, id: &str) -> Result<Option<u32>> {
        let id = git2::Oid::from_str(id)?;
        Ok(self.graph()?.index_of(id).map(|index| index as u32))
    }

    /// Rows of the commits whose id starts with `query`, or whose summary, author
    /// name or email contains it (case-insensitively); at most `limit` of them.
    pub fn search_commits(&mut self, query: &str, limit: u32) -> Result<Vec<u32>> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        self.graph()?;
        let order = self.graph.as_ref().expect("graph was just loaded").ids();
        let mut hits = Vec::new();
        for (index, &id) in order.iter().enumerate() {
            let matches = id.to_string().starts_with(&needle) || {
                let commit = self.git.find_commit(id)?;
                let author = commit.author();
                lossy(commit.summary_bytes().unwrap_or_default())
                    .to_lowercase()
                    .contains(&needle)
                    || lossy(author.name_bytes()).to_lowercase().contains(&needle)
                    || lossy(author.email_bytes()).to_lowercase().contains(&needle)
            };
            if matches {
                hits.push(index as u32);
                if hits.len() as u32 >= limit {
                    break;
                }
            }
        }
        Ok(hits)
    }

    fn graph(&mut self) -> Result<&Graph> {
        if self.graph.is_none() {
            self.graph = Some(Graph::walk(&self.git)?);
        }
        Ok(self.graph.as_ref().expect("graph was just loaded"))
    }

    pub fn commit_details(&self, id: &str) -> Result<CommitDetails> {
        commit::details(&self.git, id)
    }

    /// The changes commit `id` made to the file at `path`.
    pub fn commit_file_diff(&self, id: &str, path: &str) -> Result<FileDiff> {
        diff::commit_file(&self.git, id, path)
    }

    /// Both versions of `path` around commit `id`, for a side-by-side view.
    pub fn commit_file_contents(
        &self,
        id: &str,
        path: &str,
        old_path: Option<&str>,
    ) -> Result<FileContents> {
        contents::commit_file(&self.git, id, path, old_path)
    }

    // ---- working tree ---------------------------------------------------------

    pub fn status(&self) -> Result<WorkingTreeStatus> {
        status::status(&self.git)
    }

    /// Stages `paths`; a path missing from the working tree has its deletion staged.
    pub fn stage(&self, paths: &[String]) -> Result<()> {
        status::stage(&self.git, paths)
    }

    pub fn stage_all(&self) -> Result<()> {
        status::stage_all(&self.git)
    }

    pub fn unstage(&self, paths: &[String]) -> Result<()> {
        status::unstage(&self.git, paths)
    }

    pub fn unstage_all(&self) -> Result<()> {
        status::unstage_all(&self.git)
    }

    /// Appends `patterns` to the `.gitignore` at the root of the working tree,
    /// skipping those already listed. The file is created when missing.
    pub fn add_to_gitignore(&self, patterns: &[String]) -> Result<()> {
        status::add_to_gitignore(self.workdir()?, patterns)
    }

    /// The unstaged (`staged == false`) or staged (`staged == true`) changes to `path`.
    pub fn workdir_file_diff(
        &self,
        path: &str,
        old_path: Option<&str>,
        staged: bool,
    ) -> Result<FileDiff> {
        diff::workdir_file(&self.git, path, old_path, staged)
    }

    /// Both versions of `path` for the unstaged or staged changes.
    pub fn workdir_file_contents(
        &self,
        path: &str,
        old_path: Option<&str>,
        staged: bool,
    ) -> Result<FileContents> {
        contents::workdir_file(&self.git, path, old_path, staged)
    }

    /// Commits the index with the user's `git`, so hooks and signing apply.
    /// With `amend`, replaces the last commit instead. Returns the new commit id.
    pub fn commit(&mut self, message: &str, amend: bool) -> Result<String> {
        if message.trim().is_empty() {
            return Err(Error::EmptyMessage);
        }
        let mut args = vec!["commit", "--cleanup=strip", "-F", "-"];
        if amend {
            args.push("--amend");
        }
        self.run_git(&args, Some(message))?;
        self.refresh();
        Ok(self
            .git
            .head()?
            .target()
            .map(|id| id.to_string())
            .unwrap_or_default())
    }

    // ---- branches -------------------------------------------------------------

    /// Checks out a branch or tag by the name `RefInfo` reports.
    ///
    /// A remote branch such as `origin/feature` checks out the local `feature`,
    /// creating it to track the remote branch when it does not exist yet. A tag
    /// leaves `HEAD` detached.
    pub fn checkout(&mut self, name: &str, kind: RefKind) -> Result<()> {
        match kind {
            RefKind::LocalBranch => self.run_git(&["switch", name], None)?,
            RefKind::RemoteBranch => {
                let (_, local) = self.split_remote_branch(name)?;
                if self.git.find_branch(&local, BranchType::Local).is_ok() {
                    self.run_git(&["switch", &local], None)?
                } else {
                    self.run_git(&["switch", "--track", name], None)?
                }
            }
            RefKind::Tag => self.run_git(&["switch", "--detach", name], None)?,
        };
        self.refresh();
        Ok(())
    }

    /// `("origin", "feature")` for `origin/feature`, using the configured remotes
    /// to split the name.
    pub(crate) fn split_remote_branch(&self, remote_branch: &str) -> Result<(String, String)> {
        self.remote_names()?
            .into_iter()
            .find_map(|remote| {
                remote_branch
                    .strip_prefix(&format!("{remote}/"))
                    .map(|branch| (remote.clone(), branch.to_owned()))
            })
            .ok_or_else(|| Error::UnknownRemote {
                name: remote_branch.to_owned(),
            })
    }

    /// The fetch URL of remote `name`, or `None` when there is no such remote.
    pub fn remote_url(&self, name: &str) -> Result<Option<String>> {
        match self.git.find_remote(name) {
            Ok(remote) => Ok(Some(remote.url()?.to_owned())),
            Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn remote_names(&self) -> Result<Vec<String>> {
        let remotes = self.git.remotes()?;
        let mut names = Vec::new();
        for remote in remotes.iter() {
            // A name that is not valid UTF-8 cannot be typed on the command line anyway.
            if let Some(name) = remote? {
                names.push(name.to_owned());
            }
        }
        Ok(names)
    }

    // ---- remotes --------------------------------------------------------------

    /// Fetches every remote and prunes branches deleted upstream.
    pub fn fetch(&mut self) -> Result<()> {
        self.fetch_with_progress(&CancelToken::new(), &mut |_| {})
    }

    pub fn fetch_with_progress(
        &mut self,
        token: &CancelToken,
        progress: Progress<'_>,
    ) -> Result<()> {
        let result = self.run_git_with_progress(
            &["fetch", "--all", "--prune", "--progress"],
            token,
            progress,
        );
        self.refresh();
        result.map(|_| ())
    }

    /// `git pull` on the current branch, honouring the user's `pull.rebase` setting.
    pub fn pull(&mut self) -> Result<()> {
        self.pull_with_progress(&CancelToken::new(), &mut |_| {})
    }

    pub fn pull_with_progress(
        &mut self,
        token: &CancelToken,
        progress: Progress<'_>,
    ) -> Result<()> {
        let result = self.run_git_with_progress(&["pull", "--progress"], token, progress);
        self.refresh();
        result.map(|_| ())
    }

    /// Pushes the current branch, setting its upstream on the first push.
    pub fn push(&mut self) -> Result<()> {
        self.push_with_progress(&CancelToken::new(), &mut |_| {})
    }

    pub fn push_with_progress(
        &mut self,
        token: &CancelToken,
        progress: Progress<'_>,
    ) -> Result<()> {
        // Scoped so the references are dropped before `refresh` borrows `self` mutably.
        let (name, has_upstream) = {
            let head = self.git.head()?;
            if !head.is_branch() {
                return Err(Error::DetachedHead);
            }
            let name = lossy(head.shorthand_bytes());
            let has_upstream = self
                .git
                .find_branch(&name, BranchType::Local)?
                .upstream()
                .is_ok();
            (name, has_upstream)
        };
        let result = if has_upstream {
            self.run_git_with_progress(&["push", "--progress"], token, progress)
        } else {
            let remote = self.default_remote()?;
            self.run_git_with_progress(
                &["push", "--progress", "--set-upstream", &remote, &name],
                token,
                progress,
            )
        };
        self.refresh();
        result.map(|_| ())
    }

    fn run_git_with_progress(
        &self,
        args: &[&str],
        token: &CancelToken,
        progress: Progress<'_>,
    ) -> Result<exec::GitOutput> {
        exec::git_with_progress(self.workdir()?, &self.git_env, args, token, progress)
    }

    /// `origin` when it exists, otherwise the only remote.
    pub(crate) fn default_remote(&self) -> Result<String> {
        let names = self.remote_names()?;
        if names.iter().any(|name| name == "origin") {
            return Ok("origin".to_owned());
        }
        match names.as_slice() {
            [only] => Ok(only.clone()),
            _ => Err(Error::NoRemote),
        }
    }

    pub(crate) fn run_git(&self, args: &[&str], stdin: Option<&str>) -> Result<exec::GitOutput> {
        exec::git(self.workdir()?, &self.git_env, args, stdin)
    }

    /// Absolute path of a file of the working tree.
    pub fn full_path(&self, relative: &str) -> Result<PathBuf> {
        Ok(self.workdir()?.join(relative))
    }
}
