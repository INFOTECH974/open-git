//! Exercises the read-only API on a repository built from scratch in a temporary directory.
//!
//! History (newest first), with `main` checked out:
//!
//! ```text
//! D  main                 Rename lib
//! M  v2.0, origin/main    Merge feature       (parents B, C)
//! C  feature              Feature work
//! B                       Add lib
//! A  v1.0                 Initial commit
//! ```

use std::{fs, path::Path};

use git2::{Oid, Repository, RepositoryInitOptions, Signature, Time};
use gitui_core::{DiffLineKind, Error, FileStatus, HeadInfo, LaneRef, RefKind, Repo};
use tempfile::TempDir;

const T0: i64 = 1_700_000_000;

struct Fixture {
    dir: TempDir,
    a: Oid,
    b: Oid,
    c: Oid,
    m: Oid,
    d: Oid,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let git = init(dir.path());

        let readme = ("README.md", b"hello\n" as &[u8]);
        let readme2 = ("README.md", b"hello\nworld\n" as &[u8]);
        let lib = ("lib.rs", b"fn a() {}\n" as &[u8]);
        let notes = ("notes.txt", b"draft" as &[u8]);

        let a = commit(&git, "main", 0, "Initial commit\n", &[readme], &[]);
        let b = commit(
            &git,
            "main",
            1,
            "Add lib\n\nSome details about the lib.\n",
            &[readme, lib, notes],
            &[a],
        );
        let c = commit(&git, "feature", 2, "Feature work\n", &[readme2], &[a]);
        let m = commit(
            &git,
            "main",
            3,
            "Merge feature\n",
            &[readme2, lib, notes],
            &[b, c],
        );
        let d = commit(
            &git,
            "main",
            4,
            "Rename lib\n",
            &[
                readme2,
                ("core.rs", b"fn a() {}\n"),
                ("image.bin", b"\x00\x01\x02\xff\x00"),
                ("notes.txt", b"final"),
            ],
            &[m],
        );

        git.tag_lightweight("v1.0", &git.find_object(a, None).unwrap(), false)
            .unwrap();
        git.tag(
            "v2.0",
            &git.find_object(m, None).unwrap(),
            &signature(5),
            "Second release\n",
            false,
        )
        .unwrap();
        // A tag on a blob has no commit to show.
        let blob = git.blob(b"loose").unwrap();
        git.tag_lightweight("blob-tag", &git.find_object(blob, None).unwrap(), false)
            .unwrap();
        // A remote-tracking branch and the symbolic `origin/HEAD` that aliases it.
        git.reference("refs/remotes/origin/main", m, false, "")
            .unwrap();
        git.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            false,
            "",
        )
        .unwrap();

        Self { dir, a, b, c, m, d }
    }

    fn git(&self) -> Repository {
        Repository::open(self.dir.path()).unwrap()
    }

    fn repo(&self) -> Repo {
        Repo::open(self.dir.path()).unwrap()
    }

    fn id(&self, oid: Oid) -> String {
        oid.to_string()
    }
}

fn init(path: &Path) -> Repository {
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    Repository::init_opts(path, &options).unwrap()
}

fn signature(step: i64) -> Signature<'static> {
    Signature::new(
        "Ada Lovelace",
        "ada@example.com",
        &Time::new(T0 + step * 60, 0),
    )
    .unwrap()
}

