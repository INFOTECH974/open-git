/**
 * A fake backend for working on the UI in a plain browser (`pnpm dev`).
 *
 * It answers the same commands as `src-tauri` with a synthetic history, laid out
 * with a port of `LaneLayout` from `crates/core`, and a small in-memory working
 * tree that can be staged, committed, stashed, checked out, merged, pushed and
 * pulled. Only loaded in development when Tauri is absent; see `main.tsx`.
 */
import { emit as emitEvent } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";

import type {
  Account,
  Accounts,
  AiModel,
  AppError,
  CheckState,
  CommitDetails,
  CommitSuggestion,
  DiffLine,
  FileChange,
  FileContents,
  FileDiff,
  FileStatus,
  GraphRow,
  Issue,
  LaneRef,
  Provider,
  PullRequest,
  RemoteRepository,
  RefInfo,
  RefKind,
  RepoInfo,
  RepoState,
  RowLayout,
  StashEntry,
  StatusEntry,
  WorkflowJob,
  WorkflowRun,
  WorkflowStep,
  WorkingTreeStatus,
} from "@/bindings";

const DIALOG_PATHS = [
  "C:/Users/dev/projects/mock-repo",
  "C:/Users/dev/projects/mock-api",
  "C:/Users/dev/projects/mock-site",
];
const COMMIT_COUNT = 1200;
const LATENCY_MS = 60;

// Deterministic pseudo-random numbers so the fake history is stable across reloads.
let seed = 42;
function random(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(random() * list.length)];
}
function fakeId(): string {
  let id = "";
  for (let i = 0; i < 40; i++) id += Math.floor(random() * 16).toString(16);
  return id;
}

const AUTHORS = [
  ["Ada Lovelace", "ada@example.com"],
  ["Grace Hopper", "grace@example.com"],
  ["Linus Torvalds", "linus@example.com"],
  ["Margaret Hamilton", "margaret@example.com"],
] as const;
const VERBS = ["Add", "Fix", "Refactor", "Remove", "Update", "Document", "Test", "Speed up"];
const NOUNS = [
  "the commit graph",
  "lane assignment",
  "the diff viewer",
  "repository discovery",
  "the refs panel",
  "error handling",
  "the top bar",
  "file renames",
  "binary detection",
  "page loading",
];
const TOPICS = ["graph", "diff", "refs", "staging", "stash", "github", "search", "settings"];
const PATHS = [
  "crates/core/src/graph.rs",
  "crates/core/src/diff.rs",
  "crates/core/src/repo.rs",
  "src-tauri/src/commands.rs",
  "src/App.tsx",
  "src/components/CommitGraph.tsx",
  "src/components/FileDiffView.tsx",
  "src/lib/format.ts",
  "README.md",
  "assets/logo.png",
];

interface Commit {
  id: string;
  summary: string;
  body: string;
  author: (typeof AUTHORS)[number];
  time: number;
  parents: string[];
}

// ---- history, built oldest first --------------------------------------------

const commits: Commit[] = [];
const byId = new Map<string, Commit>();
const tips = new Map<string, string>();
const active: string[] = ["main"];
let time = Math.floor(Date.now() / 1000) - COMMIT_COUNT * 5 * 3600;
let topicCounter = 0;

function add(branch: string | null, parents: string[], summary: string, body = ""): Commit {
  const commit: Commit = { id: fakeId(), summary, body, author: pick(AUTHORS), time, parents };
  commits.push(commit);
  byId.set(commit.id, commit);
  if (branch) tips.set(branch, commit.id);
  return commit;
}

add("main", [], "Initial commit", "Project skeleton generated with create-tauri-app.");
for (let i = 1; i < COMMIT_COUNT; i++) {
  time += 3600 * (1 + Math.floor(random() * 8));
  const roll = random();
  if (roll < 0.07 && active.length < 4) {
    const name = `feature/${pick(TOPICS)}-${++topicCounter}`;
    active.push(name);
    add(name, [tips.get("main")!], `${pick(VERBS)} ${pick(NOUNS)}`);
  } else if (roll < 0.14 && active.length > 1) {
    const name = active[1 + Math.floor(random() * (active.length - 1))];
    add("main", [tips.get("main")!, tips.get(name)!], `Merge branch '${name}'`);
    active.splice(active.indexOf(name), 1);
    if (random() < 0.7) tips.delete(name);
  } else {
    const branch = pick(active);
    const body = random() < 0.3 ? "Longer explanation of why this change was needed.\n\nCloses #42." : "";
    add(branch, [tips.get(branch)!], `${pick(VERBS)} ${pick(NOUNS)}`, body);
  }
}

// ---- refs -------------------------------------------------------------------

const remoteTips = new Map<string, string>();
{
  let originMain = byId.get(tips.get("main")!)!;
  for (let i = 0; i < 2 && originMain.parents.length > 0; i++) {
    originMain = byId.get(originMain.parents[0])!;
  }
  remoteTips.set("origin/main", originMain.id);
  remoteTips.set("origin/production", commits[Math.floor(COMMIT_COUNT * 0.8)].id);
}
const tagTips = new Map<string, string>();
{
  let release = 1;
  for (let i = 80; i < COMMIT_COUNT; i += 150) tagTips.set(`v0.${release++}.0`, commits[i].id);
}

