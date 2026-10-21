import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Ban, CircleAlert, GitBranch, GitMerge, LoaderCircle, Play } from "lucide-react";

import type {
  CommitDetails,
  ConflictSide,
  FileChange,
  FileContents,
  FileDiff,
  GraphRow,
  Issue,
  PullRequest,
  RefInfo,
  RepoInfo,
  StashEntry,
  StatusEntry,
  WorkflowRun,
} from "@/bindings";
import { CommitDetailsPanel } from "@/components/CommitDetailsPanel";
import {
  type CommitAction,
  CommitGraph,
  type ScrollRequest,
  type Selection,
} from "@/components/CommitGraph";
import { type Confirmation, ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { FormDialog, type FormRequest } from "@/components/dialogs/FormDialog";
import { ErrorBanner } from "@/components/ErrorBanner";
import { FileDiffView } from "@/components/FileDiffView";
import { ForgePanel, type IssueAction, type PullRequestAction } from "@/components/ForgePanel";
import {
  type RefAction,
  RefsPanel,
  type StashAction,
  refFromDragId,
} from "@/components/RefsPanel";
import { RepoHeader } from "@/components/RepoHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { WorkflowRunAction } from "@/components/WorkflowRunsSection";
import { WorkInProgressPanel } from "@/components/WorkInProgressPanel";
import { isClean, useRepository } from "@/hooks/useRepository";
import { useWorkflowRuns } from "@/hooks/useWorkflowRuns";
import { api, errorMessage } from "@/lib/api";
import { shortId } from "@/lib/format";
import { branchNameForIssue, useRepositoryLink } from "@/lib/github";
import { useI18n } from "@/lib/i18n";

type DiffTarget =
  | { kind: "commit"; commitId: string; file: FileChange }
  | { kind: "worktree"; entry: StatusEntry; staged: boolean };

interface Props {
  info: RepoInfo;
  /** Only the visible tab listens to keyboard shortcuts. */
  active: boolean;
}

const LAYOUT_KEY = "open-git.layout";

function loadLayout(): Record<string, number> | undefined {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : undefined;
  } catch {
    return undefined;
  }
}

const OPERATION_LABELS: Record<string, string> = {
  merge: "A merge is in progress",
  rebase: "A rebase is in progress",
  cherryPick: "A cherry-pick is in progress",
  revert: "A revert is in progress",
  bisect: "A bisect is in progress",
  other: "An operation is in progress",
};