/// Commits a flat tree made of `files` on `branch`, creating the branch if needed.
fn commit(
    git: &Repository,
    branch: &str,
    step: i64,
    message: &str,
    files: &[(&str, &[u8])],
    parents: &[Oid],
) -> Oid {
    let mut builder = git.treebuilder(None).unwrap();
    for (path, content) in files {
        let blob = git.blob(content).unwrap();
        builder.insert(path, blob, 0o100644).unwrap();
    }
    let tree = git.find_tree(builder.write().unwrap()).unwrap();
    let parents: Vec<_> = parents
        .iter()
        .map(|id| git.find_commit(*id).unwrap())
        .collect();
    let parents: Vec<_> = parents.iter().collect();
    let signature = signature(step);
    git.commit(
        Some(&format!("refs/heads/{branch}")),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .unwrap()
}

fn lane(lane: u32, color: u32) -> LaneRef {
    LaneRef { lane, color }
}

/// A `HEAD` without upstream.
fn head(branch: Option<&str>, target: Option<String>) -> HeadInfo {
    HeadInfo {
        branch: branch.map(str::to_owned),
        target,
        upstream: None,
        ahead: 0,
        behind: 0,
    }
}

#[test]
fn info_describes_the_checked_out_branch() {
    let fixture = Fixture::new();
    let info = fixture.repo().info().unwrap();

    assert_eq!(
        info.name,
        fixture.dir.path().file_name().unwrap().to_str().unwrap()
    );
    // The temporary directory may be spelled differently (`RUNNER~1` for
    // `runneradmin` on Windows), so compare what the two paths resolve to.
    assert_eq!(
        fs::canonicalize(&info.path).unwrap(),
        fs::canonicalize(fixture.dir.path()).unwrap()
    );
    assert!(!info.path.ends_with(['/', '\\']), "{}", info.path);
    assert_eq!(info.head, head(Some("main"), Some(fixture.id(fixture.d))));
}

#[test]
fn info_handles_a_detached_head() {
    let fixture = Fixture::new();
    fixture.git().set_head_detached(fixture.c).unwrap();

    let info = fixture.repo().info().unwrap();
    assert_eq!(info.head, head(None, Some(fixture.id(fixture.c))));
}

#[test]
fn empty_repository_has_an_unborn_branch_and_no_rows() {
    let dir = tempfile::tempdir().unwrap();
    init(dir.path());

    let mut repo = Repo::open(dir.path()).unwrap();
    assert_eq!(repo.info().unwrap().head, head(Some("main"), None));
    assert_eq!(repo.commit_count().unwrap(), 0);
    assert!(repo.graph_rows(0, 10).unwrap().is_empty());
    assert!(repo.refs().unwrap().is_empty());
}

#[test]
fn opening_a_directory_without_repository_fails() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(Repo::open(dir.path()), Err(Error::Git(_))));
}

#[test]
fn refs_list_branches_and_tags_sorted_by_name() {
    let fixture = Fixture::new();
    let refs = fixture.repo().refs().unwrap();

    let summary: Vec<_> = refs
        .iter()
        .map(|r| (r.name.as_str(), r.kind, r.target.as_str()))
        .collect();
    assert_eq!(
        summary,
        [
            (
                "feature",
                RefKind::LocalBranch,
                fixture.id(fixture.c).as_str()
            ),
            ("main", RefKind::LocalBranch, fixture.id(fixture.d).as_str()),
            (
                "origin/main",
                RefKind::RemoteBranch,
                fixture.id(fixture.m).as_str()
            ),
            ("v1.0", RefKind::Tag, fixture.id(fixture.a).as_str()),
            // Annotated tags resolve to the commit they annotate.
            ("v2.0", RefKind::Tag, fixture.id(fixture.m).as_str()),
        ]
    );
}

#[test]
fn graph_lists_commits_newest_first_with_lanes() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();

    assert_eq!(repo.commit_count().unwrap(), 5);
    let rows = repo.graph_rows(0, 10).unwrap();
    let ids: Vec<_> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            fixture.id(fixture.d),
            fixture.id(fixture.m),
            fixture.id(fixture.c),
            fixture.id(fixture.b),
            fixture.id(fixture.a),
        ]
    );

    let d = &rows[0];
    assert_eq!(d.summary, "Rename lib");
    assert_eq!(d.author_name, "Ada Lovelace");
    assert_eq!(d.author_email, "ada@example.com");
    assert_eq!(d.time, T0 + 4 * 60);
    assert_eq!((d.layout.lane, d.layout.color), (0, 0));
    assert!(d.layout.incoming.is_empty());
    assert_eq!(d.layout.outgoing, [lane(0, 0)]);

    let m = &rows[1].layout;
    assert_eq!(m.incoming, [lane(0, 0)]);
    assert_eq!(m.outgoing, [lane(0, 0), lane(1, 1)]);
    assert!(m.passing.is_empty());

    let c = &rows[2].layout;
    assert_eq!((c.lane, c.color), (1, 1));
    assert_eq!(c.incoming, [lane(1, 1)]);
    assert_eq!(c.outgoing, [lane(1, 1)]);
    assert_eq!(c.passing, [lane(0, 0)]);

    let b = &rows[3].layout;
    assert_eq!((b.lane, b.color), (0, 0));
    assert_eq!(b.passing, [lane(1, 1)]);

    let a = &rows[4].layout;
    assert_eq!((a.lane, a.color), (0, 0));
    assert_eq!(a.incoming, [lane(0, 0), lane(1, 1)]);
    assert!(a.outgoing.is_empty());
    assert!(a.passing.is_empty());
}

