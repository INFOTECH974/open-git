//! Working tree operations: status, staging, diffs of uncommitted changes, commit,
//! checkout, and synchronisation with a bare remote on disk.
//!
//! Commit, checkout and the remote operations spawn the real `git` binary, kept
//! away from the user's configuration through environment variables.

use std::{ffi::OsString, fs, path::Path, process::Command, time::Duration};

use git2::{IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature, Time};
use gitui_core::{
    ConflictSide, DiffLineKind, Error, FileStatus, RefKind, Repo, RepoState, StatusEntry,
};
use tempfile::TempDir;

const T0: i64 = 1_700_000_000;

struct Fixture {
    dir: TempDir,
    initial: Oid,
}

impl Fixture {
    /// A repository with one commit holding `README.md` and `lib.rs`, checked out on `main`.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let git = init(dir.path());
        write(dir.path(), "README.md", "hello\n");
        write(dir.path(), "lib.rs", "fn a() {}\n");
        let initial = commit_all(&git, 0, "Initial commit\n");
        Self { dir, initial }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn git(&self) -> Repository {
        Repository::open(self.path()).unwrap()
    }

    fn repo(&self) -> Repo {
        let mut repo = Repo::open(self.path()).unwrap();
        repo.set_git_env(git_env(self.path()));
        repo
    }

    fn write(&self, path: &str, content: &str) {
        write(self.path(), path, content);
    }

    fn remove(&self, path: &str) {
        fs::remove_file(self.path().join(path)).unwrap();
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.path().join(path)).unwrap()
    }
}

fn init(path: &Path) -> Repository {
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(path, &options).unwrap();
    // libgit2 reads the user's global configuration while the `git` binary is kept
    // away from it in these tests; pin the line ending behaviour so both agree.
    repo.config()
        .unwrap()
        .set_bool("core.autocrlf", false)
        .unwrap();
    repo
}

fn write(root: &Path, path: &str, content: &str) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, content).unwrap();
}

fn signature(step: i64) -> Signature<'static> {
    Signature::new(
        "Ada Lovelace",
        "ada@example.com",
        &Time::new(T0 + step * 60, 0),
    )
    .unwrap()
}

/// Stages everything and commits on the current branch, like `git add -A && git commit`.
fn commit_all(git: &Repository, step: i64, message: &str) -> Oid {
    let mut index = git.index().unwrap();
    index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
    index.update_all(["*"], None).unwrap();
    index.write().unwrap();
    let tree = git.find_tree(index.write_tree().unwrap()).unwrap();
    let parent = git.head().ok().and_then(|head| head.peel_to_commit().ok());
    let parents: Vec<_> = parent.iter().collect();
    let signature = signature(step);
    git.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .unwrap()
}

/// Environment that isolates `git` from the user's global and system configuration
/// and gives it an identity.
fn git_env(scratch: &Path) -> Vec<(OsString, OsString)> {
    [
        ("GIT_CONFIG_NOSYSTEM", "1".to_owned()),
        (
            "GIT_CONFIG_GLOBAL",
            scratch
                .join("no-global-gitconfig")
                .to_string_lossy()
                .into_owned(),
        ),
        ("GIT_AUTHOR_NAME", "Ada Lovelace".to_owned()),
        ("GIT_AUTHOR_EMAIL", "ada@example.com".to_owned()),
        ("GIT_COMMITTER_NAME", "Ada Lovelace".to_owned()),
        ("GIT_COMMITTER_EMAIL", "ada@example.com".to_owned()),
    ]
    .into_iter()
    .map(|(key, value)| (OsString::from(key), OsString::from(value)))
    .collect()
}

/// Runs `git` directly, for the parts of a scenario that are not under test.
fn run_git(cwd: &Path, env: &[(OsString, OsString)], args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .envs(env.iter().map(|(key, value)| (key, value)))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn paths(entries: &[StatusEntry]) -> Vec<(&str, FileStatus)> {
    entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.status))
        .collect()
}

#[test]
fn clean_repository_has_an_empty_status() {
    let fixture = Fixture::new();
    let status = fixture.repo().status().unwrap();
    assert!(status.is_clean(), "{status:?}");
}

