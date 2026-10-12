import { type Ref, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  Workflow,
} from "lucide-react";

import type { CheckState, WorkflowJob, WorkflowRun } from "@/bindings";
import { CheckIcon } from "@/components/CheckIcon";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { LIVE_POLL_MS, type WorkflowRuns } from "@/hooks/useWorkflowRuns";
import { api, errorMessage } from "@/lib/api";
import { CHECK_LABELS, isRunning } from "@/lib/checks";
import { duration, relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type WorkflowRunAction = "open" | "showCommit" | "copyUrl";

interface Props {
  repoPath: string;
  /** Only the visible tab asks GitHub for the jobs of its open runs. */
  active: boolean;
  workflows: WorkflowRuns;
  /** Lets the top of the panel bring this section into view. */
  sectionRef?: Ref<HTMLElement>;
  onRunAction(action: WorkflowRunAction, run: WorkflowRun): void;
  /** Opens a page of github.com. */
  onOpenUrl(url: string): void;
}

/** Runs listed before "Show more". */
const SHOWN = 8;
/** Once a run is over, its jobs are asked for this many more times at most. */
const SETTLING_ASKS = 6;

/** The workflow runs of GitHub Actions, live: each run opens onto its jobs and their steps. */
export function WorkflowRunsSection({
  repoPath,
  active,
  workflows,
  sectionRef,
  onRunAction,
  onOpenUrl,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  // Runs opened or closed, by the user or because they started.
  const [opened, setOpened] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const { runs, loading, error } = workflows;
  const running = runs?.filter((run) => isRunning(run.state)).length ?? 0;
  const now = useNow(open && running > 0);

  // A run that starts opens itself, to show its jobs as they go. It stays open
  // once over, with the verdict of each job, until the user closes it.
  useEffect(() => {
    if (!runs) return;
    setOpened((previous) => {
      const starting = runs.filter((run) => isRunning(run.state) && !previous.has(run.id));
      if (starting.length === 0) return previous;
      const next = new Map(previous);
      for (const run of starting) next.set(run.id, true);
      return next;
    });
  }, [runs]);

  const shown = showAll ? runs : runs?.slice(0, SHOWN);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="mb-1" ref={sectionRef}>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <Chevron className="size-3.5" aria-hidden />
          <Workflow className="size-3.5" aria-hidden />
          <span className="truncate">{t("Actions")}</span>
          {running > 0 && (
            <span
              className="ml-auto flex items-center gap-1 tabular-nums"
              title={t("{n} running", { n: running })}
            >
              <CheckIcon state="inProgress" className="size-3" />
              {running}
            </span>
          )}
        </button>
        {open && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label={t("Reload")}
            onClick={workflows.reload}
          >
            {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </Button>
        )}
      </div>
      {open && (
        <ul>
          {error && <li className="px-7 py-1 text-xs text-destructive">{error}</li>}
          {shown?.map((run) => (
            <RunItem
              key={run.id}
              repoPath={repoPath}
              run={run}
              now={now}
              open={opened.get(run.id) ?? false}
              polling={active}
              onToggle={() =>
                setOpened((previous) => new Map(previous).set(run.id, !(previous.get(run.id) ?? false)))
              }
              onRunAction={onRunAction}
              onOpenUrl={onOpenUrl}
            />
          ))}
          {runs && runs.length === 0 && !error && (
            <li className="px-7 py-1 text-xs text-muted-foreground">{t("No workflow has run yet.")}</li>
          )}
          {runs && runs.length > SHOWN && (
            <li>
              <button
                type="button"
                className="px-7 py-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll ? t("Show fewer") : t("Show {n} more", { n: runs.length - SHOWN })}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** The time in seconds, refreshed every second while `ticking`: what running clocks count from. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now() / 1000);
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/** How long it took, or has been taking; empty for what did not run. */
function elapsed(
  state: CheckState,
  startedAt: number | null,
  completedAt: number | null,
  now: number,
): string {
  if (startedAt === null || state === "queued" || state === "skipped") return "";
  if (state === "inProgress") return duration(now - startedAt);
  return completedAt === null ? "" : duration(completedAt - startedAt);
}

interface RunProps {
  repoPath: string;
  run: WorkflowRun;
  now: number;
  open: boolean;
  polling: boolean;
  onToggle(): void;
  onRunAction(action: WorkflowRunAction, run: WorkflowRun): void;
  onOpenUrl(url: string): void;
}

function RunItem({ repoPath, run, now, open, polling, onToggle, onRunAction, onOpenUrl }: RunProps) {
  const { t } = useI18n();
  const label = t(CHECK_LABELS[run.state]);
  const time =
    run.state === "inProgress"
      ? duration(now - run.startedAt)
      : run.state === "queued" || run.state === "waiting"
        ? label
        : `${relativeTime(run.updatedAt)} · ${duration(run.updatedAt - run.startedAt)}`;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-start gap-2 py-1 pr-2 pl-3 text-left select-none hover:bg-muted/60"
            title={`${run.title}\n${label} · ${run.event} · ${run.actor}`}
            aria-expanded={open}
            onClick={onToggle}
          >
            <CheckIcon state={run.state} className="mt-0.5 size-3.5" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{run.title}</p>
              <p className="truncate text-[11px] text-muted-foreground tabular-nums">
                {run.workflow} #{run.number}
                {run.branch && ` · ${run.branch}`} · {time}
              </p>
            </div>
            <Chevron className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuItem onSelect={() => onRunAction("open", run)}>
            <ExternalLink />
            {t("Open on GitHub")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onRunAction("showCommit", run)}>
            <GitCommitHorizontal />
            {t("Show the commit in the graph")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onRunAction("copyUrl", run)}>
            <Copy />
            {t("Copy link")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && <RunJobs repoPath={repoPath} run={run} now={now} polling={polling} onOpenUrl={onOpenUrl} />}
    </li>
  );
}

interface JobsProps {
  repoPath: string;
  run: WorkflowRun;
  now: number;
  polling: boolean;
  onOpenUrl(url: string): void;
}

/** The jobs of an open run, asked again every few seconds while it runs. */
function RunJobs({ repoPath, run, now, polling, onOpenUrl }: JobsProps) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<WorkflowJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const live = isRunning(run.state);

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: number | undefined;
    let settling = SETTLING_ASKS;

    const ask = async () => {
      let unfinished = live;
      if (!document.hidden) {
        try {
          const next = await api.githubWorkflowJobs(repoPath, run.id);
          if (stopped) return;
          setJobs(next);
          setError(null);
          // GitHub may say the run is over a moment before its last job is.
          unfinished ||= next.some((job) => isRunning(job.state)) && settling-- > 0;
        } catch (failure) {
          if (stopped) return;
          setError(errorMessage(failure));
        }
      }
      if (unfinished) timer = window.setTimeout(() => void ask(), LIVE_POLL_MS);
    };
    void ask();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // Asked again whenever the run changes: its last steps end with it.
  }, [repoPath, run.id, run.state, run.updatedAt, run.attempt, live, polling]);

  if (error && !jobs) return <p className="py-0.5 pr-2 pl-8 text-xs text-destructive">{error}</p>;
  if (!jobs) return <p className="py-0.5 pr-2 pl-8 text-xs text-muted-foreground">{t("Loading the jobs…")}</p>;
  if (jobs.length === 0) {
    return <p className="py-0.5 pr-2 pl-8 text-xs text-muted-foreground">{t("No job has started yet.")}</p>;
  }
  return (
    <ul className="pb-1">
      {jobs.map((job) => (
        <JobItem
          key={job.id}
          job={job}
          // The clock of the section stops with the run; a job behind it has no use for one.
          now={now}
          open={opened.has(job.id)}
          onToggle={() =>
            setOpened((previous) => {
              const next = new Set(previous);
              if (!next.delete(job.id)) next.add(job.id);
              return next;
            })
          }
          onOpenUrl={onOpenUrl}
        />
      ))}
    </ul>
  );
}

interface JobProps {
  job: WorkflowJob;
  now: number;
  open: boolean;
  onToggle(): void;
  onOpenUrl(url: string): void;
}

function JobItem({ job, now, open, onToggle, onOpenUrl }: JobProps) {
  const { t } = useI18n();
  const time = elapsed(job.state, job.startedAt, job.completedAt, now);
  // Closed, a job still tells the step it is at, or the one that broke it.
  const position = job.steps.findIndex((step) =>
    job.state === "failure" ? step.state === "failure" : step.state === "inProgress",
  );
  const current = job.steps[position];
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 py-0.5 pr-2 pl-8 text-left text-xs select-none hover:bg-muted/60"
            title={`${job.name}\n${t(CHECK_LABELS[job.state])}`}
            aria-expanded={open}
            onClick={onToggle}
          >
            <CheckIcon state={job.state} className="size-3" />
            <span className="min-w-0 flex-1 truncate">{job.name}</span>
            {time && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{time}</span>}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => onOpenUrl(job.htmlUrl)}>
            <ExternalLink />
            {t("Open on GitHub")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open ? (
        <ol>
          {job.steps.map((step) => (
            <li
              key={step.number}
              className="flex items-center gap-1.5 py-px pr-2 pl-12 text-[11px]"
              title={`${step.name}\n${t(CHECK_LABELS[step.state])}`}
            >
              <CheckIcon state={step.state} className="size-3" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  (step.state === "queued" || step.state === "skipped") && "text-muted-foreground",
                )}
              >
                {step.name}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {elapsed(step.state, step.startedAt, step.completedAt, now)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        current && (
          <p
            className={cn(
              "truncate pr-2 pl-12 text-[11px]",
              current.state === "failure" ? "text-destructive" : "text-muted-foreground",
            )}
            title={current.name}
          >
            {current.state === "inProgress" && `${position + 1}/${job.steps.length} · `}
            {current.name}
          </p>
        )
      )}
    </li>
  );
}
