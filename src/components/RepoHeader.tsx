import { type ComponentType, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CloudDownload,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";

import type { RepoInfo } from "@/bindings";
import { CheckIcon } from "@/components/CheckIcon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FETCH_TIMED_OUT, type FetchStatus, type Operation, type Progress } from "@/hooks/useRepository";
import { CHECK_LABELS, type CommitChecks } from "@/lib/checks";
import { relativeTime, shortId } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface Props {
  info: RepoInfo;
  operation: Operation | null;
  /** The running fetch, pull or push, as git reports it. */
  progress: Progress | null;
  fetchStatus: FetchStatus;
  /**
   * Moves `origin` from SSH to HTTPS, where the connected GitHub accounts answer;
   * offered when the fetch failed for lack of an SSH key.
   */
  onUseHttps?: () => void;
  /** The workflow runs of the checked-out commit, when GitHub has some. */
  checks: CommitChecks | undefined;
  onShowChecks(): void;
  onRefresh(): void;
  onFetch(): void;
  onPull(): void;
  onPush(): void;
  onCancel(): void;
}

/** Repository name, checked-out branch and the remote actions, atop the left panel. */
export function RepoHeader({
  info,
  operation,
  progress,
  fetchStatus,
  onUseHttps,
  checks,
  onShowChecks,
  onRefresh,
  onFetch,
  onPull,
  onPush,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const { head } = info;
  const hasRemote = info.remotes.length > 0;
  const busy = operation !== null;
  const networking = operation === "fetch" || operation === "pull" || operation === "push";
  const operationLabel =
    operation === "fetch" ? t("Fetch") : operation === "pull" ? t("Pull") : t("Push");
  const headChecks = checks && (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={t("Show the workflow runs")}
          onClick={onShowChecks}
        >
          <CheckIcon state={checks.state} className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {checks.runs.map((run) => (
          <div key={run.id}>
            {run.workflow}: {t(CHECK_LABELS[run.state])}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
  return (
    <div className="border-b px-3 py-2">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={info.path}>
          {info.name}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={t("Refresh")}
              onClick={onRefresh}
              disabled={busy}
            >
              {operation === "refresh" ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("Re-read the repository")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-xs">
        {head.branch ? (
          <>
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate font-medium" title={head.branch}>
              {head.branch}
            </span>
            {headChecks}
            {head.upstream ? (
              <span
                className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground"
                title={t("Tracking {upstream}", { upstream: head.upstream })}
              >
                ↑{head.ahead} ↓{head.behind}
              </span>
            ) : head.goneUpstream ? (
              <span
                className="ml-auto shrink-0 text-amber-600 dark:text-amber-400"
                title={t("{upstream} was deleted on the remote", { upstream: head.goneUpstream })}
              >
                {t("deleted on the remote")}
              </span>
            ) : head.target ? (
              <span className="ml-auto shrink-0 text-muted-foreground">
                {hasRemote ? t("no upstream") : t("no remote")}
              </span>
            ) : (
              <span className="ml-auto shrink-0 text-muted-foreground">{t("no commits")}</span>
            )}
          </>
        ) : (
          <>
            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate" title={head.target ?? undefined}>
              {head.target
                ? t("HEAD detached at {id}", { id: shortId(head.target) })
                : t("HEAD detached")}
            </span>
            {headChecks}
          </>
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1">
        <Action
          label={t("Fetch")}
          tooltip={
            !hasRemote
              ? t("No remote to fetch from")
              : fetchStatus.failure
                ? t("The last fetch failed: the remote branches may be out of date")
                : t("Fetch every remote and prune deleted branches")
          }
          icon={CloudDownload}
          warning={hasRemote && fetchStatus.failure !== null}
          running={operation === "fetch" || (fetchStatus.running && !busy)}
          disabled={busy || !hasRemote}
          onClick={onFetch}
        />
        <Action
          label={t("Pull")}
          tooltip={
            head.upstream
              ? t("Pull from {upstream}", { upstream: head.upstream })
              : hasRemote
                ? t("Pull (needs an upstream branch)")
                : t("No remote to pull from")
          }
          icon={ArrowDownToLine}
          count={head.behind}
          running={operation === "pull"}
          disabled={busy || !head.branch || !hasRemote}
          onClick={onPull}
        />
        <Action
          label={t("Push")}
          tooltip={
            !hasRemote
              ? t("Add a remote to push to…")
              : head.upstream
                ? t("Push to {upstream}", { upstream: head.upstream })
                : t("Push and set the upstream branch")
          }
          icon={ArrowUpFromLine}
          count={head.ahead}
          running={operation === "push"}
          disabled={busy || !head.branch || !head.target}
          onClick={onPush}
        />
      </div>

      {hasRemote && !networking && (
        <FetchLine status={fetchStatus} disabled={busy} onUseHttps={onUseHttps} />
      )}

      {networking && (
        <div className="mt-2" role="status" aria-live="polite">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={progress?.message}>
              {progress?.message ?? `${operationLabel}…`}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={t("Cancel")} onClick={onCancel}>
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Stop the {operation}", { operation: operationLabel.toLowerCase() })}</TooltipContent>
            </Tooltip>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
            <div
              className={cn(
                "h-full rounded bg-primary transition-[width] duration-200",
                progress?.percent == null && "w-1/3 animate-pulse",
              )}
              style={progress?.percent != null ? { width: `${progress.percent}%` } : undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Re-renders every `intervalMs`, for times shown relative to now. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A failed fetch in a few words; the full message goes in the tooltip. */
function failureSummary(message: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (message === FETCH_TIMED_OUT) return t(FETCH_TIMED_OUT);
  if (/Permission denied \(publickey/.test(message)) return t("no SSH key accepted by the remote");
  if (/Host key verification failed/.test(message)) return t("the SSH host key could not be verified");
  if (/Could not resolve host|unable to access .*(timed out|Failed to connect)/i.test(message)) {
    return t("the remote cannot be reached");
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|Bad credentials/i.test(message)) {
    return t("credentials refused by the remote");
  }
  if (/Repository not found|does not appear to be a git repository/i.test(message)) {
    return t("repository not found on the remote");
  }
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? message;
}

interface FetchLineProps {
  status: FetchStatus;
  disabled: boolean;
  onUseHttps?: () => void;
}

/** When the remotes were last fetched, or why that no longer works. */
function FetchLine({ status, disabled, onUseHttps }: FetchLineProps) {
  const { t } = useI18n();
  const now = useNow(30_000);
  const when =
    status.lastFetch === null
      ? t("never")
      : // Within a minute, "now" reads better than "0 minutes ago".
        now / 1000 - status.lastFetch < 60
        ? t("just now")
        : relativeTime(status.lastFetch, now);

  if (status.failure) {
    return (
      <div className="mt-2 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px]" role="status">
        <div className="flex items-start gap-1.5">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0" title={status.failure}>
            {t("Fetch failed: {reason}", { reason: failureSummary(status.failure, t) })}
          </span>
        </div>
        <div className="text-muted-foreground">
          {t("Last successful fetch: {when}", { when })}
        </div>
        {onUseHttps && (
          <Button variant="outline" size="xs" className="w-full" disabled={disabled} onClick={onUseHttps}>
            {t("Use HTTPS for origin")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground" role="status">
      {status.running ? (
        <>
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          {t("Fetching…")}
        </>
      ) : (
        t("Last fetch: {when}", { when })
      )}
    </div>
  );
}

interface ActionProps {
  label: string;
  tooltip: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  /** An orange "!" badge: the action needs attention. */
  warning?: boolean;
  running: boolean;
  disabled: boolean;
  onClick(): void;
}

function Action({
  label,
  tooltip,
  icon: Icon,
  count = 0,
  warning = false,
  running,
  disabled,
  onClick,
}: ActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="xs" onClick={onClick} disabled={disabled}>
          {running ? <LoaderCircle className="animate-spin" /> : <Icon />}
          {label}
          {warning && (
            <span className="rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-4 text-white">
              !
            </span>
          )}
          {!warning && count > 0 && (
            <span className="rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground tabular-nums">
              {count}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