#[test]
fn status_separates_staged_from_unstaged_changes() {
    let fixture = Fixture::new();
    fixture.write("README.md", "hello\nworld\n");
    fixture.write("docs/new.txt", "new\n");
    fixture.remove("lib.rs");

    let repo = fixture.repo();
    let status = repo.status().unwrap();
    assert!(status.staged.is_empty());
    assert_eq!(
        paths(&status.unstaged),
        [
            ("README.md", FileStatus::Modified),
            ("docs/new.txt", FileStatus::Added),
            ("lib.rs", FileStatus::Deleted),
        ]
    );
    assert!(status.conflicted.is_empty());

    repo.stage(&["docs/new.txt".into()]).unwrap();
    let status = repo.status().unwrap();
    assert_eq!(paths(&status.staged), [("docs/new.txt", FileStatus::Added)]);
    assert_eq!(
        paths(&status.unstaged),
        [
            ("README.md", FileStatus::Modified),
            ("lib.rs", FileStatus::Deleted),
        ]
    );
}

#[test]
fn stage_and_unstage_move_files_between_the_lists() {
    let fixture = Fixture::new();
    fixture.write("README.md", "hello\nworld\n");
    fixture.remove("lib.rs");
    let repo = fixture.repo();

    // Staging a deleted path records the deletion.
    repo.stage(&["README.md".into(), "lib.rs".into()]).unwrap();
    let status = repo.status().unwrap();
    assert_eq!(
        paths(&status.staged),
        [
            ("README.md", FileStatus::Modified),
            ("lib.rs", FileStatus::Deleted),
        ]
    );
    assert!(status.unstaged.is_empty());

    repo.unstage(&["lib.rs".into()]).unwrap();
    let status = repo.status().unwrap();
    assert_eq!(paths(&status.staged), [("README.md", FileStatus::Modified)]);
    assert_eq!(paths(&status.unstaged), [("lib.rs", FileStatus::Deleted)]);

    repo.unstage_all().unwrap();
    assert!(repo.status().unwrap().staged.is_empty());

    fixture.write("extra.txt", "x\n");
    repo.stage_all().unwrap();
    let status = repo.status().unwrap();
    assert_eq!(
        paths(&status.staged),
        [
            ("README.md", FileStatus::Modified),
            ("extra.txt", FileStatus::Added),
            ("lib.rs", FileStatus::Deleted),
        ]
    );
    assert!(status.unstaged.is_empty());
}

#[test]
fn staged_renames_are_detected() {
    let fixture = Fixture::new();
    fixture.remove("lib.rs");
    fixture.write("core.rs", "fn a() {}\n");
    let repo = fixture.repo();

    repo.stage(&["lib.rs".into(), "core.rs".into()]).unwrap();
    let status = repo.status().unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "core.rs");
    assert_eq!(status.staged[0].old_path.as_deref(), Some("lib.rs"));
    assert_eq!(status.staged[0].status, FileStatus::Renamed);

    let diff = repo
        .workdir_file_diff("core.rs", Some("lib.rs"), true)
        .unwrap();
    assert_eq!(diff.status, FileStatus::Renamed);
    assert_eq!(diff.old_path.as_deref(), Some("lib.rs"));
    assert!(diff.hunks.is_empty());
}

#[test]
fn workdir_diff_follows_the_file_from_working_tree_to_index() {
    let fixture = Fixture::new();
    fixture.write("README.md", "hello\nworld\n");
    fixture.write("new.txt", "fresh\n");
    let repo = fixture.repo();

    let unstaged = repo.workdir_file_diff("README.md", None, false).unwrap();
    assert_eq!(unstaged.status, FileStatus::Modified);
    let lines: Vec<_> = unstaged.hunks[0]
        .lines
        .iter()
        .map(|line| (line.kind, line.content.as_str()))
        .collect();
    assert_eq!(
        lines,
        [
            (DiffLineKind::Context, "hello"),
            (DiffLineKind::Addition, "world"),
        ]
    );
    assert!(matches!(
        repo.workdir_file_diff("README.md", None, true),
        Err(Error::PathNotChanged { .. })
    ));

    // Untracked files show their whole content.
    let untracked = repo.workdir_file_diff("new.txt", None, false).unwrap();
    assert_eq!(untracked.status, FileStatus::Added);
    assert_eq!(untracked.hunks[0].lines[0].content, "fresh");

    repo.stage(&["README.md".into()]).unwrap();
    let staged = repo.workdir_file_diff("README.md", None, true).unwrap();
    assert_eq!(staged.hunks[0].lines[1].content, "world");
    assert!(matches!(
        repo.workdir_file_diff("README.md", None, false),
        Err(Error::PathNotChanged { .. })
    ));
}