function refs(): RefInfo[] {
  const list: RefInfo[] = [];
  for (const [name, target] of tips) list.push({ name, kind: "localBranch", target });
  for (const [name, target] of remoteTips) list.push({ name, kind: "remoteBranch", target });
  for (const [name, target] of tagTips) list.push({ name, kind: "tag", target });
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** A commit id, branch, tag or remote branch name → commit id. */
function resolve(reference: string): string {
  const id = tips.get(reference) ?? remoteTips.get(reference) ?? tagTips.get(reference) ?? reference;
  if (!byId.has(id)) throw gitError(`fatal: invalid reference: ${reference}`);
  return id;
}

// ---- graph layout, a port of `LaneLayout` in crates/core/src/graph.rs --------

type Lane = { awaiting: string; color: number } | null;

class LaneLayout {
  private lanes: Lane[] = [];
  private nextColor = 0;

  place(id: string, parents: string[]): RowLayout {
    const incoming: LaneRef[] = [];
    const passing: LaneRef[] = [];
    this.lanes.forEach((lane, index) => {
      if (!lane) return;
      const ref = { lane: index, color: lane.color };
      if (lane.awaiting === id) {
        incoming.push(ref);
        this.lanes[index] = null;
      } else {
        passing.push(ref);
      }
    });
    const node = incoming[0] ?? { lane: this.firstFree(), color: this.nextColor++ };
    const outgoing = parents.map((parent, n) => {
      if (n === 0) return this.occupy(node.lane, parent, node.color);
      return this.laneAwaiting(parent) ?? this.occupy(this.firstFree(), parent, this.nextColor++);
    });
    while (this.lanes.length > 0 && this.lanes[this.lanes.length - 1] === null) this.lanes.pop();
    return { lane: node.lane, color: node.color, incoming, outgoing, passing };
  }

  private occupy(lane: number, awaiting: string, color: number): LaneRef {
    if (lane === this.lanes.length) this.lanes.push(null);
    this.lanes[lane] = { awaiting, color };
    return { lane, color };
  }

  private laneAwaiting(id: string): LaneRef | undefined {
    const index = this.lanes.findIndex((lane) => lane?.awaiting === id);
    return index < 0 ? undefined : { lane: index, color: this.lanes[index]!.color };
  }

  private firstFree(): number {
    const index = this.lanes.indexOf(null);
    return index < 0 ? this.lanes.length : index;
  }
}

let rows: GraphRow[] = [];
let indexById = new Map<string, number>();

/** Reversing the creation order lists children before parents, as a revwalk would. */
function layoutGraph(): void {
  const layout = new LaneLayout();
  rows = commits
    .slice()
    .reverse()
    .map((commit) => ({
      id: commit.id,
      summary: commit.summary,
      authorName: commit.author[0],
      authorEmail: commit.author[1],
      time: commit.time,
      layout: layout.place(commit.id, commit.parents),
    }));
  indexById = new Map(rows.map((row, index) => [row.id, index]));
}
layoutGraph();

// ---- details and diffs, derived deterministically from the commit id ---------

function seedFrom(text: string): void {
  seed = parseInt(text.slice(0, 8).replace(/[^0-9a-f]/g, "0"), 16) || 7;
}

function filesOf(commit: Commit): FileChange[] {
  seedFrom(commit.id);
  const count = commit.parents.length === 0 ? PATHS.length : 1 + Math.floor(random() * 5);
  const paths =
    commit.parents.length === 0
      ? PATHS
      : [...new Set(Array.from({ length: count }, () => pick(PATHS)))];
  return paths.sort().map((path) => {
    const binary = path.endsWith(".png");
    const roll = random();
    const status: FileStatus =
      commit.parents.length === 0
        ? "added"
        : roll < 0.1
          ? "added"
          : roll < 0.17
            ? "deleted"
            : roll < 0.22
              ? "renamed"
              : "modified";
    const additions = binary || status === "deleted" ? 0 : Math.floor(random() * 40);
    const deletions = binary || status === "added" ? 0 : Math.floor(random() * 25);
    return {
      path,
      oldPath: status === "renamed" ? path.replace(/(\.\w+)$/, "_old$1") : null,
      status,
      additions,
      deletions,
      binary,
    };
  });
}

function detailsOf(commit: Commit): CommitDetails {
  const author = { name: commit.author[0], email: commit.author[1], time: commit.time };
  return {
    id: commit.id,
    summary: commit.summary,
    body: commit.body,
    author,
    committer: author,
    parents: commit.parents,
    files: filesOf(commit),
  };
}

function diffOf(
  seedText: string,
  file: { path: string; oldPath: string | null; status: FileStatus },
): FileDiff {
  seedFrom(seedText);
  const binary = file.path.endsWith(".png");
  const hunks = [];
  if (!binary && file.status !== "renamed") {
    let oldLine = 1 + Math.floor(random() * 40);
    let newLine = oldLine;
    const hunkCount = 1 + Math.floor(random() * 3);
    for (let h = 0; h < hunkCount; h++) {
      const lines: DiffLine[] = [];
      const startOld = oldLine;
      const startNew = newLine;
      const length = 4 + Math.floor(random() * 10);
      for (let i = 0; i < length; i++) {
        const roll = random();
        const text = `${pick(VERBS).toLowerCase()}_${pick(TOPICS)}(${i});`;
        if (file.status === "added" || (roll >= 0.25 && roll < 0.5)) {
          lines.push({ kind: "addition", oldLineno: null, newLineno: newLine++, content: `    ${text} // new` });
        } else if (roll < 0.25) {
          lines.push({ kind: "deletion", oldLineno: oldLine++, newLineno: null, content: `    ${text}` });
        } else {
          lines.push({ kind: "context", oldLineno: oldLine++, newLineno: newLine++, content: `    ${text}` });
        }
      }
      hunks.push({
        header: `@@ -${startOld},${oldLine - startOld} +${startNew},${newLine - startNew} @@`,
        lines,
      });
      oldLine += 20;
      newLine += 20;
    }
  }
  return { path: file.path, oldPath: file.oldPath, status: file.status, binary, hunks };
}

/** Whole-file texts rebuilt from a diff, good enough for a side-by-side view. */
function contentsOf(diff: FileDiff): FileContents {
  if (diff.binary) return { old: "", new: "", binary: true, tooLarge: false };
  const old: string[] = [];
  const current: string[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "addition") old.push(line.content);
      if (line.kind !== "deletion") current.push(line.content);
    }
  }
  return {
    old: diff.status === "added" ? null : `${old.join("\n")}\n`,
    new: diff.status === "deleted" ? null : `${current.join("\n")}\n`,
    binary: false,
    tooLarge: false,
  };
}

// ---- per-repository state: head, working tree, stashes -----------------------

interface MockRepo {
  path: string;
  head: { branch: string | null; target: string };
  status: WorkingTreeStatus;
  stashes: (StashEntry & { saved: WorkingTreeStatus })[];
  state: RepoState;
  ahead: number;
  behind: number;
}

const repos = new Map<string, MockRepo>();

function initialStatus(): WorkingTreeStatus {
  return {
    unstaged: [
      { path: "README.md", oldPath: null, status: "modified" },
      { path: "assets/logo.png", oldPath: null, status: "modified" },
      { path: "src/App.tsx", oldPath: null, status: "modified" },
      { path: "src/lib/new-file.ts", oldPath: null, status: "added" },
    ],
    staged: [{ path: "src/components/RefsPanel.tsx", oldPath: null, status: "modified" }],
    conflicted: [],
  };
}

function repoAt(path: string): MockRepo {
  let repo = repos.get(path);
  if (!repo) {
    if (!path.includes("mock")) {
      throw gitError(`could not find repository at '${path}'; class=Repository (6); code=NotFound (-3)`);
    }
    repo = {
      path,
      head: { branch: "main", target: tips.get("main")! },
      status: initialStatus(),
      stashes: [],
      state: "clean",
      ahead: 0,
      behind: 2,
    };
    repos.set(path, repo);
  }
  return repo;
}