/** Everything about one open repository: refs, graph, details, diffs, actions. */
export function RepositoryView({ info, active }: Props) {
  const { t } = useI18n();
  const repo = useRepository(info, active);
  const path = repo.info.path;
  const headTarget = repo.info.head.target;
  const busy = repo.operation !== null;

  const [selection, setSelection] = useState<Selection | null>(
    info.head.target ? { kind: "commit", id: info.head.target } : null,
  );
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [form, setForm] = useState<FormRequest | null>(null);
  const [layout] = useState(loadLayout);
  // A branch dragged onto another: what to do with them is asked in a dialog.
  const [dragging, setDragging] = useState<RefInfo | null>(null);
  const [dropRequest, setDropRequest] = useState<{ source: RefInfo; target: RefInfo } | null>(null);
  // A small distance keeps clicks and double-clicks from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const select = useCallback((next: Selection, scroll = false) => {
    setSelection(next);
    setDiffTarget(null);
    if (scroll && next.kind === "commit") {
      const { id } = next;
      setScrollRequest((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
    }
  }, []);

  // Show the uncommitted changes first when the repository opens with some.
  const statusSeen = useRef(false);
  useEffect(() => {
    if (statusSeen.current || repo.status === null) return;
    statusSeen.current = true;
    if (!isClean(repo.status)) select({ kind: "wip" });
  }, [repo.status, select]);

  // Once everything is committed, move on to the new HEAD.
  useEffect(() => {
    if (selection?.kind === "wip" && repo.status !== null && isClean(repo.status)) {
      if (headTarget) select({ kind: "commit", id: headTarget }, true);
      else setSelection(null);
    }
  }, [selection, repo.status, headTarget, select]);

  // After a checkout, pull or commit the branch tip moved: follow it.
  const previousHead = useRef(headTarget);
  useEffect(() => {
    if (previousHead.current === headTarget) return;
    previousHead.current = headTarget;
    if (headTarget && selection?.kind !== "wip") select({ kind: "commit", id: headTarget }, true);
  }, [headTarget, selection, select]);

  // Details follow the selected commit (and reload when the repository is refreshed).
  const commitId = selection?.kind === "commit" ? selection.id : null;
  useEffect(() => {
    if (!commitId) {
      setDetails(null);
      setDetailsError(null);
      return;
    }
    let cancelled = false;
    setDetailsLoading(true);
    api.commitDetails(path, commitId).then(
      (loaded) => {
        if (cancelled) return;
        setDetails(loaded);
        setDetailsError(null);
        setDetailsLoading(false);
      },
      (failure) => {
        if (cancelled) return;
        setDetails(null);
        setDetailsError(errorMessage(failure));
        setDetailsLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, commitId, repo.info]);

  // The diff (by hunk) and both sides of the file follow the chosen file;
  // working tree diffs reload with the status.
  useEffect(() => {
    if (!diffTarget) {
      setDiff(null);
      setContents(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    const requests =
      diffTarget.kind === "commit"
        ? Promise.all([
            api.commitFileDiff(path, diffTarget.commitId, diffTarget.file.path),
            api.commitFileContents(path, diffTarget.commitId, diffTarget.file.path, diffTarget.file.oldPath),
          ])
        : Promise.all([
            api.workdirFileDiff(path, diffTarget.entry.path, diffTarget.entry.oldPath, diffTarget.staged),
            api.workdirFileContents(path, diffTarget.entry.path, diffTarget.entry.oldPath, diffTarget.staged),
          ]);
    requests.then(
      ([loadedDiff, loadedContents]) => {
        if (cancelled) return;
        setDiff(loadedDiff);
        setContents(loadedContents);
        setDiffError(null);
        setDiffLoading(false);
      },
      (failure) => {
        if (cancelled) return;
        setDiff(null);
        setContents(null);
        setDiffError(errorMessage(failure));
        setDiffLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, diffTarget, repo.status]);

  // A working tree file that left its list (staged, unstaged, committed) closes its diff.
  useEffect(() => {
    if (diffTarget?.kind !== "worktree" || repo.status === null) return;
    const list = diffTarget.staged ? repo.status.staged : repo.status.unstaged;
    if (!list.some((entry) => entry.path === diffTarget.entry.path)) setDiffTarget(null);
  }, [diffTarget, repo.status]);

  const closeDiff = useCallback(() => setDiffTarget(null), []);

  useEffect(() => {
    if (!active || !diffTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDiff();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, diffTarget, closeDiff]);

  // ---- actions --------------------------------------------------------------

  const { run, report } = repo;
  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const code = (text: string) => <code className="font-mono">{text}</code>;

  const stage = useCallback(
    (entries: StatusEntry[]) => run("stage", () => api.stageFiles(path, pathsOf(entries)), "status"),
    [run, path],
  );
  const unstage = useCallback(
    (entries: StatusEntry[]) =>
      run("stage", () => api.unstageFiles(path, pathsOf(entries)), "status"),
    [run, path],
  );
  const commit = useCallback(
    (message: string, amend: boolean) => run("commit", () => api.commit(path, message, amend)),
    [run, path],
  );

  const discard = (entries: StatusEntry[]) =>
    setConfirmation({
      title:
        entries.length === 1
          ? t("Discard the changes to {path}?", { path: entries[0].path })
          : t("Discard {n} files?", { n: entries.length }),
      description: t(
        "Tracked files go back to their staged content and untracked files are deleted. This cannot be undone.",
      ),
      action: t("Discard"),
      destructive: true,
      onConfirm: () => void run("stage", () => api.discardFiles(path, pathsOf(entries)), "status"),
    });

  const discardAll = () =>
    setConfirmation({
      title: t("Discard every unstaged change?"),
      description: t(
        "Tracked files go back to their staged content and untracked files are deleted. This cannot be undone.",
      ),
      action: t("Discard all"),
      destructive: true,
      onConfirm: () => void run("stage", () => api.discardAll(path), "status"),
    });

  /** Asks for a remote; with `thenPush`, the current branch is pushed to it right after. */
  const addRemote = (thenPush: boolean) => {
    const branch = repo.info.head.branch;
    const taken = repo.info.remotes;
    setForm({
      title: t("Add a remote"),
      description:
        thenPush && branch
          ? t("This repository has no remote yet. {branch} is pushed to it right after.", { branch })
          : t("Where this repository fetches from and pushes to. Nothing is sent until you push."),
      fields: [
        {
          key: "name",
          label: t("Name"),
          type: "text",
          required: true,
          mono: true,
          initial: taken.includes("origin") ? "" : "origin",
        },
        {
          key: "url",
          label: t("URL"),
          type: "text",
          required: true,
          mono: true,
          placeholder: "https://github.com/owner/repo.git",
        },
      ],
      action: thenPush ? t("Add and push") : t("Add"),
      onSubmit: (values) => {
        const add = () => api.addRemote(path, String(values.name), String(values.url));
        if (thenPush) {
          void run("push", async () => {
            await add();
            await api.push(path);
          });
        } else {
          void run("remote", add);
        }
      },
    });
  };

  const stash = () =>
    setForm({
      title: t("Stash the changes"),
      description: t("Saves the working tree and the index aside, and restores the last commit."),
      fields: [
        { key: "message", label: t("Message"), type: "text", placeholder: t("Optional description") },
        { key: "untracked", label: t("Include untracked files"), type: "checkbox", initial: true },
      ],
      action: t("Stash"),
      onSubmit: (values) =>
        void run("stash", () => api.stashPush(path, String(values.message), Boolean(values.untracked))),
    });

  const createBranchAt = (startPoint: string, label: string) =>
    setForm({
      title: t("Create a branch"),
      description: t("Starting at {label}.", { label }),
      fields: [
        { key: "name", label: t("Name"), type: "text", required: true, mono: true, placeholder: "feature/…" },
        { key: "checkout", label: t("Check it out"), type: "checkbox", initial: true },
      ],
      action: t("Create"),
      onSubmit: (values) =>
        void run("branch", () =>
          api.createBranch(path, String(values.name), startPoint, Boolean(values.checkout)),
        ),
    });

  const createTagAt = (target: string, label: string) =>
    setForm({
      title: t("Create a tag"),
      description: t("On {label}.", { label }),
      fields: [
        { key: "name", label: t("Name"), type: "text", required: true, mono: true, placeholder: "v1.0.0" },
        {
          key: "message",
          label: t("Message (annotated tag when given)"),
          type: "textarea",
          placeholder: t("Release notes…"),
        },
      ],
      action: t("Create"),
      onSubmit: (values) =>
        void run("branch", () =>
          api.createTag(path, String(values.name), target, String(values.message) || null),
        ),
    });

  const deleteBranch = (reference: RefInfo, force: boolean) =>
    run("branch", () => api.deleteBranch(path, reference.name, force)).then((ok) => {
      if (ok || force) return;
      // git refuses to drop unmerged work with `-d`; offer `-D`.
      setConfirmation({
        title: t("{name} is not fully merged", { name: reference.name }),
        description: (
          <>
            {t("Its commits are not reachable from another branch. Delete")} {code(reference.name)}{" "}
            {t("anyway and lose them?")}
          </>
        ),
        action: t("Delete anyway"),
        destructive: true,
        onConfirm: () => void deleteBranch(reference, true),
      });
    });

  const resolveConflict = (file: string, side: ConflictSide) =>
    void run("stage", () => api.resolveConflict(path, file, side), "status");

  const onDragStart = (event: DragStartEvent) =>
    setDragging(refFromDragId(String(event.active.id), repo.refs) ?? null);

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    if (!event.over || event.over.id === event.active.id) return;
    const source = refFromDragId(String(event.active.id), repo.refs);
    const target = refFromDragId(String(event.over.id), repo.refs);
    if (source && target) setDropRequest({ source, target });
  };

  /** Checks `target` out when needed, then merges `source` into it. */
  const mergeInto = (source: RefInfo, target: RefInfo) =>
    run("merge", async () => {
      if (!(target.kind === "localBranch" && target.name === repo.info.head.branch)) {
        await api.checkout(path, target.name, target.kind);
      }
      await api.merge(path, source.name);
    });

  /** Checks `source` out when needed, then rebases it onto `target`. */
  const rebaseOnto = (source: RefInfo, target: RefInfo) =>
    run("merge", async () => {
      if (!(source.kind === "localBranch" && source.name === repo.info.head.branch)) {
        await api.checkout(path, source.name, source.kind);
      }
      await api.rebase(path, target.name);
    });

  // ---- GitHub -------------------------------------------------------------

  const [forgeVersion, setForgeVersion] = useState(0);
  /** Runs a GitHub call outside `run` (it does not change the repository), then reloads the lists. */
  const forgeAction = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setForgeVersion((value) => value + 1);
    } catch (failure) {
      report(failure);
    }
  };

  const createPullRequest = () => {
    const head = repo.info.head.branch;
    if (!head) {
      report(new Error(t("Check out a branch before opening a pull request.")));
      return;
    }
    const base = repo.refs.some((reference) => reference.kind === "localBranch" && reference.name === "main")
      ? "main"
      : "master";
    setForm({
      title: t("New pull request"),
      description: t("From {head}. The branch is pushed first when it has no upstream yet.", { head }),
      fields: [
        { key: "title", label: t("Title"), type: "text", required: true },
        { key: "body", label: t("Description"), type: "textarea", placeholder: t("What and why…") },
        { key: "base", label: t("Into branch"), type: "text", required: true, mono: true, initial: base },
        { key: "draft", label: t("Open as a draft"), type: "checkbox" },
      ],
      action: t("Create pull request"),
      onSubmit: (values) =>
        void forgeAction(async () => {
          if (!repo.info.head.upstream) await run("push", () => api.push(path));
          const created = await api.githubCreatePullRequest(
            path,
            String(values.title),
            String(values.body),
            head,
            String(values.base),
            Boolean(values.draft),
          );
          void openUrl(created.htmlUrl).catch(() => {});
        }),
    });
  };

  const createIssue = () =>
    setForm({
      title: t("New issue"),
      fields: [
        { key: "title", label: t("Title"), type: "text", required: true },
        { key: "body", label: t("Description"), type: "textarea" },
      ],
      action: t("Create issue"),
      onSubmit: (values) =>
        void forgeAction(() => api.githubCreateIssue(path, String(values.title), String(values.body))),
    });

  const onPullRequestAction = (action: PullRequestAction, pullRequest: PullRequest) => {
    switch (action) {
      case "open":
        void openUrl(pullRequest.htmlUrl).catch(report);
        break;
      case "copyUrl":
        copy(pullRequest.htmlUrl);
        break;
      case "checkout": {
        const local = repo.refs.find(
          (reference) => reference.kind === "localBranch" && reference.name === pullRequest.head,
        );
        const remote = repo.refs.find(
          (reference) => reference.kind === "remoteBranch" && reference.name.endsWith(`/${pullRequest.head}`),
        );
        const target = local ?? remote;
        if (!target) {
          report(
            new Error(
              t("Branch {name} is not known locally; fetch first (or it lives in a fork).", {
                name: pullRequest.head,
              }),
            ),
          );
          return;
        }
        void run("checkout", () => api.checkout(path, target.name, target.kind));
      }
    }
  };

  // A push or a fetch that moves a remote branch is when GitHub starts workflows.
  const remoteTips = useMemo(
    () =>
      repo.refs
        .filter((reference) => reference.kind === "remoteBranch")
        .map((reference) => `${reference.name}@${reference.target}`)
        .join(" "),
    [repo.refs],
  );
  const forge = useRepositoryLink(path, repo.info.remotes);
  // An account whose token GitHub refuses has nothing to show.
  const workflows = useWorkflowRuns(
    path,
    active,
    remoteTips,
    forge.refused ? null : (forge.account?.login ?? null),
  );
  const workflowsRef = useRef<HTMLElement>(null);
  const openOnGitHub = (url: string) => void openUrl(url).catch(report);

  const onWorkflowRunAction = (action: WorkflowRunAction, run: WorkflowRun) => {
    switch (action) {
      case "open":
        openOnGitHub(run.htmlUrl);
        break;
      case "copyUrl":
        copy(run.htmlUrl);
        break;
      case "showCommit":
        api.commitIndex(path, run.commit).then((index) => {
          if (index !== null) {
            select({ kind: "commit", id: run.commit }, true);
            return;
          }
          report(
            new Error(
              t("Commit {id} is not in the local history; fetch first.", { id: shortId(run.commit) }),
            ),
          );
        }, report);
    }
  };

  const onIssueAction = (action: IssueAction, issue: Issue) => {
    switch (action) {
      case "open":
        void openUrl(issue.htmlUrl).catch(report);
        break;
      case "copyUrl":
        copy(issue.htmlUrl);
        break;
      case "branch":
        setForm({
          title: t("Branch for #{n}", { n: issue.number }),
          description: issue.title,
          fields: [
            {
              key: "name",
              label: t("Name"),
              type: "text",
              required: true,
              mono: true,
              initial: branchNameForIssue(issue.number, issue.title),
            },
            { key: "checkout", label: t("Check it out"), type: "checkbox", initial: true },
          ],
          action: t("Create"),
          onSubmit: (values) =>
            void run("branch", () =>
              api.createBranch(path, String(values.name), "HEAD", Boolean(values.checkout)),
            ),
        });
        break;
      case "comment":
        setForm({
          title: t("Comment on #{n}", { n: issue.number }),
          description: issue.title,
          fields: [{ key: "body", label: t("Comment"), type: "textarea", placeholder: t("Markdown is fine.") }],
          action: t("Comment"),
          onSubmit: (values) => {
            const body = String(values.body).trim();
            if (body) void forgeAction(() => api.githubCommentIssue(path, issue.number, body));
          },
        });
        break;
      case "close":
        setConfirmation({
          title: t("Close #{n}?", { n: issue.number }),
          description: issue.title,
          action: t("Close the issue"),
          onConfirm: () => void forgeAction(() => api.githubCloseIssue(path, issue.number)),
        });
    }
  };

  const onRefAction = (action: RefAction, reference: RefInfo) => {
    const current = repo.info.head.branch ?? "HEAD";
    switch (action) {
      case "checkout":
        void run("checkout", () => api.checkout(path, reference.name, reference.kind));
        break;
      case "createBranch":
        createBranchAt(reference.name, reference.name);
        break;
      case "rename":
        setForm({
          title: t("Rename {name}", { name: reference.name }),
          fields: [
            { key: "name", label: t("New name"), type: "text", required: true, mono: true, initial: reference.name },
          ],
          action: t("Rename"),
          onSubmit: (values) =>
            void run("branch", () => api.renameBranch(path, reference.name, String(values.name))),
        });
        break;
      case "delete":
        setConfirmation({
          title: t("Delete {name}?", { name: reference.name }),
          description: (
            <>
              {t("The local branch")} {code(reference.name)} {t("will be removed.")}
            </>
          ),
          action: t("Delete"),
          destructive: true,
          onConfirm: () => void deleteBranch(reference, false),
        });
        break;
      case "push":
        void run("push", () => api.pushBranch(path, reference.name, null));
        break;
      case "setUpstream":
        setForm({
          title: t("Upstream of {name}", { name: reference.name }),
          fields: [
            {
              key: "upstream",
              label: t("Remote branch"),
              type: "text",
              required: true,
              mono: true,
              initial: `${repo.info.remotes[0] ?? "origin"}/${reference.name}`,
            },
          ],
          action: t("Set upstream"),
          onSubmit: (values) =>
            void run("branch", () => api.setUpstream(path, reference.name, String(values.upstream))),
        });
        break;
      case "merge":
        void run("merge", () => api.merge(path, reference.name));
        break;
      case "rebase":
        setConfirmation({
          title: t("Rebase {current} onto {name}?", { current, name: reference.name }),
          description: (
            <>
              {t("The commits of")} {code(current)} {t("that are not on")} {code(reference.name)}{" "}
              {t("will be rewritten on top of it.")}
            </>
          ),
          action: t("Rebase"),
          onConfirm: () => void run("merge", () => api.rebase(path, reference.name)),
        });
        break;
      case "deleteRemote":
        setConfirmation({
          title: t("Delete {name} on the remote?", { name: reference.name }),
          description: t("The branch will be removed from the remote for everyone."),
          action: t("Delete on the remote"),
          destructive: true,
          onConfirm: () => void run("push", () => api.deleteRemoteBranch(path, reference.name)),
        });
        break;
      case "deleteTag":
        setConfirmation({
          title: t("Delete tag {name}?", { name: reference.name }),
          description: t("Only the local tag is removed; a pushed tag stays on the remote."),
          action: t("Delete"),
          destructive: true,
          onConfirm: () => void run("branch", () => api.deleteTag(path, reference.name)),
        });
        break;
      case "copyName":
        copy(reference.name);
        break;
    }
  };

  const onStashAction = (action: StashAction, entry: StashEntry) => {
    switch (action) {
      case "apply":
        void run("stash", () => api.stashApply(path, entry.index));
        break;
      case "pop":
        void run("stash", () => api.stashPop(path, entry.index));
        break;
      case "drop":
        setConfirmation({
          title: t("Drop this stash?"),
          description: <>{entry.message} {t("will be lost.")}</>,
          action: t("Drop"),
          destructive: true,
          onConfirm: () => void run("stash", () => api.stashDrop(path, entry.index)),
        });
    }
  };

  const onCommitAction = (action: CommitAction, row: GraphRow) => {
    const label = `${shortId(row.id)} (${row.summary})`;
    switch (action) {
      case "checkout":
        void run("checkout", () => api.checkoutCommit(path, row.id));
        break;
      case "createBranch":
        createBranchAt(row.id, label);
        break;
      case "createTag":
        createTagAt(row.id, label);
        break;
      case "cherryPick":
        void run("merge", () => api.cherryPick(path, row.id));
        break;
      case "revert":
        setConfirmation({
          title: t("Revert {id}?", { id: shortId(row.id) }),
          description: t("A new commit undoing “{summary}” will be added to the current branch.", {
            summary: row.summary,
          }),
          action: t("Revert"),
          onConfirm: () => void run("merge", () => api.revert(path, row.id)),
        });
        break;
      case "copyId":
        copy(row.id);
        break;
      case "copySummary":
        copy(row.summary);
        break;
    }
  };

  const openCommitFile = useCallback(
    (file: FileChange) => {
      if (details) setDiffTarget({ kind: "commit", commitId: details.id, file });
    },
    [details],
  );
  const openWorktreeFile = useCallback(
    (entry: StatusEntry, staged: boolean) => setDiffTarget({ kind: "worktree", entry, staged }),
    [],
  );

  const hunkAction =
    diffTarget?.kind === "worktree"
      ? {
          label: diffTarget.staged ? ("Unstage hunk" as const) : ("Stage hunk" as const),
          disabled: busy,
          onClick: (hunk: number) =>
            void run(
              "stage",
              () =>
                diffTarget.staged
                  ? api.unstageHunk(path, diffTarget.entry.path, diffTarget.entry.oldPath, hunk)
                  : api.stageHunk(path, diffTarget.entry.path, diffTarget.entry.oldPath, hunk),
              "status",
            ),
        }
      : undefined;

  const state = repo.info.state;

  return (
    <div className="flex h-full flex-col">
      {repo.error && <ErrorBanner message={repo.error} onDismiss={repo.clearError} />}
      {state !== "clean" && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm">
          <CircleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {t(OPERATION_LABELS[state] ?? OPERATION_LABELS.other)}.{" "}
            {repo.status?.conflicted.length
              ? t("Resolve the conflicts, mark them as resolved, then continue.")
              : t("Continue to finish it, or abort to go back.")}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || (repo.status?.conflicted.length ?? 0) > 0}
            onClick={() => void run("merge", () => api.continueOperation(path))}
          >
            {repo.operation === "merge" ? <LoaderCircle className="animate-spin" /> : <Play />}
            {t("Continue")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              setConfirmation({
                title: t("Abort the operation?"),
                description: t("The repository goes back to its state before the operation started."),
                action: t("Abort"),
                destructive: true,
                onConfirm: () => void run("merge", () => api.abortOperation(path)),
              })
            }
          >
            <Ban />
            {t("Abort")}
          </Button>
        </div>
      )}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout}
        onLayoutChanged={(next) => {
          try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
          } catch {
            // Storage may be unavailable; the layout then lasts for this session.
          }
        }}
      >
        <ResizablePanel id="refs" defaultSize="18%" minSize={180}>
          <aside className="flex h-full flex-col border-r">
            <RepoHeader
              info={repo.info}
              operation={repo.operation}
              progress={repo.progress}
              checks={headTarget ? workflows.byCommit.get(headTarget) : undefined}
              onShowChecks={() =>
                workflowsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
              }
              onRefresh={() => void repo.refresh()}
              onFetch={() => void run("fetch", () => api.fetch(path))}
              onPull={() => void run("pull", () => api.pull(path))}
              onPush={() => {
                // Nowhere to push yet: ask for a remote, then push there.
                if (repo.info.remotes.length === 0) addRemote(true);
                else void run("push", () => api.push(path));
              }}
              onCancel={repo.cancel}
            />
            <div className="min-h-0 flex-1">
              <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
                <RefsPanel
                  refs={repo.refs}
                  stashes={repo.stashes}
                  head={repo.info.head}
                  remotes={repo.info.remotes}
                  selectedId={commitId}
                  busy={busy}
                  onSelect={(id) => select({ kind: "commit", id }, true)}
                  onRefAction={onRefAction}
                  onStashAction={onStashAction}
                  onAddRemote={() => addRemote(false)}
                >
                  <ForgePanel
                    repoPath={path}
                    forge={forge}
                    onChooseAccount={(login) => void forge.setAccount(login).catch(report)}
                    active={active}
                    version={forgeVersion}
                    busy={busy}
                    workflows={workflows}
                    workflowsRef={workflowsRef}
                    onCreatePullRequest={createPullRequest}
                    onCreateIssue={createIssue}
                    onPullRequestAction={onPullRequestAction}
                    onIssueAction={onIssueAction}
                    onWorkflowRunAction={onWorkflowRunAction}
                    onOpenUrl={openOnGitHub}
                  />
                </RefsPanel>
                <DragOverlay dropAnimation={null}>
                  {dragging && (
                    <div className="inline-flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs shadow-md">
                      <GitBranch className="size-3.5 text-muted-foreground" aria-hidden />
                      {dragging.name}
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            </div>
          </aside>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="center" minSize={320}>
          <main className="h-full min-w-0">
            {diffTarget ? (
              <FileDiffView
                file={diffTarget.kind === "commit" ? diffTarget.file : diffTarget.entry}
                context={
                  diffTarget.kind === "commit" ? (
                    <>
                      {t("in")} <code className="font-mono">{shortId(diffTarget.commitId)}</code>
                    </>
                  ) : diffTarget.staged ? (
                    t("staged")
                  ) : (
                    t("unstaged")
                  )
                }
                diff={diff}
                contents={contents}
                loading={diffLoading}
                error={diffError}
                hunkAction={hunkAction}
                modeKey={diffTarget.kind}
                onClose={closeDiff}
              />
            ) : (
              <CommitGraph
                repo={repo}
                checks={workflows.byCommit}
                selection={selection}
                scrollRequest={scrollRequest}
                onSelect={(next) => select(next)}
                onCommitAction={onCommitAction}
              />
            )}
          </main>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="details" defaultSize="26%" minSize={260}>
          <aside className="h-full border-l">
            {selection?.kind === "wip" && repo.status ? (
              <WorkInProgressPanel
                repoPath={path}
                status={repo.status}
                operation={repo.operation}
                openFile={
                  diffTarget?.kind === "worktree"
                    ? { path: diffTarget.entry.path, staged: diffTarget.staged }
                    : null
                }
                author={repo.info.author}
                headId={headTarget}
                onStage={(entries) => void stage(entries)}
                onUnstage={(entries) => void unstage(entries)}
                onStageAll={() => void run("stage", () => api.stageAll(path), "status")}
                onUnstageAll={() => void run("stage", () => api.unstageAll(path), "status")}
                onDiscard={discard}
                onDiscardAll={discardAll}
                onIgnore={(patterns) => void run("stage", () => api.ignore(path, patterns), "status")}
                onOpenInEditor={(file) => api.openInEditor(path, file).catch(report)}
                onReveal={(file) => api.revealInFileManager(path, file).catch(report)}
                onStash={stash}
                onOpenFile={openWorktreeFile}
                onResolveConflict={resolveConflict}
                onCommit={commit}
              />
            ) : (
              <CommitDetailsPanel
                details={details}
                loading={detailsLoading}
                error={detailsError}
                refs={details ? (repo.refsByCommit.get(details.id) ?? []) : []}
                checks={details ? workflows.byCommit.get(details.id) : undefined}
                headBranch={repo.info.head.branch}
                openFile={diffTarget?.kind === "commit" ? diffTarget.file.path : null}
                onSelectCommit={(id) => select({ kind: "commit", id }, true)}
                onOpenFile={openCommitFile}
                onOpenRun={(run) => openOnGitHub(run.htmlUrl)}
              />
            )}
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
      <FormDialog request={form} onClose={() => setForm(null)} />
      <Dialog open={dropRequest !== null} onOpenChange={(open) => !open && setDropRequest(null)}>
        <DialogContent className="sm:max-w-md">
          {dropRequest && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <code className="font-mono">{dropRequest.source.name}</code>
                  <span className="text-muted-foreground">→</span>
                  <code className="font-mono">{dropRequest.target.name}</code>
                </DialogTitle>
                <DialogDescription>
                  {t("What should happen with these branches? The target is checked out first when needed.")}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Button
                  variant="outline"
                  className="h-auto justify-start py-2 text-left"
                  onClick={() => {
                    const request = dropRequest;
                    setDropRequest(null);
                    void mergeInto(request.source, request.target);
                  }}
                >
                  <GitMerge />
                  <span className="min-w-0">
                    <span className="block truncate">
                      {t("Merge")} <code className="font-mono">{dropRequest.source.name}</code> {t("into")}{" "}
                      <code className="font-mono">{dropRequest.target.name}</code>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("Adds a merge commit on {name}, or fast-forwards it.", { name: dropRequest.target.name })}
                    </span>
                  </span>
                </Button>
                <Button
                  variant="outline"
                  className="h-auto justify-start py-2 text-left"
                  disabled={dropRequest.source.kind !== "localBranch"}
                  onClick={() => {
                    const request = dropRequest;
                    setDropRequest(null);
                    void rebaseOnto(request.source, request.target);
                  }}
                >
                  <GitMerge />
                  <span className="min-w-0">
                    <span className="block truncate">
                      {t("Rebase")} <code className="font-mono">{dropRequest.source.name}</code> {t("onto")}{" "}
                      <code className="font-mono">{dropRequest.target.name}</code>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {dropRequest.source.kind === "localBranch"
                        ? t("Rewrites the commits of {source} on top of {target}.", {
                            source: dropRequest.source.name,
                            target: dropRequest.target.name,
                          })
                        : t("Only a local branch can be rebased.")}
                    </span>
                  </span>
                </Button>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDropRequest(null)}>
                  {t("Cancel")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Both paths of a rename, so staging or unstaging moves the whole change. */
function pathsOf(entries: StatusEntry[]): string[] {
  return entries.flatMap((entry) => (entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]));
}