#[test]
fn commit_runs_git_and_refreshes_the_history() {
    let fixture = Fixture::new();
    fixture.write("new.txt", "fresh\n");
    let mut repo = fixture.repo();
    assert_eq!(repo.commit_count().unwrap(), 1);

    assert!(matches!(
        repo.commit("  \n", false),
        Err(Error::EmptyMessage)
    ));
    assert!(
        matches!(
            repo.commit("Nothing staged\n", false),
            Err(Error::Command { .. })
        ),
        "git refuses to commit an unchanged index"
    );

    repo.stage(&["new.txt".into()]).unwrap();
    let id = repo
        .commit("Add new file\n\nWith a body.\n", false)
        .unwrap();

    let info = repo.info().unwrap();
    assert_eq!(info.head.target.as_deref(), Some(id.as_str()));
    let details = repo.commit_details(&id).unwrap();
    assert_eq!(details.summary, "Add new file");
    assert_eq!(details.body, "With a body.");
    assert_eq!(details.author.name, "Ada Lovelace");
    assert_eq!(details.parents, [fixture.initial.to_string()]);
    assert!(repo.status().unwrap().is_clean());
    assert_eq!(repo.commit_count().unwrap(), 2);
}

#[test]
fn checkout_switches_branches_tracks_remote_branches_and_detaches_on_tags() {
    let fixture = Fixture::new();
    let git = fixture.git();
    let initial = git.find_commit(fixture.initial).unwrap();
    git.branch("feature", &initial, false).unwrap();
    git.tag_lightweight("v1", initial.as_object(), false)
        .unwrap();
    fixture.write("README.md", "hello\nworld\n");
    commit_all(&git, 1, "Second\n");
    git.remote("origin", "https://example.com/repo.git")
        .unwrap();
    git.reference("refs/remotes/origin/topic", fixture.initial, false, "")
        .unwrap();

    let mut repo = fixture.repo();
    assert_eq!(fixture.read("README.md"), "hello\nworld\n");

    repo.checkout("feature", RefKind::LocalBranch).unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!(head.branch.as_deref(), Some("feature"));
    assert_eq!(
        head.target.as_deref(),
        Some(fixture.initial.to_string().as_str())
    );
    assert_eq!(
        fixture.read("README.md"),
        "hello\n",
        "the working tree follows"
    );

    repo.checkout("origin/topic", RefKind::RemoteBranch)
        .unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!(head.branch.as_deref(), Some("topic"));
    assert_eq!(head.upstream.as_deref(), Some("origin/topic"));

    // Checking out the remote branch again reuses the local branch.
    repo.checkout("main", RefKind::LocalBranch).unwrap();
    repo.checkout("origin/topic", RefKind::RemoteBranch)
        .unwrap();
    assert_eq!(repo.info().unwrap().head.branch.as_deref(), Some("topic"));

    repo.checkout("v1", RefKind::Tag).unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!(head.branch, None);
    assert_eq!(
        head.target.as_deref(),
        Some(fixture.initial.to_string().as_str())
    );

    assert!(matches!(
        repo.checkout("nope", RefKind::LocalBranch),
        Err(Error::Command { .. })
    ));
    assert!(matches!(
        repo.checkout("elsewhere/topic", RefKind::RemoteBranch),
        Err(Error::UnknownRemote { .. })
    ));
}