function infoOf(repo: MockRepo): RepoInfo {
  const upstream = repo.head.branch === "main" ? "origin/main" : null;
  return {
    name: repo.path.split("/").pop() ?? repo.path,
    path: repo.path,
    head: {
      branch: repo.head.branch,
      target: repo.head.target,
      upstream,
      ahead: upstream ? repo.ahead : 0,
      behind: upstream ? repo.behind : 0,
    },
    state: repo.state,
    author: { name: "Ada Lovelace", email: "ada@example.com" },
    remotes: ["origin"],
  };
}

function moveEntries(from: StatusEntry[], to: StatusEntry[], files: string[]): void {
  for (const file of files) {
    const index = from.findIndex((entry) => entry.path === file);
    if (index < 0) continue;
    const [entry] = from.splice(index, 1);
    to.push(entry);
  }
  to.sort((a, b) => a.path.localeCompare(b.path));
}

/** Adds a commit on the current branch and lays the graph out again. */
function commitOn(repo: MockRepo, summary: string, body = "", parents?: string[]): Commit {
  if (!repo.head.branch) throw gitError("HEAD is detached in this mock; check out a branch first");
  time = Math.floor(Date.now() / 1000);
  const commit = add(repo.head.branch, parents ?? [repo.head.target], summary, body);
  commit.author = AUTHORS[0];
  layoutGraph();
  repo.head.target = commit.id;
  if (repo.head.branch === "main") repo.ahead++;
  return commit;
}

function commitStaged(repo: MockRepo, message: string, amend: boolean): string {
  if (!message.trim()) throw gitError("the commit message is empty");
  if (repo.status.staged.length === 0 && !amend) {
    throw gitError(
      "git commit --cleanup=strip -F - failed (exit code 1): nothing to commit, working tree clean",
    );
  }
  const [summary, ...rest] = message.trim().split("\n");
  if (amend) {
    const head = byId.get(repo.head.target)!;
    head.summary = summary;
    head.body = rest.join("\n").trim();
    layoutGraph();
    repo.status.staged = [];
    return head.id;
  }
  const commit = commitOn(repo, summary, rest.join("\n").trim());
  repo.status.staged = [];
  return commit.id;
}

function checkoutRef(repo: MockRepo, name: string, kind: RefKind): void {
  if (repo.status.unstaged.length > 0 && random() < 0.15) {
    throw gitError(
      `git switch ${name} failed (exit code 1): error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/App.tsx\nPlease commit your changes or stash them before you switch branches.`,
    );
  }
  switch (kind) {
    case "localBranch":
      repo.head = { branch: name, target: resolve(name) };
      break;
    case "remoteBranch": {
      const target = resolve(name);
      const local = name.slice(name.indexOf("/") + 1);
      if (!tips.has(local)) tips.set(local, target);
      repo.head = { branch: local, target: tips.get(local)! };
      break;
    }
    case "tag":
      repo.head = { branch: null, target: resolve(name) };
  }
}

// ---- GitHub, faked ---------------------------------------------------------------

/**
 * The accounts that can be connected: each sign-in connects the next one, and
 * signs in to the last one again once they all are. A sign-in reconnects first
 * an account whose token was refused, and a token ending in `@login` connects
 * that account, as the token of another account would; a token containing
 * "revoked" connects one whose token GitHub then refuses.
 */
const GITHUB_ACCOUNTS: Account[] = [
  {
    login: "ada",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    htmlUrl: "https://github.com/ada",
  },
  {
    login: "ada-at-work",
    avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4",
    htmlUrl: "https://github.com/ada-at-work",
  },
];
/** The connected accounts, in the order they were, and the login of the active one. */
const githubAccounts: Account[] = [];
let githubActive: string | null = null;
/** The connected accounts whose token GitHub no longer accepts. */
const refusedAccounts = new Set<string>();
/** The account a repository was given (by a clone or by hand), by its path. */
const repositoryAccounts = new Map<string, string>();
let nextIssueNumber = 120;
const now = Math.floor(Date.now() / 1000);

type RepositoryRow = [fullName: string, description: string, isPrivate: boolean, fork: boolean, archived: boolean, hoursAgo: number];

function remoteRepositories(rows: RepositoryRow[]): RemoteRepository[] {
  return rows.map(([fullName, description, isPrivate, fork, archived, hoursAgo]) => ({
    fullName,
    description,
    private: isPrivate,
    fork,
    archived,
    cloneUrl: `https://github.com/${fullName}.git`,
    pushedAt: now - hoursAgo * 3600,
  }));
}

/**
 * What each account can clone: its own repositories, a collaboration, an
 * organisation's. Most recently pushed first, as GitHub sends them.
 */
const repositoriesOf: Record<string, RemoteRepository[]> = {
  ada: remoteRepositories([
    ["ada/mock-repo", "A visual Git client", false, false, false, 2],
    ["analytical-society/website", "Public site of the society", false, false, false, 5],
    ["analytical-society/billing", "Invoices and subscriptions", true, false, false, 12],
    ["ada/analytical-engine", "Notes on the engine, with the first program", true, false, false, 30],
    ["analytical-society/infrastructure", "Servers, deployments and backups", true, false, false, 50],
    ["babbage/difference-engine", "Tabulating polynomial functions", false, false, false, 90],
    ["ada/dotfiles", "", true, false, false, 300],
    ["analytical-society/design-system", "Shared components", true, false, false, 400],
    ["analytical-society/mobile-app", "", true, false, false, 700],
    ["analytical-society/handbook", "How we work", false, false, false, 1500],
    ["ada/linux", "Linux kernel source tree", false, true, false, 2000],
    ["babbage/punch-cards", "", true, false, true, 9000],
  ]),
  "ada-at-work": remoteRepositories([
    ["difference-ltd/mock-api", "The API the tabulators call", true, false, false, 1],
    ["ada-at-work/mock-site", "Site of the company", false, false, false, 8],
    ["difference-ltd/tabulator-firmware", "", true, false, false, 26],
    ["difference-ltd/customer-portal", "Orders and support", true, false, false, 70],
    ["ada-at-work/onboarding-notes", "", true, false, false, 900],
  ]),
};

/** Who owns the GitHub repository behind each fictitious path. */
function ownerOf(path: string): string {
  if (path.includes("mock-api")) return "difference-ltd";
  if (path.includes("mock-site")) return "ada-at-work";
  return "ada";
}

function connectedAccount(login: string | null | undefined): Account | undefined {
  return githubAccounts.find((account) => account.login === login);
}

type Access = "refused" | "hidden" | "read" | "write";
const ACCESS_RANK: Record<Access, number> = { refused: 0, hidden: 0, read: 1, write: 2 };

/**
 * What `login` may do with the repository behind `path`: `ada-at-work` pushes to
 * all three, `ada` to her own repository only, reads the company's public site
 * and cannot see its private API.
 */
