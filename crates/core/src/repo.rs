use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};

use git2::{BranchType, ErrorCode, Repository};
use serde::{Deserialize, Serialize};

use crate::{
    CommitDetails, Error, FileContents, FileDiff, GraphRow, RefInfo, RefKind, RepoState, Result,
    WorkingTreeStatus, commit, contents, diff,
    exec::{self, CancelToken},
    graph::Graph,
    lossy, ops, refs, status,
};

/// Receives the lines `git` prints while a network operation runs.
pub type Progress<'a> = &'a mut dyn FnMut(&str);

/// How `git pull` joins the commits of the remote branch with local ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// A merge commit, or a fast-forward when there is nothing local.
    Merge,
    /// The local commits replayed on top of the remote ones.
    Rebase,
}

/// What `HEAD` points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
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
    /// The remote-tracking branch `branch` is set to follow, when it no longer
    /// exists: deleted on the remote, then pruned by a fetch. `upstream` is then
    /// `None`.
    pub gone_upstream: Option<String>,
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
#[serde(rename_all = "camelCase")]
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
    /// The branch to fall back on, such as `main`: the one `origin/HEAD` names,
    /// otherwise `main` or `master` when it exists. It may exist only on the
    /// remote, and checking it out then creates it.
    pub default_branch: Option<String>,
    /// When the remotes were last fetched (`FETCH_HEAD`), in seconds since the
    /// Unix epoch; `None` when they never were.
    pub last_fetch: Option<i64>,
}

/// The tree of a commit without files: what the first commit is compared to.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// How many commit subjects [`Repo::staged_changes`] reads from the history.
const RECENT_SUBJECTS: usize = 15;

/// The changes a commit would record, see [`Repo::staged_changes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedChanges {
    /// `git diff --name-status`: one `status<TAB>path` line per file.
    pub files: String,
    /// The patch of those files, renames detected.
    pub patch: String,
    /// Subjects of the latest commits reachable from `HEAD`, newest first.
    pub recent_subjects: Vec<String>,
}

/// A `git` command that talks to a remote, prepared by a [`Repo`].
///
/// It owns what it needs instead of borrowing the repository, so the caller can
/// release the repository while `git` is on the network, then call
/// [`Repo::refresh`] once it is done.
pub struct RemoteCommand {
    workdir: PathBuf,
    env: Vec<(OsString, OsString)>,
    args: Vec<String>,
}

impl RemoteCommand {
    /// What is added to the environment `git` inherits, for the caller to extend
    /// (see [`crate::add_config`]).
    pub fn env_mut(&mut self) -> &mut Vec<(OsString, OsString)> {
        &mut self.env
    }

    /// Runs the command, reporting the lines `git` prints; `token` stops it.
    pub fn run(&self, token: &CancelToken, progress: Progress<'_>) -> Result<()> {
        let args: Vec<&str> = self.args.iter().map(String::as_str).collect();
        exec::git_with_progress(&self.workdir, &self.env, &args, token, progress).map(|_| ())
    }