#[test]
fn push_fetch_and_pull_against_a_bare_remote() {
    let fixture = Fixture::new();
    let env = git_env(fixture.path());
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = Repository::init_bare(remote_dir.path()).unwrap();
    // Clones check out the remote's HEAD, which libgit2 points at `master` by default.
    remote.set_head("refs/heads/main").unwrap();
    let remote_url = remote_dir.path().to_string_lossy().replace('\\', "/");

    let mut repo = fixture.repo();
    assert!(matches!(repo.push(), Err(Error::NoRemote)));

    fixture.git().remote("origin", &remote_url).unwrap();
    repo.push().unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!(head.upstream.as_deref(), Some("origin/main"));
    assert_eq!((head.ahead, head.behind), (0, 0));
    assert_eq!(
        remote.find_reference("refs/heads/main").unwrap().target(),
        Some(fixture.initial)
    );

    // Someone else pushes a commit from another clone.
    let other_dir = tempfile::tempdir().unwrap();
    let other = other_dir.path().join("clone");
    run_git(other_dir.path(), &env, &["clone", &remote_url, "clone"]);
    write(&other, "other.txt", "from the other clone\n");
    run_git(&other, &env, &["add", "other.txt"]);
    run_git(&other, &env, &["commit", "-m", "From the other clone"]);
    run_git(&other, &env, &["push"]);

    repo.fetch().unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!((head.ahead, head.behind), (0, 1));
    assert_eq!(
        repo.commit_count().unwrap(),
        2,
        "the fetched commit is in the graph"
    );

    repo.pull().unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!((head.ahead, head.behind), (0, 0));
    assert_eq!(fixture.read("other.txt"), "from the other clone\n");

    fixture.write("mine.txt", "from here\n");
    repo.stage_all().unwrap();
    let id = repo.commit("From here\n", false).unwrap();
    assert_eq!(repo.info().unwrap().head.ahead, 1);
    repo.push().unwrap();
    assert_eq!(repo.info().unwrap().head.ahead, 0);
    assert_eq!(
        remote.find_reference("refs/heads/main").unwrap().target(),
        Some(Oid::from_str(&id).unwrap())
    );

    fixture.git().set_head_detached(fixture.initial).unwrap();
    assert!(matches!(repo.push(), Err(Error::DetachedHead)));
}

#[test]
fn background_fetch_follows_a_branch_moved_on_the_remote() {
    let fixture = Fixture::new();
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = Repository::init_bare(remote_dir.path()).unwrap();
    remote.set_head("refs/heads/main").unwrap();
    let remote_url = remote_dir.path().to_string_lossy().replace('\\', "/");
    fixture.git().remote("origin", &remote_url).unwrap();
    let mut repo = fixture.repo();
    repo.push().unwrap();

    // The remote promotes `main` to `production` by itself, as a deployment job does.
    remote
        .reference("refs/heads/production", fixture.initial, false, "promote")
        .unwrap();
    let before = repo.refs().unwrap();
    assert!(!before.iter().any(|r| r.name == "origin/production"));

    // The fetch does not borrow the repository, which stays readable meanwhile.
    let fetch = repo.background_fetch().unwrap();
    fetch.run_within(Duration::from_secs(60)).unwrap();
    let after = repo.refs().unwrap();
    assert!(
        after.iter().any(|r| r.name == "origin/production"
            && r.kind == RefKind::RemoteBranch
            && r.target == fixture.initial.to_string()),
        "{after:?}"
    );

    // Nothing moved since: the references compare equal, so the UI is left alone.
    fetch.run_within(Duration::from_secs(60)).unwrap();
    assert_eq!(repo.refs().unwrap(), after);

    // A branch deleted on the remote is pruned.
    remote
        .find_reference("refs/heads/production")
        .unwrap()
        .delete()
        .unwrap();
    fetch.run_within(Duration::from_secs(60)).unwrap();
    assert_eq!(repo.refs().unwrap(), before);

    // A fetch that outlives its deadline is stopped.
    assert!(matches!(
        fetch.run_within(Duration::ZERO),
        Err(Error::Cancelled)
    ));
}

#[test]
fn add_to_gitignore_creates_the_file_and_hides_untracked_files() {
    let fixture = Fixture::new();
    fixture.write("secret.env", "x\n");
    let repo = fixture.repo();
    assert_eq!(
        paths(&repo.status().unwrap().unstaged),
        [("secret.env", FileStatus::Added)]
    );

    repo.add_to_gitignore(&["/secret.env".into()]).unwrap();
    assert_eq!(fixture.read(".gitignore"), "/secret.env\n");
    assert_eq!(
        paths(&repo.status().unwrap().unstaged),
        [(".gitignore", FileStatus::Added)]
    );
}

#[test]
fn add_to_gitignore_keeps_existing_lines_endings_and_skips_duplicates() {
    let fixture = Fixture::new();
    fixture.write("docs/new.txt", "new\n");
    fixture.write("build/out.bin", "bin");
    // Windows line endings and no newline at the end.
    fixture.write(".gitignore", "target\r\n*.log");
    let repo = fixture.repo();

    repo.add_to_gitignore(&[
        "/docs/new.txt".into(),
        "*.bin".into(),
        "*.log".into(),
        "  ".into(),
    ])
    .unwrap();
    assert_eq!(
        fixture.read(".gitignore"),
        "target\r\n*.log\r\n/docs/new.txt\r\n*.bin\r\n"
    );
    assert_eq!(
        paths(&repo.status().unwrap().unstaged),
        [(".gitignore", FileStatus::Added)]
    );

    repo.add_to_gitignore(&["*.bin".into(), "*.bin".into()])
        .unwrap();
    assert_eq!(
        fixture.read(".gitignore"),
        "target\r\n*.log\r\n/docs/new.txt\r\n*.bin\r\n"
    );
}