function accessOf(login: string, path: string): Access {
  if (refusedAccounts.has(login)) return "refused";
  if (login === "ada-at-work") return "write";
  if (path.includes("mock-api")) return "hidden";
  if (path.includes("mock-site")) return "read";
  return "write";
}

/**
 * The account that works on the repository at `path`, as the backend decides it:
 * the one it names, else one that can push rather than only read, the active
 * one first, then the owner, then the others; else the owner, else the active one.
 */
function accountFor(path: string): Account | undefined {
  const bound = connectedAccount(repositoryAccounts.get(path));
  if (bound) return bound;
  const active = connectedAccount(githubActive);
  const owner = connectedAccount(ownerOf(path));
  const candidates = [active, owner, ...githubAccounts].filter((account) => account !== undefined);
  let best: Account | undefined;
  let bestRank = 0;
  for (const candidate of candidates) {
    const rank = ACCESS_RANK[accessOf(candidate.login, path)];
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best ?? owner ?? active;
}

function accountsState(): Accounts {
  return {
    accounts: [...githubAccounts],
    active: githubActive,
    refused: githubAccounts.map((account) => account.login).filter((login) => refusedAccounts.has(login)),
  };
}
const pullRequests: PullRequest[] = [
  { number: 118, title: "Speed up lane assignment", body: "", state: "open", draft: false, merged: false, author: "grace", head: "feature/graph-14", base: "main", htmlUrl: "https://github.com/ada/mock-repo/pull/118", createdAt: now - 86400 * 2, updatedAt: now - 3600 * 5 },
  { number: 115, title: "Document the refs panel", body: "", state: "open", draft: true, merged: false, author: "linus", head: "feature/refs-21", base: "main", htmlUrl: "https://github.com/ada/mock-repo/pull/115", createdAt: now - 86400 * 4, updatedAt: now - 86400 },
  { number: 101, title: "Add binary detection", body: "", state: "closed", draft: false, merged: true, author: "margaret", head: "feature/diff-9", base: "main", htmlUrl: "https://github.com/ada/mock-repo/pull/101", createdAt: now - 86400 * 20, updatedAt: now - 86400 * 12 },
];
const issues: Issue[] = [
  { number: 117, title: "Graph lanes overlap after a rebase", body: "Steps to reproduce…", state: "open", author: "linus", labels: [{ name: "bug", color: "d73a4a" }], comments: 3, htmlUrl: "https://github.com/ada/mock-repo/issues/117", createdAt: now - 86400 * 3, updatedAt: now - 7200 },
  { number: 112, title: "Remember the diff layout per repository", body: "", state: "open", author: "ada", labels: [{ name: "enhancement", color: "a2eeef" }], comments: 0, htmlUrl: "https://github.com/ada/mock-repo/issues/112", createdAt: now - 86400 * 6, updatedAt: now - 86400 * 2 },
  { number: 98, title: "Crash when the remote is unreachable", body: "", state: "closed", author: "grace", labels: [{ name: "bug", color: "d73a4a" }], comments: 5, htmlUrl: "https://github.com/ada/mock-repo/issues/98", createdAt: now - 86400 * 30, updatedAt: now - 86400 * 25 },
];

function githubError(message: string): AppError {
  return { kind: "gitHub", message };
}

/**
 * The account that works on the repository at `path`; fails when none is
 * connected, or when GitHub refuses its token.
 */
function requireAccount(path: string): Account {
  const account = accountFor(path);
  if (!account) throw githubError("no GitHub account is connected");
  if (refusedAccounts.has(account.login)) {
    const refused: AppError = {
      kind: "tokenRefused",
      message: `GitHub no longer accepts the token of ${account.login}: connect this account again`,
    };
    throw refused;
  }
  return account;
}

// ---- GitHub Actions, faked ---------------------------------------------------------
//
// A run is a plan: jobs, their steps and how long each takes. What the commands
// answer is where that plan stands at the time they are asked, so a run started
// a moment ago goes from queued to its verdict while the UI keeps asking.

interface JobPlan {
  name: string;
  /** Seconds after the run is created before a runner takes the job. */
  after: number;
  /** Each step and the seconds it takes. */
  steps: [name: string, seconds: number][];
  /** Index of the step that breaks the job, when one does. */
  fails?: number;
}

interface RunPlan {
  id: number;
  workflow: string;
  number: number;
  event: string;
  branch: string;
  commit: string;
  /** Seconds since the Unix epoch. */
  createdAt: number;
  jobs: JobPlan[];
}

function rustJob(os: string, after: number, slowness: number, fails?: number): JobPlan {
  const steps: JobPlan["steps"] = [
    ["Set up job", 2],
    ["Run actions/checkout@v4", 2],
    ["Run dtolnay/rust-toolchain@stable", 4],
    ["cargo fmt --all --check", 2],
    ["cargo clippy --workspace --all-targets", 8],
    ["cargo test", 13],
    ["Post Run actions/checkout@v4", 1],
    ["Complete job", 1],
  ];
  return {
    name: `Rust (${os})`,
    after,
    steps: steps.map(([name, seconds]) => [name, Math.round(seconds * slowness)]),
    fails,
  };
}

/** The jobs of the `CI` workflow; `fails` breaks clippy on Linux. */
function ciJobs(fails = false): JobPlan[] {
  return [
    rustJob("ubuntu-latest", 4, 1, fails ? 4 : undefined),
    rustJob("windows-latest", 6, 1.4),
    {
      name: "Frontend",
      after: 4,
      steps: [
        ["Set up job", 2],
        ["Run actions/checkout@v4", 2],
        ["Run pnpm install --frozen-lockfile", 6],
        ["Run pnpm build", 9],
        ["Complete job", 1],
      ],
    },
  ];
}

function releaseJobs(): JobPlan[] {
  return ["windows", "macos-arm", "linux"].map((target, index) => ({
    name: `Installer (${target})`,
    after: 4 + index,
    steps: [
      ["Set up job", 2],
      ["Run actions/checkout@v4", 2],
      ["Run tauri-apps/tauri-action@v0", 300 + index * 45],
      ["Complete job", 1],
    ],
  }));
}

let nextRunId = 18_431_216_000;
const runNumbers = new Map<string, number>([
  ["CI", 208],
  ["Release", 13],
]);
/** Newest first, as GitHub lists them. */
const runPlans: RunPlan[] = [];

function startRun(
  workflow: string,
  event: string,
  branch: string,
  commit: string,
  jobs: JobPlan[],
  createdAt = Date.now() / 1000,
): void {
  const number = (runNumbers.get(workflow) ?? 0) + 1;
  runNumbers.set(workflow, number);
  runPlans.unshift({ id: nextRunId++, workflow, number, event, branch, commit, createdAt: Math.floor(createdAt), jobs });
}

// What ran before the application opened: the commits behind `origin/main`, and a release.
{
  const pushed: string[] = [];
  for (let id = remoteTips.get("origin/main"); id && pushed.length < 3; id = byId.get(id)?.parents[0]) {
    pushed.push(id);
  }
  const [latestTag, tagged] = [...tagTips].pop()!;
  startRun("Release", "push", latestTag, tagged, releaseJobs(), now - 86400 * 6);
  if (pushed[2]) startRun("CI", "push", "main", pushed[2], ciJobs(), now - 3600 * 30);
  if (pushed[1]) startRun("CI", "push", "main", pushed[1], ciJobs(true), now - 3600 * 4);
}

function jobAt(run: RunPlan, plan: JobPlan, index: number, at: number): WorkflowJob {
  const start = run.createdAt + plan.after;
  let clock = start;
  let broken = false;
  const steps = plan.steps.map(([name, seconds], position): WorkflowStep => {
    const number = position + 1;
    if (broken) return { number, name, state: "skipped", startedAt: null, completedAt: null };
    const begins = clock;
    if (at < begins) return { number, name, state: "queued", startedAt: null, completedAt: null };
    clock += seconds;
    if (at < clock) return { number, name, state: "inProgress", startedAt: begins, completedAt: null };
    broken = plan.fails === position;
    return { number, name, state: broken ? "failure" : "success", startedAt: begins, completedAt: clock };
  });
  const over = at >= clock && steps.every((step) => step.state !== "queued");
  const id = run.id * 10 + index;
  return {
    id,
    name: plan.name,
    state: at < start ? "queued" : !over ? "inProgress" : broken ? "failure" : "success",
    htmlUrl: `https://github.com/ada/mock-repo/actions/runs/${run.id}/job/${id}`,
    startedAt: at < start ? null : start,
    completedAt: over ? clock : null,
    steps,
  };
}

function jobsAt(run: RunPlan, at = Date.now() / 1000): WorkflowJob[] {
  return run.jobs.map((plan, index) => jobAt(run, plan, index, at));
}

function runAt(run: RunPlan, at = Date.now() / 1000): WorkflowRun {
  const jobs = jobsAt(run, at);
  const state: CheckState = jobs.every((job) => job.state === "queued")
    ? "queued"
    : jobs.some((job) => job.completedAt === null)
      ? "inProgress"
      : jobs.some((job) => job.state === "failure")
        ? "failure"
        : "success";
  // The last time anything moved, which is the end of the run once it is over.
  const moments = jobs.flatMap((job) => [
    job.startedAt,
    ...job.steps.flatMap((step) => [step.startedAt, step.completedAt]),
  ]);
  return {
    id: run.id,
    workflow: run.workflow,
    title: byId.get(run.commit)?.summary ?? run.workflow,
    number: run.number,
    attempt: 1,
    event: run.event,
    branch: run.branch,
    commit: run.commit,
    state,
    actor: "ada",
    htmlUrl: `https://github.com/ada/mock-repo/actions/runs/${run.id}`,
    startedAt: run.createdAt,
    updatedAt: Math.max(run.createdAt, ...moments.filter((moment) => moment !== null)),
  };
}

// ---- commit message assistant, faked ---------------------------------------------

const aiKeys = new Set<Provider>();
// `claude` is installed from the start; `codex` only appears once the settings
// dialog was asked to look again (the start-up and the dialog look first).
let aiLooks = 0;
const aiModels: Record<Provider, AiModel[]> = {
  claudecode: ["opus", "sonnet", "haiku", "fable"].map((id) => ({ id, name: id })),
  codex: [],
  anthropic: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ],
  openai: [
    { id: "gpt-mock-large", name: "gpt-mock-large" },
    { id: "gpt-mock-mini", name: "gpt-mock-mini" },
  ],
};