#[test]
fn graph_pages_are_consistent_wherever_reading_starts() {
    let fixture = Fixture::new();
    let mut whole = fixture.repo();
    let expected = whole.graph_rows(0, 10).unwrap();

    // Reading the middle first still lays out the rows above it.
    let mut paged = fixture.repo();
    let middle = paged.graph_rows(2, 2).unwrap();
    assert_eq!(middle.len(), 2);
    assert_eq!(middle[0].id, expected[2].id);
    assert_eq!(middle[0].layout, expected[2].layout);
    assert_eq!(middle[1].layout, expected[3].layout);

    let tail = paged.graph_rows(4, 10).unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].layout, expected[4].layout);

    assert!(paged.graph_rows(5, 1).unwrap().is_empty());
    assert!(paged.graph_rows(u32::MAX, u32::MAX).unwrap().is_empty());
}

#[test]
fn commit_index_locates_a_commit_in_the_graph() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();

    assert_eq!(repo.commit_index(&fixture.id(fixture.d)).unwrap(), Some(0));
    assert_eq!(repo.commit_index(&fixture.id(fixture.c)).unwrap(), Some(2));
    assert_eq!(repo.commit_index(&fixture.id(fixture.a)).unwrap(), Some(4));
    let unreachable = Oid::ZERO_SHA1.to_string();
    assert_eq!(repo.commit_index(&unreachable).unwrap(), None);
    assert!(matches!(repo.commit_index("nope"), Err(Error::Git(_))));
}

#[test]
fn graph_includes_a_detached_head_no_branch_points_at() {
    let fixture = Fixture::new();
    let git = fixture.git();
    let e = commit(&git, "scratch", 6, "Loose commit\n", &[], &[fixture.d]);
    git.set_head_detached(e).unwrap();
    git.find_reference("refs/heads/scratch")
        .unwrap()
        .delete()
        .unwrap();

    let mut repo = fixture.repo();
    assert_eq!(repo.commit_count().unwrap(), 6);
    assert_eq!(repo.graph_rows(0, 1).unwrap()[0].id, e.to_string());
}

#[test]
fn refresh_forgets_the_cached_history() {
    let fixture = Fixture::new();
    let mut repo = fixture.repo();
    assert_eq!(repo.commit_count().unwrap(), 5);

    commit(&fixture.git(), "main", 7, "Later\n", &[], &[fixture.d]);
    assert_eq!(repo.commit_count().unwrap(), 5, "the history is cached");

    repo.refresh();
    assert_eq!(repo.commit_count().unwrap(), 6);
}

#[test]
fn commit_details_split_the_message_and_list_changed_files() {
    let fixture = Fixture::new();
    let repo = fixture.repo();

    let b = repo.commit_details(&fixture.id(fixture.b)).unwrap();
    assert_eq!(b.id, fixture.id(fixture.b));
    assert_eq!(b.summary, "Add lib");
    assert_eq!(b.body, "Some details about the lib.");
    assert_eq!(b.author.name, "Ada Lovelace");
    assert_eq!(b.author.email, "ada@example.com");
    assert_eq!(b.author.time, T0 + 60);
    assert_eq!(b.committer, b.author);
    assert_eq!(b.parents, [fixture.id(fixture.a)]);
    let files: Vec<_> = b
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status, f.additions, f.deletions))
        .collect();
    assert_eq!(
        files,
        [
            ("lib.rs", FileStatus::Added, 1, 0),
            ("notes.txt", FileStatus::Added, 1, 0),
        ]
    );

    let m = repo.commit_details(&fixture.id(fixture.m)).unwrap();
    assert_eq!(m.summary, "Merge feature");
    assert_eq!(m.body, "");
    assert_eq!(m.parents, [fixture.id(fixture.b), fixture.id(fixture.c)]);
    // A merge is compared to its first parent only.
    assert_eq!(m.files.len(), 1);
    assert_eq!(m.files[0].path, "README.md");
    assert_eq!(m.files[0].status, FileStatus::Modified);
    assert_eq!((m.files[0].additions, m.files[0].deletions), (1, 0));
}