#[test]
fn amend_replaces_the_last_commit() {
    let fixture = Fixture::new();
    fixture.write("new.txt", "fresh\n");
    let mut repo = fixture.repo();
    repo.stage_all().unwrap();
    let first = repo.commit("Add new\n", false).unwrap();

    fixture.write("new.txt", "fresher\n");
    repo.stage_all().unwrap();
    let amended = repo.commit("Add new, amended\n", true).unwrap();

    assert_ne!(first, amended);
    assert_eq!(repo.commit_count().unwrap(), 2);
    let details = repo.commit_details(&amended).unwrap();
    assert_eq!(details.summary, "Add new, amended");
    assert_eq!(details.parents, [fixture.initial.to_string()]);
}

#[test]
fn branches_and_tags_can_be_created_renamed_and_deleted() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();
    let initial = fixture.initial.to_string();

    repo.create_branch("topic", &initial, true).unwrap();
    assert_eq!(repo.info().unwrap().head.branch.as_deref(), Some("topic"));
    repo.create_branch("other", "main", false).unwrap();
    assert_eq!(repo.info().unwrap().head.branch.as_deref(), Some("topic"));
    repo.rename_branch("other", "renamed").unwrap();
    let branches = |repo: &Repo| -> Vec<String> {
        repo.refs()
            .unwrap()
            .into_iter()
            .filter(|reference| reference.kind == RefKind::LocalBranch)
            .map(|reference| reference.name)
            .collect()
    };
    assert_eq!(branches(&repo), ["main", "renamed", "topic"]);

    repo.checkout("main", RefKind::LocalBranch).unwrap();
    repo.delete_branch("renamed", false).unwrap();
    repo.delete_branch("topic", false).unwrap();
    assert_eq!(branches(&repo), ["main"]);
    assert!(matches!(
        repo.delete_branch("topic", false),
        Err(Error::Command { .. })
    ));

    let tags = |repo: &Repo| -> Vec<String> {
        repo.refs()
            .unwrap()
            .into_iter()
            .filter(|reference| reference.kind == RefKind::Tag)
            .map(|reference| reference.name)
            .collect()
    };
    repo.create_tag("v1", &initial, None).unwrap();
    repo.create_tag("v2", "main", Some("Second release\n"))
        .unwrap();
    assert_eq!(tags(&repo), ["v1", "v2"]);
    repo.delete_tag("v1").unwrap();
    assert_eq!(tags(&repo), ["v2"]);

    repo.checkout_commit(&initial).unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!(head.branch, None);
    assert_eq!(head.target.as_deref(), Some(initial.as_str()));
}

#[test]
fn merge_fast_forwards_or_stops_on_conflicts_until_aborted_or_continued() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();
    let initial = fixture.initial.to_string();

    // A branch with its own commit merges cleanly.
    repo.create_branch("feature", &initial, true).unwrap();
    fixture.write("feature.txt", "feature\n");
    repo.stage_all().unwrap();
    repo.commit("Feature\n", false).unwrap();
    repo.checkout("main", RefKind::LocalBranch).unwrap();
    repo.merge("feature").unwrap();
    assert_eq!(fixture.read("feature.txt"), "feature\n");
    assert_eq!(repo.info().unwrap().state, RepoState::Clean);
    assert_eq!(repo.commit_count().unwrap(), 2);

    // Conflicting edits of README.md on both sides.
    repo.create_branch("conflict", "main", true).unwrap();
    fixture.write("README.md", "theirs\n");
    repo.stage_all().unwrap();
    repo.commit("Theirs\n", false).unwrap();
    repo.checkout("main", RefKind::LocalBranch).unwrap();
    fixture.write("README.md", "ours\n");
    repo.stage_all().unwrap();
    repo.commit("Ours\n", false).unwrap();

    assert!(matches!(repo.merge("conflict"), Err(Error::Command { .. })));
    assert_eq!(repo.info().unwrap().state, RepoState::Merge);
    assert_eq!(repo.status().unwrap().conflicted, ["README.md"]);

    repo.abort_operation().unwrap();
    assert_eq!(repo.info().unwrap().state, RepoState::Clean);
    assert_eq!(fixture.read("README.md"), "ours\n");
    assert!(matches!(repo.abort_operation(), Err(Error::NoOperation)));

    // Keeping their side resolves the conflict; continuing creates the merge commit.
    assert!(matches!(repo.merge("conflict"), Err(Error::Command { .. })));
    repo.resolve_conflict("README.md", ConflictSide::Theirs)
        .unwrap();
    assert_eq!(fixture.read("README.md"), "theirs\n");
    let status = repo.status().unwrap();
    assert!(status.conflicted.is_empty());
    assert_eq!(paths(&status.staged), [("README.md", FileStatus::Modified)]);
    repo.continue_operation().unwrap();
    assert_eq!(repo.info().unwrap().state, RepoState::Clean);
    let head = repo.info().unwrap().head.target.unwrap();
    assert_eq!(repo.commit_details(&head).unwrap().parents.len(), 2);
}