function aiError(message: string): AppError {
  return { kind: "ai", message };
}

/** A message a model could have written for what is staged in `repo`. */
function suggestMessage(repo: MockRepo, amend: boolean): CommitSuggestion {
  const staged = repo.status.staged;
  if (staged.length === 0 && !amend) throw aiError("there is no staged change to describe");
  const names = staged.map((entry) => entry.path.split("/").pop() ?? entry.path);
  if (names.length === 0) return { summary: "Reword the last commit", body: "", shortenedFiles: 0 };
  const summary = names.length === 1 ? `Update ${names[0]}` : `Update ${names[0]} and ${names.length - 1} more`;
  const body =
    names.length > 1
      ? `Touches ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}.
Written by the mock assistant.`
      : "";
  return { summary, body, shortenedFiles: names.some((name) => name.endsWith(".lock")) ? 1 : 0 };
}

// ---- updates of the application, faked --------------------------------------------

const APP_VERSION = "0.1.0";
// The start-up look and the first "Check for updates" find nothing; the
// release appears on the next one.
let updateLooks = 0;

/** Plays the download of the update, then fails: there is nothing to restart into. */
async function installUpdate(): Promise<never> {
  for (const percent of [null, 0, 12, 31, 54, 78, 93, 100]) {
    await emitEvent("update-progress", { percent });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw { kind: "update", message: "the mock backend has no installer to run" } satisfies AppError;
}

/** The three shapes `ignoreChoices` produces: `/file`, `*.ext` and `/folder/`. */
function ignoreMatches(pattern: string, path: string): boolean {
  if (pattern.startsWith("*.")) return path.endsWith(pattern.slice(1));
  if (pattern.endsWith("/")) return path.startsWith(pattern.slice(1));
  return path === pattern.slice(1);
}

// ---- the IPC itself -----------------------------------------------------------

function gitError(message: string): AppError {
  return { kind: "git", message };
}

function delayed<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

let dialogCalls = 0;

const PROGRESS_LINES = [
  "Enumerating objects: 128, done.",
  "Counting objects:  25% (32/128)",
  "Counting objects: 100% (128/128), done.",
  "Compressing objects:  60% (46/77)",
  "Compressing objects: 100% (77/77), done.",
  "Receiving objects:  40% (51/128)",
  "Receiving objects:  80% (103/128)",
  "Receiving objects: 100% (128/128), 24.10 KiB | 2.01 MiB/s, done.",
  "Resolving deltas: 100% (41/41), done.",
];

const cancelled = new Set<string>();

/** How long the remote's deployment job takes to move `production` after a push to `main`. */
const PROMOTION_DELAY_MS = 5000;
let promotion: { due: number; target: string } | null = null;

/** What a fetch brings back: whether a remote branch moved since the last one. */
function fetchRemote(): boolean {
  if (!promotion || Date.now() < promotion.due) return false;
  remoteTips.set("origin/production", promotion.target);
  promotion = null;
  return true;
}

/** Plays git-like progress lines for `path`, stopping early when cancelled. */
async function withProgress(path: string, operation: string, stepMs = 180): Promise<void> {
  cancelled.delete(path);
  for (const message of PROGRESS_LINES) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (cancelled.has(path)) {
      cancelled.delete(path);
      throw { kind: "cancelled", message: "the operation was cancelled" } satisfies AppError;
    }
    const match = /(\d+)%/.exec(message);
    await emitEvent("operation-progress", {
      path,
      operation,
      message,
      percent: match ? Number(match[1]) : null,
    });
  }
}

