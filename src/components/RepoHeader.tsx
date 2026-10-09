import type { ComponentType } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CloudDownload,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";

import type { RepoInfo } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Operation, Progress } from "@/hooks/useRepository";
import { shortId } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface Props {
  info: RepoInfo;
  operation: Operation | null;
  /** The running fetch, pull or push, as git reports it. */
  progress: Progress | null;
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
  onRefresh,
  onFetch,
  onPull,
  onPush,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const { head } = info;
  const busy = operation !== null;
  const networking = operation === "fetch" || operation === "pull" || operation === "push";
  const operationLabel =
    operation === "fetch" ? t("Fetch") : operation === "pull" ? t("Pull") : t("Push");
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
            {head.upstream ? (
              <span
                className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground"
                title={t("Tracking {upstream}", { upstream: head.upstream })}
              >
                ↑{head.ahead} ↓{head.behind}
              </span>
            ) : head.target ? (
              <span className="ml-auto shrink-0 text-muted-foreground">{t("no upstream")}</span>
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
          </>
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1">
        <Action
          label={t("Fetch")}
          tooltip={t("Fetch every remote and prune deleted branches")}
          icon={CloudDownload}
          running={operation === "fetch"}
          disabled={busy}
          onClick={onFetch}
        />
        <Action
          label={t("Pull")}
          tooltip={
            head.upstream
              ? t("Pull from {upstream}", { upstream: head.upstream })
              : t("Pull (needs an upstream branch)")
          }
          icon={ArrowDownToLine}
          count={head.behind}
          running={operation === "pull"}
          disabled={busy || !head.branch}
          onClick={onPull}
        />
        <Action
          label={t("Push")}
          tooltip={
            head.upstream
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

interface ActionProps {
  label: string;
  tooltip: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  running: boolean;
  disabled: boolean;
  onClick(): void;
}

function Action({ label, tooltip, icon: Icon, count = 0, running, disabled, onClick }: ActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="xs" onClick={onClick} disabled={disabled}>
          {running ? <LoaderCircle className="animate-spin" /> : <Icon />}
          {label}
          {count > 0 && (
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
