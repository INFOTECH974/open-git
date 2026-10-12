import { type ComponentType, type ReactNode, type Ref, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleUser,
  Copy,
  ExternalLink,
  GitBranchPlus,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
} from "lucide-react";

import type { GitHubRepo, Issue, ItemState, PullRequest, WorkflowRun } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { type WorkflowRunAction, WorkflowRunsSection } from "@/components/WorkflowRunsSection";
import type { WorkflowRuns } from "@/hooks/useWorkflowRuns";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useGitHub } from "@/lib/github";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type PullRequestAction = "open" | "checkout" | "copyUrl";
export type IssueAction = "open" | "branch" | "comment" | "close" | "copyUrl";

interface Props {
  repoPath: string;
  /** Whether this repository's tab is the one shown. */
  active: boolean;
  /** Bumped by the parent after an action, so the lists reload. */
  version: number;
  busy: boolean;
  workflows: WorkflowRuns;
  /** Set on the workflow runs, so the top of the panel can scroll to them. */
  workflowsRef?: Ref<HTMLElement>;
  onCreatePullRequest(): void;
  onCreateIssue(): void;
  onPullRequestAction(action: PullRequestAction, pullRequest: PullRequest): void;
  onIssueAction(action: IssueAction, issue: Issue): void;
  onWorkflowRunAction(action: WorkflowRunAction, run: WorkflowRun): void;
  onOpenUrl(url: string): void;
}

/**
 * Workflow runs, pull requests and issues of the repository behind `origin`,
 * when it is on GitHub.
 */
