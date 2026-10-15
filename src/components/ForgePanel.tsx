import { type ComponentType, type ReactNode, type Ref, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
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
  TriangleAlert,
} from "lucide-react";

import type { Issue, ItemState, PullRequest, WorkflowRun } from "@/bindings";
import { AccountAvatar } from "@/components/AccountAvatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type WorkflowRunAction, WorkflowRunsSection } from "@/components/WorkflowRunsSection";
import type { WorkflowRuns } from "@/hooks/useWorkflowRuns";
import { api, errorMessage, isTokenRefused } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { type RepositoryLink, useGitHub } from "@/lib/github";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type PullRequestAction = "open" | "checkout" | "copyUrl";
export type IssueAction = "open" | "branch" | "comment" | "close" | "copyUrl";

interface Props {
  repoPath: string;
  /** Where the repository lives on GitHub and the account that works on it. */
  forge: RepositoryLink;
  /** Gives the repository an account of its own; `null` returns to the automatic choice. */
  onChooseAccount(login: string | null): void;
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
  forge,
  onChooseAccount,
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
  const { link, account, refused } = forge;

  if (!link) return null;

  if (!account) {
    return (
      <section className="mt-2 border-t px-3 py-3">
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">
            {link.repo.owner}/{link.repo.name}
          </code>{" "}
          {t("is on GitHub.")}
        </p>
        <Button
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={() => github.openDialog()}
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
      {github.accounts.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
              aria-label={t("GitHub account of this repository: {login}", { login: account.login })}
              title={t("GitHub account of this repository: {login}", { login: account.login })}
            >
              <AccountAvatar account={account} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{account.login}</span>
              {refused && <TriangleAlert className="size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
              <ChevronsUpDown className="size-3 shrink-0" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-72">
            <DropdownMenuLabel>{t("Account for this repository")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={link.bound ?? ""}
              onValueChange={(login) => onChooseAccount(login || null)}
            >
              <DropdownMenuRadioItem value="">
                <span className="flex min-w-0 flex-col">
                  <span>{t("Automatic")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("An account that can push to it, the active one first")}
                  </span>
                </span>
              </DropdownMenuRadioItem>
              {github.accounts.map((candidate) => (
                <DropdownMenuRadioItem key={candidate.login} value={candidate.login}>
                  <AccountAvatar account={candidate} className="size-5" />
                  <span className="truncate">{candidate.login}</span>
                  {github.refused.includes(candidate.login) && (
                    <span className="ml-auto text-xs text-amber-600 dark:text-amber-400">
                      {t("Token refused")}
                    </span>
                  )}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {refused ? (
        <div className="mx-3 my-2 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs">
          <p className="flex gap-1.5 font-medium">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            {t("GitHub no longer accepts the token of {login}.", { login: account.login })}
          </p>
          <p className="text-muted-foreground">
            {t("It was revoked or has expired. Connect this account again to see the workflow runs, pull requests and issues.")}
          </p>
          <Button
            variant="outline"
            size="xs"
            className="max-w-full"
            title={t("Connect {login} again", { login: account.login })}
            onClick={() => github.openDialog("add", account.login)}
          >
            <CircleUser />
            <span className="truncate">{t("Connect {login} again", { login: account.login })}</span>
          </Button>
        </div>
      ) : (
        <ForgeSections
          repoPath={repoPath}
          login={account.login}
          active={active}
          version={version}
          busy={busy}
          workflows={workflows}
          workflowsRef={workflowsRef}
          onCreatePullRequest={onCreatePullRequest}
          onCreateIssue={onCreateIssue}
          onPullRequestAction={onPullRequestAction}
          onIssueAction={onIssueAction}
          onWorkflowRunAction={onWorkflowRunAction}
          onOpenUrl={onOpenUrl}
        />
      )}
    </div>
  );
}

type SectionsProps = Omit<Props, "forge" | "onChooseAccount"> & {
  /** The account that works on the repository. */
  login: string;
};

/** The workflow runs, pull requests and issues, as the account `login` sees them. */
function ForgeSections({
  repoPath,
  login,
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
}: SectionsProps) {
  const { t } = useI18n();
  return (
    <>
      {/* Each section is keyed by the account: what another one may see is loaded afresh. */}
      <WorkflowRunsSection
        key={`runs ${login}`}
        repoPath={repoPath}
        active={active}
        workflows={workflows}
        sectionRef={workflowsRef}
        onRunAction={onWorkflowRunAction}
        onOpenUrl={onOpenUrl}
      />
      <ForgeSection<PullRequest>
        key={`pulls ${login}`}
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
        key={`issues ${login}`}
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
    </>
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
  const github = useGitHub();
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
        // The panel then asks for the account to be connected again.
        if (isTokenRefused(failure)) void github.reload();
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