#[test]
fn rebase_cherry_pick_and_revert_rewrite_history() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();
    let initial = fixture.initial.to_string();

    fixture.write("a.txt", "a\n");
    repo.stage_all().unwrap();
    let a = repo.commit("A\n", false).unwrap();
    repo.create_branch("feature", &initial, true).unwrap();
    fixture.write("b.txt", "b\n");
    repo.stage_all().unwrap();
    let b = repo.commit("B\n", false).unwrap();

    repo.rebase("main").unwrap();
    let head = repo.info().unwrap().head;
    assert_eq!(head.branch.as_deref(), Some("feature"));
    let rebased = repo.commit_details(&head.target.unwrap()).unwrap();
    assert_eq!(rebased.summary, "B");
    assert_eq!(rebased.parents, [a.clone()]);
    assert_ne!(rebased.id, b);

    repo.checkout("main", RefKind::LocalBranch).unwrap();
    repo.cherry_pick(&rebased.id).unwrap();
    assert_eq!(fixture.read("b.txt"), "b\n");
    let picked_id = repo.info().unwrap().head.target.unwrap();
    assert_eq!(repo.commit_details(&picked_id).unwrap().summary, "B");

    repo.revert(&picked_id).unwrap();
    assert!(!fixture.path().join("b.txt").exists());
    let reverted_id = repo.info().unwrap().head.target.unwrap();
    assert!(
        repo.commit_details(&reverted_id)
            .unwrap()
            .summary
            .starts_with("Revert \"B\"")
    );
}

#[test]
fn stash_saves_and_restores_the_working_tree() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();
    fixture.write("README.md", "changed\n");
    fixture.write("untracked.txt", "u\n");

    repo.stash_push("WIP on things", true).unwrap();
    assert!(repo.status().unwrap().is_clean());
    assert_eq!(fixture.read("README.md"), "hello\n");
    let stashes = repo.stash_list().unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].index, 0);
    assert!(
        stashes[0].message.contains("WIP on things"),
        "{}",
        stashes[0].message
    );

    repo.stash_apply(0).unwrap();
    assert_eq!(fixture.read("README.md"), "changed\n");
    assert_eq!(repo.stash_list().unwrap().len(), 1);
    repo.discard_all().unwrap();
    assert!(repo.status().unwrap().is_clean());

    repo.stash_pop(0).unwrap();
    assert_eq!(fixture.read("untracked.txt"), "u\n");
    assert!(repo.stash_list().unwrap().is_empty());

    fixture.write("README.md", "again\n");
    repo.stash_push("", false).unwrap();
    repo.stash_drop(0).unwrap();
    assert!(repo.stash_list().unwrap().is_empty());
    assert_eq!(fixture.read("README.md"), "hello\n");
}

#[test]
fn discard_restores_tracked_files_and_deletes_untracked_ones() {
    let fixture = Fixture::new();
    let repo = fixture.repo();
    fixture.write("README.md", "changed\n");
    fixture.remove("lib.rs");
    fixture.write("junk.txt", "junk\n");
    fixture.write("keep.txt", "keep\n");

    repo.discard(&["README.md".into(), "lib.rs".into(), "junk.txt".into()])
        .unwrap();
    assert_eq!(fixture.read("README.md"), "hello\n");
    assert_eq!(fixture.read("lib.rs"), "fn a() {}\n");
    assert!(!fixture.path().join("junk.txt").exists());
    assert_eq!(
        paths(&repo.status().unwrap().unstaged),
        [("keep.txt", FileStatus::Added)]
    );

    // Staged changes survive a discard of the unstaged ones.
    fixture.write("README.md", "staged\n");
    repo.stage(&["README.md".into()]).unwrap();
    fixture.write("README.md", "staged then edited\n");
    repo.discard_all().unwrap();
    assert_eq!(fixture.read("README.md"), "staged\n");
    let status = repo.status().unwrap();
    assert_eq!(paths(&status.staged), [("README.md", FileStatus::Modified)]);
    assert!(status.unstaged.is_empty());
}