export function ForgePanel({
  repoPath,
  active,
  version,
  busy,
  workflows,
  workflowsRef,
  onCreatePullRequest,
  onCreateIssue,
  onPullRequestAction,
  onIssueAction,
  onWorkflowRunAction,
  onOpenUrl,
}: Props) {
  const { t } = useI18n();
  const github = useGitHub();
  const [repo, setRepo] = useState<GitHubRepo | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api.githubRepository(repoPath).then(
      (found) => {
        if (!cancelled) setRepo(found);
      },
      () => {
        if (!cancelled) setRepo(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  if (repo === undefined || repo === null) return null;

  if (!github.account) {
    return (
      <section className="mt-2 border-t px-3 py-3">
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">
            {repo.owner}/{repo.name}
          </code>{" "}
          {t("is on GitHub.")}
        </p>
        <Button
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={github.openDialog}
          disabled={github.loading}
        >
          <CircleUser />
          {t("Connect your GitHub account")}
        </Button>
      </section>
    );
  }

  return (
    <div className="mt-2 border-t pt-1">
      <WorkflowRunsSection
        repoPath={repoPath}
        active={active}
        workflows={workflows}
        sectionRef={workflowsRef}
        onRunAction={onWorkflowRunAction}
        onOpenUrl={onOpenUrl}
      />
      <ForgeSection<PullRequest>
        title={t("Pull requests")}
        icon={GitPullRequest}
        load={(state) => api.githubPullRequests(repoPath, state)}
        version={version}
        busy={busy}
        onCreate={onCreatePullRequest}
        createLabel={t("New pull request")}
        render={(pullRequest) => (
          <ForgeItem
            key={pullRequest.number}
            icon={pullRequestIcon(pullRequest)}
            number={pullRequest.number}
            title={pullRequest.title}
            subtitle={`${pullRequest.author} · ${pullRequest.head} → ${pullRequest.base} · ${relativeTime(pullRequest.updatedAt)}`}
            menu={
              <ContextMenuContent className="w-60">
                <ContextMenuItem onSelect={() => onPullRequestAction("open", pullRequest)}>
                  <ExternalLink />
                  {t("Open on GitHub")}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={busy}
                  onSelect={() => onPullRequestAction("checkout", pullRequest)}
                >
                  <GitPullRequest />
                  <span className="truncate">
                    {t("Check out")} <code className="font-mono">{pullRequest.head}</code>
                  </span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onPullRequestAction("copyUrl", pullRequest)}>
                  <Copy />
                  {t("Copy link")}
                </ContextMenuItem>
              </ContextMenuContent>
            }
          />
        )}
      />
      <ForgeSection<Issue>
        title={t("Issues")}
        icon={CircleDot}
        load={(state) => api.githubIssues(repoPath, state)}
        version={version}
        busy={busy}
        onCreate={onCreateIssue}
        createLabel={t("New issue")}
        render={(issue) => (
          <ForgeItem
            key={issue.number}
            icon={issue.state === "open" ? CircleDot : CircleCheck}
            iconClass={issue.state === "open" ? "text-emerald-500" : "text-violet-500"}
            number={issue.number}
            title={issue.title}
            subtitle={`${issue.author} · ${relativeTime(issue.updatedAt)}${
              issue.comments ? ` · ${t("{n} comments", { n: issue.comments })}` : ""
            }`}
            labels={issue.labels}
            menu={
              <ContextMenuContent className="w-64">
                <ContextMenuItem onSelect={() => onIssueAction("open", issue)}>
                  <ExternalLink />
                  {t("Open on GitHub")}
                </ContextMenuItem>
                <ContextMenuItem disabled={busy} onSelect={() => onIssueAction("branch", issue)}>
                  <GitBranchPlus />
                  {t("Create a branch for this issue…")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onIssueAction("comment", issue)}>
                  <MessageSquare />
                  {t("Comment…")}
                </ContextMenuItem>
                {issue.state === "open" && (
                  <ContextMenuItem onSelect={() => onIssueAction("close", issue)}>
                    <CircleCheck />
                    {t("Close…")}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onIssueAction("copyUrl", issue)}>
                  <Copy />
                  {t("Copy link")}
                </ContextMenuItem>
              </ContextMenuContent>
            }
          />
        )}
      />
    </div>
  );
}

function pullRequestIcon(pullRequest: PullRequest): ComponentType<{ className?: string }> {
  if (pullRequest.merged) return GitMerge;
  if (pullRequest.state === "closed") return GitPullRequestClosed;
  if (pullRequest.draft) return GitPullRequestDraft;
  return GitPullRequest;
}

interface SectionProps<T> {
  title: string;
  icon: ComponentType<{ className?: string }>;
  load(state: ItemState): Promise<T[]>;
  version: number;
  busy: boolean;
  createLabel: string;
  onCreate(): void;
  render(item: T): ReactNode;
}

function ForgeSection<T>({ title, icon: Icon, load, version, busy, createLabel, onCreate, render }: SectionProps<T>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<ItemState>("open");
  const [items, setItems] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    load(state).then(
      (loaded) => {
        if (cancelled) return;
        setItems(loaded);
        setError(null);
        setLoading(false);
      },
      (failure) => {
        if (cancelled) return;
        setError(errorMessage(failure));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure on each render; the inputs that matter are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state, version, reloads]);

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="mb-1">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <Chevron className="size-3.5" aria-hidden />
          <Icon className="size-3.5" aria-hidden />
          <span className="truncate">{title}</span>
          {items && <span className="ml-auto tabular-nums">{items.length}</span>}
        </button>
        {open && (
          <>
            <div role="radiogroup" className="flex rounded border p-px text-[10px]" aria-label={`${title}`}>
              {(["open", "closed"] as ItemState[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={state === option}
                  className={cn(
                    "rounded-sm px-1.5 py-px",
                    state === option ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setState(option)}
                >
                  {option === "open" ? t("Open") : t("Closed")}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={t("Reload")}
              onClick={() => setReloads((value) => value + 1)}
            >
              {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={createLabel}
              title={createLabel}
              disabled={busy}
              onClick={onCreate}
            >
              <Plus />
            </Button>
          </>
        )}
      </div>
      {open && (
        <ul>
          {error && <li className="px-7 py-1 text-xs text-destructive">{error}</li>}
          {items?.map(render)}
          {items && items.length === 0 && !error && (
            <li className="px-7 py-1 text-xs text-muted-foreground">{t("None")}</li>
          )}
        </ul>
      )}
    </section>
  );
}

interface ItemProps {
  icon: ComponentType<{ className?: string }>;
  iconClass?: string;
  number: number;
  title: string;
  subtitle: string;
  labels?: { name: string; color: string }[];
  menu: ReactNode;
}

function ForgeItem({ icon: Icon, iconClass, number, title, subtitle, labels, menu }: ItemProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-start gap-2 py-1 pr-2 pl-3 text-left select-none hover:bg-muted/60" title={title}>
          <Icon className={cn("mt-0.5 size-3.5 shrink-0", iconClass ?? "text-muted-foreground")} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">
              <span className="text-muted-foreground">#{number}</span> {title}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
            {labels && labels.length > 0 && (
              <p className="mt-0.5 flex flex-wrap gap-1">
                {labels.map((label) => (
                  <span
                    key={label.name}
                    className="rounded-full border px-1.5 text-[10px] leading-4"
                    style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}
                  >
                    {label.name}
                  </span>
                ))}
              </p>
            )}
          </div>
        </li>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}