    /// Runs the command silently, giving up with [`Error::Cancelled`] after `timeout`.
    pub fn run_within(&self, timeout: Duration) -> Result<()> {
        let token = CancelToken::new();
        let (finished, wait) = mpsc::channel::<()>();
        let watchdog = {
            let token = token.clone();
            thread::spawn(move || {
                // Dropping `finished` wakes this up before the deadline.
                if wait.recv_timeout(timeout) == Err(RecvTimeoutError::Timeout) {
                    token.cancel();
                }
            })
        };
        let result = self.run(&token, &mut |_| {});
        drop(finished);
        let _ = watchdog.join();
        result
    }
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
        let existed = destination.exists();
        let cloned = exec::git_with_progress(
            parent,
            &git_env,
            &["clone", "--progress", "--", url, &name],
            token,
            progress,
        );
        if matches!(cloned, Err(Error::Cancelled)) && !existed {
            // Killed, `git` could not remove the directory it had started to fill,
            // and the next attempt would find it in its way.
            let _ = std::fs::remove_dir_all(destination);
        }
        cloned?;
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
            default_branch: self.default_branch()?,
            last_fetch: self.last_fetch(),
        })
    }

    fn head(&self) -> Result<HeadInfo> {
        let mut info = HeadInfo {
            branch: None,
            target: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            gone_upstream: None,
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
        let upstream = match local.upstream() {
            Ok(upstream) => upstream,
            Err(error) if error.code() == ErrorCode::NotFound => {
                // Configured (`branch.<name>.merge`) but the reference is missing.
                let refname = format!("refs/heads/{branch}");
                if let Ok(name) = self.git.branch_upstream_name(&refname) {
                    let name = lossy(&name);
                    if self.git.find_reference(&name).is_err() {
                        info.gone_upstream = Some(short_ref_name(&name));
                    }
                }
                return Ok(());
            }
            Err(_) => return Ok(()),
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

    /// See [`RepoInfo::default_branch`].
    fn default_branch(&self) -> Result<Option<String>> {
        let remote = self.default_remote().ok();
        if let Some(remote) = &remote {
            // `origin/HEAD`, written by `git clone` or `git remote set-head`.
            if let Ok(head) = self
                .git
                .find_reference(&format!("refs/remotes/{remote}/HEAD"))
                && let Some(target) = head.symbolic_target_bytes()
            {
                let target = lossy(target);
                if let Some(name) = target.strip_prefix(&format!("refs/remotes/{remote}/"))
                    && self.git.find_reference(&target).is_ok()
                {
                    return Ok(Some(name.to_owned()));
                }
            }
        }
        for name in ["main", "master"] {
            let local = self.git.find_branch(name, BranchType::Local).is_ok();
            let remote = remote.as_ref().is_some_and(|remote| {
                self.git
                    .find_branch(&format!("{remote}/{name}"), BranchType::Remote)
                    .is_ok()
            });
            if local || remote {
                return Ok(Some(name.to_owned()));
            }
        }
        Ok(None)
    }

    /// See [`RepoInfo::last_fetch`].
    fn last_fetch(&self) -> Option<i64> {
        let modified = std::fs::metadata(self.git.path().join("FETCH_HEAD"))
            .and_then(|metadata| metadata.modified())
            .ok()?;
        let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
        i64::try_from(since_epoch.as_secs()).ok()
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

    /// What a commit made now would contain, as text: the input of a commit
    /// message assistant. With `amend`, what the amended commit would contain.
    pub fn staged_changes(&self, amend: bool) -> Result<StagedChanges> {
        // An amended commit holds everything its parent lacks, staged or not yet.
        let base = if amend {
            let head = self.git.head()?.peel_to_commit()?;
            Some(match head.parent_id(0) {
                Ok(parent) => parent.to_string(),
                Err(_) => EMPTY_TREE.to_owned(),
            })
        } else {
            None
        };
        let diff = |format: &str| {
            // `quotepath` would escape accented paths; `--no-ext-diff` and
            // `--no-textconv` keep the user's diff tools out of the output.
            let mut args = vec![
                "-c",
                "core.quotepath=off",
                "diff",
                "--cached",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "-M",
                format,
            ];
            if let Some(base) = &base {
                args.push(base);
            }
            args.push("--");
            self.run_git(&args, None).map(|output| output.stdout)
        };
        let files = diff("--name-status")?;
        let patch = diff("--patch")?;

        let mut recent_subjects = Vec::new();
        // A repository without commits has no history to read, which is fine.
        if let Ok(mut walk) = self.git.revwalk()
            && walk.push_head().is_ok()
        {
            for id in walk.take(RECENT_SUBJECTS).flatten() {
                if let Ok(commit) = self.git.find_commit(id) {
                    recent_subjects.push(lossy(commit.summary_bytes().unwrap_or_default()));
                }
            }
        }
        Ok(StagedChanges {
            files,
            patch,
            recent_subjects,
        })
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

    /// Adds remote `name` at `url`, as `git remote add` does: fetching then brings
    /// its branches, and pushing creates them there. Nothing goes over the
    /// network. `git` refuses a name already taken or that it cannot accept.
    pub fn add_remote(&mut self, name: &str, url: &str) -> Result<()> {
        let (name, url) = (name.trim(), url.trim());
        if name.is_empty() || url.is_empty() {
            return Err(Error::IncompleteRemote);
        }
        // `--` keeps a name or URL starting with a dash from being read as an option.
        self.run_git(&["remote", "add", "--", name, url], None)?;
        self.refresh();
        Ok(())
    }

    /// Points remote `name` at `url`, as `git remote set-url` does, for fetching
    /// and pushing alike. Nothing goes over the network.
    pub fn set_remote_url(&mut self, name: &str, url: &str) -> Result<()> {
        let (name, url) = (name.trim(), url.trim());
        if name.is_empty() || url.is_empty() {
            return Err(Error::IncompleteRemote);
        }
        if self.remote_url(name)?.is_none() {
            return Err(Error::UnknownRemote {
                name: name.to_owned(),
            });
        }
        self.run_git(&["remote", "set-url", "--", name, url], None)?;
        Ok(())
    }

    /// The value of configuration variable `name`, wherever it is set: this
    /// repository, the user's configuration or the system's.
    pub fn config_value(&self, name: &str) -> Result<Option<String>> {
        match self.git.config()?.get_string(name) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Sets `name` in the configuration of this repository alone; `None` removes it.
    pub fn set_config_value(&self, name: &str, value: Option<&str>) -> Result<()> {
        let result = match value {
            Some(value) => self.run_git(&["config", "--local", name, value], None),
            None => self.run_git(&["config", "--local", "--unset-all", name], None),
        };
        match result {
            Ok(_) => Ok(()),
            // `git config --unset-all` on a variable that is not set.
            Err(Error::Command { code: Some(5), .. }) if value.is_none() => Ok(()),
            Err(error) => Err(error),
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
        let result = self.fetch_command()?.run(token, progress);
        self.refresh();
        result
    }

    pub fn fetch_command(&self) -> Result<RemoteCommand> {
        self.remote_command(&["fetch", "--all", "--prune", "--progress"])
    }

    /// `git pull` on the current branch. Without `mode` it follows the user's
    /// configuration, and refuses with [`Error::DivergentBranches`] when that
    /// configuration does not say how to join diverged branches.
    pub fn pull(&mut self, mode: Option<PullMode>) -> Result<()> {
        self.pull_with_progress(mode, &CancelToken::new(), &mut |_| {})
    }

    pub fn pull_with_progress(
        &mut self,
        mode: Option<PullMode>,
        token: &CancelToken,
        progress: Progress<'_>,
    ) -> Result<()> {
        if mode.is_none() {
            self.check_pull()?;
        }
        let result = self.pull_command(mode)?.run(token, progress);
        self.refresh();
        match result {
            // The fetch done by `git pull` may have revealed the divergence.
            Err(error) if mode.is_none() => self.check_pull().and(Err(error)),
            result => result,
        }
    }

    pub fn pull_command(&self, mode: Option<PullMode>) -> Result<RemoteCommand> {
        let mut args = vec!["pull", "--progress"];
        match mode {
            None => {}
            // `--ff` also overrides a `pull.ff=only` setting.
            Some(PullMode::Merge) => args.extend(["--no-rebase", "--ff"]),
            // Git refuses to rebase over local changes; set them aside meanwhile.
            Some(PullMode::Rebase) => args.extend(["--rebase", "--autostash"]),
        }
        self.remote_command(&args)
    }

    /// Fails with [`Error::DivergentBranches`] when a `git pull` following the
    /// user's configuration would refuse: the branch and its upstream both have
    /// commits of their own, and nothing says whether to merge or rebase.
    pub fn check_pull(&self) -> Result<()> {
        let head = self.head()?;
        if let (Some(branch), Some(upstream)) = (head.branch, head.upstream)
            && head.ahead > 0
            && head.behind > 0
            && !self.pull_configured(&branch)?
        {
            return Err(Error::DivergentBranches { branch, upstream });
        }
        Ok(())
    }

    /// Whether the configuration tells `git pull` how to join diverged branches,
    /// as Git decides it: `branch.<name>.rebase` or `pull.rebase` set to rebase,
    /// otherwise either of them or `pull.ff` set, unless `pull.ff` is `only`.
    fn pull_configured(&self, branch: &str) -> Result<bool> {
        let rebase = match self.git_config(&format!("branch.{branch}.rebase"))? {
            Some(value) => Some(value),
            None => self.git_config("pull.rebase")?,
        };
        let ff = self.git_config("pull.ff")?;
        if rebase.as_deref().is_some_and(|value| !is_false(value)) {
            return Ok(true);
        }
        if ff
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("only"))
        {
            return Ok(false);
        }
        Ok(rebase.is_some() || ff.is_some())
    }

    /// `name` as the `git` binary reads it, which is what `git pull` acts on.
    /// libgit2 may read other files: it ignores `GIT_CONFIG_NOSYSTEM`, and the
    /// system configuration of Git for Windows sets `pull.rebase`.
    fn git_config(&self, name: &str) -> Result<Option<String>> {
        match self.run_git(&["config", "--get", name], None) {
            Ok(output) => Ok(Some(output.stdout.trim_end().to_owned())),
            // `git config --get` on a variable that is not set.
            Err(Error::Command { code: Some(1), .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Makes `mode` what `git pull` does in this repository from now on.
    pub fn remember_pull_mode(&self, mode: PullMode) -> Result<()> {
        let rebase = mode == PullMode::Rebase;
        self.set_config_value("pull.rebase", Some(if rebase { "true" } else { "false" }))?;
        // `pull.ff=only`, from the user's configuration, would still refuse to merge.
        let ff_only = self
            .git_config("pull.ff")?
            .is_some_and(|value| value.eq_ignore_ascii_case("only"));
        if !rebase && ff_only {
            self.set_config_value("pull.ff", Some("true"))?;
        }
        Ok(())
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
        let result = self.push_command()?.run(token, progress);
        self.refresh();
        result
    }

    pub fn push_command(&self) -> Result<RemoteCommand> {
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
        if has_upstream {
            self.remote_command(&["push", "--progress"])
        } else {
            let remote = self.default_remote()?;
            self.remote_command(&["push", "--progress", "--set-upstream", &remote, &name])
        }
    }

    /// Prepares the fetch the application runs on its own to keep the remote
    /// branches current.
    pub fn background_fetch(&self) -> Result<RemoteCommand> {
        let mut command = self.remote_command(&["fetch", "--all", "--prune", "--quiet"])?;
        // The user is doing something else: Git Credential Manager must fail
        // rather than open its sign-in window.
        command.env.push(("GCM_INTERACTIVE".into(), "never".into()));
        Ok(command)
    }

    pub(crate) fn remote_command(&self, args: &[&str]) -> Result<RemoteCommand> {
        Ok(RemoteCommand {
            workdir: self.workdir()?.to_owned(),
            env: self.git_env.clone(),
            args: args.iter().map(|&arg| arg.to_owned()).collect(),
        })
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

/// `refs/remotes/origin/main` → `origin/main`, `refs/heads/main` → `main`.
fn short_ref_name(name: &str) -> String {
    name.strip_prefix("refs/remotes/")
        .or_else(|| name.strip_prefix("refs/heads/"))
        .unwrap_or(name)
        .to_owned()
}

/// Whether Git reads `value` as false.
fn is_false(value: &str) -> bool {
    ["false", "no", "off", "0", ""]
        .iter()
        .any(|word| value.eq_ignore_ascii_case(word))
}