#[test]
fn hunks_can_be_staged_and_unstaged_one_at_a_time() {
    let fixture = Fixture::new();
    let body: String = (1..=30).map(|n| format!("line {n}\n")).collect();
    fixture.write("long.txt", &body);
    commit_all(&fixture.git(), 1, "Long file\n");
    let repo = fixture.repo();

    let edited = body
        .replace("line 2\n", "line 2 changed\n")
        .replace("line 29\n", "line 29 changed\n");
    fixture.write("long.txt", &edited);
    assert_eq!(
        repo.workdir_file_diff("long.txt", None, false)
            .unwrap()
            .hunks
            .len(),
        2
    );

    repo.stage_hunk("long.txt", None, 1).unwrap();
    let staged = repo.workdir_file_diff("long.txt", None, true).unwrap();
    assert_eq!(staged.hunks.len(), 1);
    assert!(
        staged.hunks[0]
            .lines
            .iter()
            .any(|line| line.content == "line 29 changed")
    );
    let unstaged = repo.workdir_file_diff("long.txt", None, false).unwrap();
    assert_eq!(unstaged.hunks.len(), 1);
    assert!(
        unstaged.hunks[0]
            .lines
            .iter()
            .any(|line| line.content == "line 2 changed")
    );

    repo.unstage_hunk("long.txt", None, 0).unwrap();
    assert!(matches!(
        repo.workdir_file_diff("long.txt", None, true),
        Err(Error::PathNotChanged { .. })
    ));
    assert_eq!(
        repo.workdir_file_diff("long.txt", None, false)
            .unwrap()
            .hunks
            .len(),
        2
    );
    assert!(matches!(
        repo.stage_hunk("long.txt", None, 5),
        Err(Error::HunkNotFound { .. })
    ));
}