#[test]
fn root_commit_is_compared_to_an_empty_tree() {
    let fixture = Fixture::new();
    let a = fixture
        .repo()
        .commit_details(&fixture.id(fixture.a))
        .unwrap();

    assert!(a.parents.is_empty());
    assert_eq!(a.files.len(), 1);
    assert_eq!(a.files[0].path, "README.md");
    assert_eq!(a.files[0].status, FileStatus::Added);
}

#[test]
fn commit_details_detect_renames_and_binaries() {
    let fixture = Fixture::new();
    let d = fixture
        .repo()
        .commit_details(&fixture.id(fixture.d))
        .unwrap();

    let file = |path: &str| d.files.iter().find(|f| f.path == path).unwrap();

    let core = file("core.rs");
    assert_eq!(core.status, FileStatus::Renamed);
    assert_eq!(core.old_path.as_deref(), Some("lib.rs"));
    assert_eq!((core.additions, core.deletions), (0, 0));
    assert!(!d.files.iter().any(|f| f.path == "lib.rs"));

    let image = file("image.bin");
    assert_eq!(image.status, FileStatus::Added);
    assert!(image.binary);

    let notes = file("notes.txt");
    assert_eq!(notes.status, FileStatus::Modified);
    assert_eq!((notes.additions, notes.deletions), (1, 1));
    assert!(!notes.binary);
}

#[test]
fn file_diff_gives_hunks_with_line_numbers() {
    let fixture = Fixture::new();
    let diff = fixture
        .repo()
        .commit_file_diff(&fixture.id(fixture.c), "README.md")
        .unwrap();

    assert_eq!(diff.path, "README.md");
    assert_eq!(diff.old_path, None);
    assert_eq!(diff.status, FileStatus::Modified);
    assert!(!diff.binary);
    assert_eq!(diff.hunks.len(), 1);
    assert_eq!(diff.hunks[0].header, "@@ -1 +1,2 @@");
    let lines: Vec<_> = diff.hunks[0]
        .lines
        .iter()
        .map(|l| (l.kind, l.old_lineno, l.new_lineno, l.content.as_str()))
        .collect();
    assert_eq!(
        lines,
        [
            (DiffLineKind::Context, Some(1), Some(1), "hello"),
            (DiffLineKind::Addition, None, Some(2), "world"),
        ]
    );
}

#[test]
fn file_diff_marks_missing_trailing_newlines() {
    let fixture = Fixture::new();
    let diff = fixture
        .repo()
        .commit_file_diff(&fixture.id(fixture.d), "notes.txt")
        .unwrap();

    let lines: Vec<_> = diff.hunks[0]
        .lines
        .iter()
        .map(|l| (l.kind, l.content.as_str()))
        .collect();
    assert_eq!(
        lines,
        [
            (DiffLineKind::Deletion, "draft"),
            (DiffLineKind::NoNewline, "\\ No newline at end of file"),
            (DiffLineKind::Addition, "final"),
            (DiffLineKind::NoNewline, "\\ No newline at end of file"),
        ]
    );
}

#[test]
fn file_diff_of_a_rename_and_a_binary() {
    let fixture = Fixture::new();
    let repo = fixture.repo();

    let core = repo
        .commit_file_diff(&fixture.id(fixture.d), "core.rs")
        .unwrap();
    assert_eq!(core.status, FileStatus::Renamed);
    assert_eq!(core.old_path.as_deref(), Some("lib.rs"));
    assert!(core.hunks.is_empty());

    let image = repo
        .commit_file_diff(&fixture.id(fixture.d), "image.bin")
        .unwrap();
    assert!(image.binary);
    assert!(image.hunks.is_empty());
}

#[test]
fn file_diff_rejects_paths_the_commit_did_not_touch() {
    let fixture = Fixture::new();
    let repo = fixture.repo();

    let error = repo
        .commit_file_diff(&fixture.id(fixture.a), "missing.txt")
        .unwrap_err();
    assert!(matches!(error, Error::PathNotInCommit { ref path } if path == "missing.txt"));
    assert_eq!(
        error.to_string(),
        "`missing.txt` was not changed by this commit"
    );

    assert!(matches!(
        repo.commit_details("not-an-id"),
        Err(Error::Git(_))
    ));
}