function handle(command: string, args: Record<string, unknown>): unknown {
  const path = String(args.path ?? "");
  const files = () => args.files as string[];
  switch (command) {
    // Tauri internals the frontend uses: the folder dialog and the event system.
    case "plugin:dialog|open":
      return DIALOG_PATHS[dialogCalls++ % DIALOG_PATHS.length];
    case "plugin:app|version":
      return APP_VERSION;
    case "update_check":
      return delayed(++updateLooks > 2 ? "0.2.0" : null, 600);
    case "update_install":
      return installUpdate();
    case "cancel_operation":
      cancelled.add(path);
      return true;

    // repositories
    case "open_repository":
    case "refresh_repository":
      return infoOf(repoAt(path));
    case "init_repository":
      return infoOf(repoAt(path.includes("mock") ? path : `${path}/mock-new`));
    case "clone_repository": {
      const destination = String(args.destination);
      const account = connectedAccount(args.account as string | null);
      return withProgress(destination, "clone", 250).then(() => {
        // The clone keeps the account it was made with.
        if (account) repositoryAccounts.set(`${destination}-mock`, account.login);
        return infoOf(repoAt(`${destination}-mock`));
      });
    }
    case "close_repository":
      repos.delete(path);
      return null;
    case "repository_refs":
      return refs();
    case "open_in_editor":
    case "reveal_in_file_manager":
      console.info(`[open-git] mock: ${command} ${String(args.file)}`);
      return null;

    // history
    case "commit_count":
      return rows.length;
    case "graph_rows": {
      const offset = Number(args.offset);
      return rows.slice(offset, offset + Number(args.limit));
    }
    case "commit_index":
      return indexById.get(String(args.id)) ?? null;
    case "search_commits": {
      const needle = String(args.query).trim().toLowerCase();
      const limit = Number(args.limit);
      const hits: number[] = [];
      if (!needle) return hits;
      for (let index = 0; index < rows.length && hits.length < limit; index++) {
        const row = rows[index];
        if (
          row.id.startsWith(needle) ||
          row.summary.toLowerCase().includes(needle) ||
          row.authorName.toLowerCase().includes(needle) ||
          row.authorEmail.toLowerCase().includes(needle)
        ) {
          hits.push(index);
        }
      }
      return hits;
    }
    case "commit_details": {
      const commit = byId.get(String(args.id));
      if (!commit) throw gitError("unable to parse OID - contains invalid characters; class=Object (11)");
      return detailsOf(commit);
    }
    case "commit_file_diff":
    case "commit_file_contents": {
      const commit = byId.get(String(args.id));
      if (!commit) throw gitError("object not found");
      const file = filesOf(commit).find((candidate) => candidate.path === args.file);
      if (!file) throw gitError(`\`${String(args.file)}\` was not changed by this commit`);
      const diff = diffOf(commit.id + file.path, file);
      return command === "commit_file_diff" ? diff : contentsOf(diff);
    }

    // working tree
    case "working_tree_status":
      return structuredClone(repoAt(path).status);
    case "stage_files": {
      const repo = repoAt(path);
      const resolved = files().filter((file) => repo.status.conflicted.includes(file));
      repo.status.conflicted = repo.status.conflicted.filter((file) => !resolved.includes(file));
      for (const file of resolved) repo.status.staged.push({ path: file, oldPath: null, status: "modified" });
      moveEntries(repo.status.unstaged, repo.status.staged, files());
      return null;
    }
    case "unstage_files": {
      const repo = repoAt(path);
      moveEntries(repo.status.staged, repo.status.unstaged, files());
      return null;
    }
    case "stage_all": {
      const repo = repoAt(path);
      moveEntries(repo.status.unstaged, repo.status.staged, repo.status.unstaged.map((e) => e.path));
      return null;
    }
    case "unstage_all": {
      const repo = repoAt(path);
      moveEntries(repo.status.staged, repo.status.unstaged, repo.status.staged.map((e) => e.path));
      return null;
    }
    case "stage_hunk":
    case "unstage_hunk":
      // The fake diffs are regenerated from a seed; moving one hunk is not modelled.
      return null;
    case "discard_files": {
      const repo = repoAt(path);
      repo.status.unstaged = repo.status.unstaged.filter((entry) => !files().includes(entry.path));
      return null;
    }
    case "discard_all":
      repoAt(path).status.unstaged = [];
      return null;
    case "workdir_file_diff":
    case "workdir_file_contents": {
      const repo = repoAt(path);
      const list = args.staged ? repo.status.staged : repo.status.unstaged;
      const entry = list.find((candidate) => candidate.path === args.file);
      if (!entry) throw gitError(`\`${String(args.file)}\` has no changes to show`);
      const diff = diffOf(`${entry.path}:${args.staged ? "staged" : "unstaged"}`, entry);
      return command === "workdir_file_diff" ? diff : contentsOf(diff);
    }
    case "ignore_paths": {
      const repo = repoAt(path);
      const patterns = args.patterns as string[];
      // Untracked files matching a pattern vanish; `.gitignore` itself shows up as changed.
      repo.status.unstaged = repo.status.unstaged.filter(
        (entry) => entry.status !== "added" || !patterns.some((pattern) => ignoreMatches(pattern, entry.path)),
      );
      if (!repo.status.unstaged.some((entry) => entry.path === ".gitignore")) {
        repo.status.unstaged.push({ path: ".gitignore", oldPath: null, status: "modified" });
        repo.status.unstaged.sort((a, b) => a.path.localeCompare(b.path));
      }
      return null;
    }
    case "commit":
      return commitStaged(repoAt(path), String(args.message), Boolean(args.amend));

    // branches and tags
    case "checkout":
      checkoutRef(repoAt(path), String(args.name), args.kind as RefKind);
      return null;
    case "checkout_commit":
      repoAt(path).head = { branch: null, target: resolve(String(args.id)) };
      return null;
    case "create_branch": {
      const repo = repoAt(path);
      const name = String(args.name);
      if (tips.has(name)) throw gitError(`fatal: a branch named '${name}' already exists`);
      const target = resolve(String(args.startPoint));
      tips.set(name, target);
      if (args.checkout) repo.head = { branch: name, target };
      return null;
    }
    case "rename_branch": {
      const repo = repoAt(path);
      const target = tips.get(String(args.name));
      if (target === undefined) throw gitError(`error: refname refs/heads/${String(args.name)} not found`);
      tips.delete(String(args.name));
      tips.set(String(args.newName), target);
      if (repo.head.branch === args.name) repo.head.branch = String(args.newName);
      return null;
    }
    case "delete_branch": {
      const repo = repoAt(path);
      const name = String(args.name);
      if (repo.head.branch === name) throw gitError(`error: cannot delete branch '${name}' used by worktree`);
      if (!args.force && name.includes("stash")) {
        throw gitError(`error: the branch '${name}' is not fully merged`);
      }
      if (!tips.delete(name)) throw gitError(`error: branch '${name}' not found`);
      return null;
    }
    case "delete_remote_branch":
      if (!remoteTips.delete(String(args.name))) throw gitError(`error: unable to delete '${String(args.name)}': remote ref does not exist`);
      return delayed(null, 500);
    case "push_branch": {
      const name = String(args.name);
      remoteTips.set(`origin/${name}`, resolve(name));
      // Only `main` is known to pass: any other branch breaks clippy.
      startRun("CI", "push", name, resolve(name), ciJobs(name !== "main"));
      return delayed(null, 500);
    }
    case "set_upstream":
      return null;
    case "create_tag": {
      const name = String(args.name);
      if (tagTips.has(name)) throw gitError(`fatal: tag '${name}' already exists`);
      tagTips.set(name, resolve(String(args.target)));
      return null;
    }
    case "delete_tag":
      if (!tagTips.delete(String(args.name))) throw gitError(`error: tag '${String(args.name)}' not found`);
      return null;

    // merges and friends
    case "merge": {
      const repo = repoAt(path);
      const reference = String(args.reference);
      const target = resolve(reference);
      if (reference.startsWith("origin/production")) {
        repo.state = "merge";
        repo.status.conflicted = ["src/App.tsx"];
        throw gitError(
          "git merge --no-edit origin/production failed (exit code 1): CONFLICT (content): Merge conflict in src/App.tsx\nAutomatic merge failed; fix conflicts and then commit the result.",
        );
      }
      commitOn(repo, `Merge branch '${reference}'`, "", [repo.head.target, target]);
      return null;
    }
    case "rebase": {
      const repo = repoAt(path);
      const onto = resolve(String(args.onto));
      const current = byId.get(repo.head.target)!;
      commitOn(repo, current.summary, current.body, [onto]);
      return null;
    }
    case "cherry_pick": {
      const picked = byId.get(String(args.id));
      if (!picked) throw gitError("fatal: bad revision");
      commitOn(repoAt(path), picked.summary, picked.body);
      return null;
    }
    case "revert": {
      const reverted = byId.get(String(args.id));
      if (!reverted) throw gitError("fatal: bad revision");
      commitOn(repoAt(path), `Revert "${reverted.summary}"`, `This reverts commit ${reverted.id}.`);
      return null;
    }
    case "abort_operation": {
      const repo = repoAt(path);
      if (repo.state === "clean") throw gitError("no merge, rebase, cherry-pick or revert is in progress");
      repo.state = "clean";
      repo.status.conflicted = [];
      return null;
    }
    case "resolve_conflict": {
      const repo = repoAt(path);
      const file = String(args.file);
      if (!repo.status.conflicted.includes(file)) throw gitError(`error: path '${file}' does not have conflicts`);
      repo.status.conflicted = repo.status.conflicted.filter((candidate) => candidate !== file);
      repo.status.staged.push({ path: file, oldPath: null, status: "modified" });
      repo.status.staged.sort((a, b) => a.path.localeCompare(b.path));
      return null;
    }
    case "continue_operation": {
      const repo = repoAt(path);
      if (repo.state === "clean") throw gitError("no merge, rebase, cherry-pick or revert is in progress");
      if (repo.status.conflicted.length > 0) throw gitError("error: Committing is not possible because you have unmerged files.");
      repo.state = "clean";
      commitOn(repo, "Merge branch 'origin/production'", "", [repo.head.target, resolve("origin/production")]);
      repo.status.staged = [];
      return null;
    }

    // stashes
    case "stash_list":
      return repoAt(path).stashes.map(({ index, message, id }) => ({ index, message, id }));
    case "stash_push": {
      const repo = repoAt(path);
      const includeUntracked = Boolean(args.includeUntracked);
      const kept = includeUntracked ? [] : repo.status.unstaged.filter((entry) => entry.status === "added");
      const saved: WorkingTreeStatus = {
        staged: repo.status.staged,
        unstaged: repo.status.unstaged.filter((entry) => !kept.includes(entry)),
        conflicted: [],
      };
      const message = String(args.message).trim() || `WIP on ${repo.head.branch ?? "HEAD"}: ${repo.head.target.slice(0, 7)}`;
      repo.stashes.unshift({ index: 0, message: `On ${repo.head.branch ?? "HEAD"}: ${message}`, id: fakeId(), saved });
      repo.stashes.forEach((stash, index) => (stash.index = index));
      repo.status = { staged: [], unstaged: kept, conflicted: [] };
      return null;
    }
    case "stash_apply":
    case "stash_pop": {
      const repo = repoAt(path);
      const stash = repo.stashes[Number(args.index)];
      if (!stash) throw gitError(`fatal: Log for 'refs/stash' only has ${repo.stashes.length} entries`);
      repo.status.staged = [...repo.status.staged, ...stash.saved.staged];
      repo.status.unstaged = [...repo.status.unstaged, ...stash.saved.unstaged];
      if (command === "stash_pop") {
        repo.stashes.splice(Number(args.index), 1);
        repo.stashes.forEach((entry, index) => (entry.index = index));
      }
      return null;
    }
    case "stash_drop": {
      const repo = repoAt(path);
      repo.stashes.splice(Number(args.index), 1);
      repo.stashes.forEach((entry, index) => (entry.index = index));
      return null;
    }

    // remotes
    case "fetch":
      return withProgress(path, "fetch").then(() => {
        fetchRemote();
        return null;
      });
    case "fetch_in_background":
      return new Promise((resolve) => setTimeout(() => resolve(fetchRemote()), 400));
    case "pull": {
      const repo = repoAt(path);
      return withProgress(path, "pull").then(() => {
        repo.behind = 0;
        return null;
      });
    }
    case "push": {
      const repo = repoAt(path);
      if (!repo.head.branch) throw gitError("HEAD is detached; check out a branch first");
      return withProgress(path, "push").then(() => {
        if (repo.head.branch === "main") {
          remoteTips.set("origin/main", repo.head.target);
          promotion = { due: Date.now() + PROMOTION_DELAY_MS, target: repo.head.target };
          startRun("CI", "push", "main", repo.head.target, ciJobs());
        }
        repo.ahead = 0;
        return null;
      });
    }
    // GitHub
    case "github_accounts":
      return accountsState();
    case "github_sign_in": {
      if (String(args.token).trim().length < 4) throw githubError("GitHub refused the request: Bad credentials (401 Unauthorized)");
      const named = String(args.token).split("@").pop();
      const account =
        GITHUB_ACCOUNTS.find((candidate) => candidate.login === named) ??
        GITHUB_ACCOUNTS.find((candidate) => refusedAccounts.has(candidate.login)) ??
        GITHUB_ACCOUNTS.find((candidate) => !connectedAccount(candidate.login)) ??
        GITHUB_ACCOUNTS[GITHUB_ACCOUNTS.length - 1];
      // Something to watch: the workflow of the last push starts as the first account connects.
      if (githubAccounts.length === 0) startRun("CI", "push", "main", resolve("origin/main"), ciJobs());
      if (!connectedAccount(account.login)) githubAccounts.push(account);
      if (String(args.token).includes("revoked")) refusedAccounts.add(account.login);
      else refusedAccounts.delete(account.login);
      githubActive = account.login;
      return account;
    }
    case "github_sign_out": {
      const index = githubAccounts.findIndex((account) => account.login === args.login);
      if (index >= 0) githubAccounts.splice(index, 1);
      refusedAccounts.delete(String(args.login));
      if (!connectedAccount(githubActive)) githubActive = githubAccounts[0]?.login ?? null;
      return accountsState();
    }
    case "github_switch_account":
      if (!connectedAccount(String(args.login))) {
        throw githubError(`\`${String(args.login)}\` is not a connected GitHub account`);
      }
      githubActive = String(args.login);
      return accountsState();
    case "github_device_available":
      return false;
    case "github_device_start":
    case "github_device_poll":
      throw githubError("GitHub sign-in is not configured for this build (no OAuth client id)");
    case "github_repositories": {
      const account = connectedAccount((args.login as string | null) ?? githubActive);
      if (!account) throw githubError("no GitHub account is connected");
      if (refusedAccounts.has(account.login)) {
        const refused: AppError = {
          kind: "tokenRefused",
          message: `GitHub no longer accepts the token of ${account.login}: connect this account again`,
        };
        throw refused;
      }
      return delayed(repositoriesOf[account.login] ?? [], 500);
    }
    case "github_repository": {
      const bound = connectedAccount(repositoryAccounts.get(path))?.login ?? null;
      return {
        repo: { owner: ownerOf(path), name: path.split("/").pop() ?? "mock-repo" },
        account: accountFor(path)?.login ?? null,
        bound,
      };
    }
    case "github_set_repository_account":
      if (args.login == null) repositoryAccounts.delete(path);
      else repositoryAccounts.set(path, String(args.login));
      return null;
    case "github_pull_requests":
      requireAccount(path);
      return delayed(pullRequests.filter((pr) => pr.state === args.itemState), 300);
    case "github_create_pull_request": {
      const author = requireAccount(path).login;
      const created: PullRequest = {
        number: nextIssueNumber++,
        title: String(args.title),
        body: String(args.body),
        state: "open",
        draft: Boolean(args.draft),
        merged: false,
        author,
        head: String(args.head),
        base: String(args.base),
        htmlUrl: `https://github.com/ada/mock-repo/pull/${nextIssueNumber - 1}`,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };
      pullRequests.unshift(created);
      return created;
    }
    case "github_issues":
      requireAccount(path);
      return delayed(issues.filter((issue) => issue.state === args.itemState), 300);
    case "github_create_issue": {
      const author = requireAccount(path).login;
      const created: Issue = {
        number: nextIssueNumber++,
        title: String(args.title),
        body: String(args.body),
        state: "open",
        author,
        labels: [],
        comments: 0,
        htmlUrl: `https://github.com/ada/mock-repo/issues/${nextIssueNumber - 1}`,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };
      issues.unshift(created);
      return created;
    }
    case "github_issue_comments":
      requireAccount(path);
      return [];
    case "github_comment_issue": {
      const author = requireAccount(path).login;
      const issue = issues.find((candidate) => candidate.number === Number(args.number));
      if (!issue) throw githubError("GitHub refused the request: Not Found (404 Not Found)");
      issue.comments += 1;
      return {
        id: Date.now(),
        author,
        body: String(args.body),
        htmlUrl: `${issue.htmlUrl}#issuecomment-${Date.now()}`,
        createdAt: Math.floor(Date.now() / 1000),
      };
    }
    case "github_close_issue": {
      requireAccount(path);
      const issue = issues.find((candidate) => candidate.number === Number(args.number));
      if (!issue) throw githubError("GitHub refused the request: Not Found (404 Not Found)");
      issue.state = "closed";
      return issue;
    }
    case "github_workflow_runs":
      requireAccount(path);
      return delayed(runPlans.slice(0, 30).map((run) => runAt(run)), 200);
    case "github_workflow_jobs": {
      requireAccount(path);
      const run = runPlans.find((candidate) => candidate.id === Number(args.run));
      if (!run) throw githubError("GitHub refused the request: Not Found (404 Not Found)");
      return delayed(jobsAt(run), 200);
    }
    // commit message assistant
    case "ai_providers":
      return [...aiKeys, "claudecode", ...(++aiLooks > 3 ? ["codex"] : [])];
    case "ai_save_key": {
      const provider = args.provider as Provider;
      if (String(args.key).trim().length < 4) {
        throw aiError(`${provider === "openai" ? "OpenAI" : "Anthropic"} refused the request (401): invalid x-api-key`);
      }
      aiKeys.add(provider);
      return delayed(aiModels[provider], 400);
    }
    case "ai_clear_key":
      aiKeys.delete(args.provider as Provider);
      return null;
    case "ai_models":
      return delayed(aiModels[args.provider as Provider], 400);
    case "ai_commit_message":
      if (args.provider === "codex") {
        return delayed(null, 800).then(() => {
          throw aiError("`codex` failed: The model is not supported when using Codex with a ChatGPT account.");
        });
      }
      if (args.provider !== "claudecode" && !aiKeys.has(args.provider as Provider)) {
        throw aiError("no API key is stored");
      }
      return delayed(suggestMessage(repoAt(path), Boolean(args.amend)), 1200);
    default:
      throw new Error(`mock backend: unknown command ${command}`);
  }
}

mockIPC(
  (command, payload) => delayed(handle(command, (payload ?? {}) as Record<string, unknown>)),
  // The mocks run the event plugin themselves, so `listen` and `emit` just work.
  { shouldMockEvents: true },
);

console.info(`[open-git] mock backend active: ${rows.length} commits, ${refs().length} refs`);