#[test]
fn search_finds_commits_by_message_author_and_id() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();
    fixture.write("x.txt", "x\n");
    repo.stage_all().unwrap();
    let second = repo.commit("Second step\n", false).unwrap();

    assert_eq!(repo.search_commits("initial", 10).unwrap(), [1]);
    assert_eq!(repo.search_commits("STEP", 10).unwrap(), [0]);
    assert_eq!(repo.search_commits("ada@", 10).unwrap(), [0, 1]);
    assert_eq!(repo.search_commits("ada@", 1).unwrap(), [0]);
    assert_eq!(repo.search_commits(&second[..7], 10).unwrap(), [0]);
    assert!(repo.search_commits("   ", 10).unwrap().is_empty());
    assert!(
        repo.search_commits("nothing like this", 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn file_contents_give_both_sides_of_a_change() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();
    fixture.write("README.md", "hello\nworld\n");

    let unstaged = repo
        .workdir_file_contents("README.md", None, false)
        .unwrap();
    assert_eq!(unstaged.old.as_deref(), Some("hello\n"));
    assert_eq!(unstaged.new.as_deref(), Some("hello\nworld\n"));
    assert!(!unstaged.binary && !unstaged.too_large);

    repo.stage_all().unwrap();
    let staged = repo.workdir_file_contents("README.md", None, true).unwrap();
    assert_eq!(staged.old.as_deref(), Some("hello\n"));
    assert_eq!(staged.new.as_deref(), Some("hello\nworld\n"));

    let id = repo.commit("World\n", false).unwrap();
    let committed = repo.commit_file_contents(&id, "README.md", None).unwrap();
    assert_eq!(committed.old.as_deref(), Some("hello\n"));
    assert_eq!(committed.new.as_deref(), Some("hello\nworld\n"));
    let root = repo
        .commit_file_contents(&fixture.initial.to_string(), "README.md", None)
        .unwrap();
    assert_eq!(root.old, None);
    assert_eq!(root.new.as_deref(), Some("hello\n"));
    assert!(matches!(
        repo.commit_file_contents(&id, "nope.txt", None),
        Err(Error::PathNotInCommit { .. })
    ));

    fixture.write("blob.bin", "\u{0}\u{1}\u{2}");
    let binary = repo.workdir_file_contents("blob.bin", None, false).unwrap();
    assert!(binary.binary);
    assert_eq!(binary.new.as_deref(), Some(""));
}

#[test]
fn init_and_clone_create_usable_repositories() {
    let dir = tempfile::tempdir().unwrap();
    let env = git_env(dir.path());
    let source = dir.path().join("source");

    let mut created = Repo::init(&source, env.clone()).unwrap();
    assert!(created.info().unwrap().head.branch.is_some());
    assert_eq!(created.commit_count().unwrap(), 0);
    write(&source, "README.md", "init\n");
    created.stage_all().unwrap();
    created.commit("First\n", false).unwrap();

    let target = dir.path().join("nested").join("clone");
    let url = source.to_string_lossy().replace('\\', "/");
    let mut cloned = Repo::clone(&url, &target, env.clone()).unwrap();
    assert_eq!(cloned.commit_count().unwrap(), 1);
    let head = cloned.info().unwrap().head;
    let branch = head
        .branch
        .expect("the clone checks out the default branch");
    assert_eq!(head.upstream, Some(format!("origin/{branch}")));
    assert_eq!(
        std::fs::read_to_string(target.join("README.md")).unwrap(),
        "init\n"
    );

    assert!(matches!(
        Repo::clone("not-a-url", dir.path().join("bad"), env),
        Err(Error::Command { .. })
    ));
}

#[test]
fn cancelling_stops_a_command_that_is_running() {
    use std::{thread, time::Instant};

    use gitui_core::CancelToken;

    let dir = tempfile::tempdir().unwrap();
    let env = git_env(dir.path());
    let source = dir.path().join("source");
    let mut created = Repo::init(&source, env.clone()).unwrap();
    write(&source, "README.md", "init\n");
    created.stage_all().unwrap();
    created.commit("First\n", false).unwrap();
    let url = source.to_string_lossy().replace('\\', "/");
    let clone = dir.path().join("clone");
    let cloned = Repo::clone(&url, &clone, env.clone()).unwrap();

    // A remote that never answers: its side of the conversation only sleeps.
    run_git(
        &clone,
        &env,
        &["config", "remote.origin.uploadpack", "sleep 30 #"],
    );
    let fetch = cloned.fetch_command().unwrap();
    let token = CancelToken::new();
    let started = Instant::now();
    let result = thread::scope(|scope| {
        let running = scope.spawn(|| fetch.run(&token, &mut |_| {}));
        thread::sleep(Duration::from_millis(1500));
        token.cancel();
        running.join().unwrap()
    });
    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    // `git` starts helpers that outlive it unless they are stopped with it.
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "cancelling took {:?}",
        started.elapsed()
    );
}

#[test]
fn network_operations_report_progress_and_honour_cancellation() {
    use gitui_core::CancelToken;

    let dir = tempfile::tempdir().unwrap();
    let env = git_env(dir.path());
    let source = dir.path().join("source");
    let mut created = Repo::init(&source, env.clone()).unwrap();
    write(&source, "README.md", "init\n");
    created.stage_all().unwrap();
    created.commit("First\n", false).unwrap();
    let url = source.to_string_lossy().replace('\\', "/");

    // Every git command announces itself on stderr, which is what the UI shows.
    let mut lines = Vec::new();
    let token = CancelToken::new();
    let mut cloned = Repo::clone_with_progress(
        &url,
        dir.path().join("clone"),
        env.clone(),
        &token,
        &mut |line| lines.push(line.to_owned()),
    )
    .unwrap();
    assert!(
        lines.iter().any(|line| line.starts_with("Cloning into")),
        "{lines:?}"
    );

    let mut fetched = Vec::new();
    cloned
        .fetch_with_progress(&CancelToken::new(), &mut |line| {
            fetched.push(line.to_owned())
        })
        .unwrap();

    // A token cancelled beforehand stops the operation before it starts.
    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert!(cancelled.is_cancelled());
    assert!(matches!(
        cloned.fetch_with_progress(&cancelled, &mut |_| {}),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        Repo::clone_with_progress(&url, dir.path().join("other"), env, &cancelled, &mut |_| {}),
        Err(Error::Cancelled)
    ));
}
