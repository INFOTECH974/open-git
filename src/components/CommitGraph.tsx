import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Cherry,
  ChevronDown,
  ChevronUp,
  Copy,
  GitBranchPlus,
  GitCommitHorizontal,
  LoaderCircle,
  RotateCcw,
  Search,
  Tag,
  X,
} from "lucide-react";

import type { GraphRow, HeadInfo, RefInfo, WorkingTreeStatus } from "@/bindings";
import { GraphLanes } from "@/components/GraphLanes";
import { RefBadge } from "@/components/RefBadge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { type Repository, isClean } from "@/hooks/useRepository";
import { api } from "@/lib/api";
import { LANE_WIDTH, LINE_WIDTH, NODE_RADIUS, ROW_HEIGHT, laneX } from "@/lib/graph";
import { absoluteTime, relativeTime, shortId } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** What the user has selected in the graph. */
export type Selection = { kind: "commit"; id: string } | { kind: "wip" };

/** Asks the graph to bring a commit into view; `nonce` lets the same id be requested twice. */
export interface ScrollRequest {
  id: string;
  nonce: number;
}

/** What the context menu of a commit can do. */
export type CommitAction =
  | "checkout"
  | "createBranch"
  | "createTag"
  | "cherryPick"
  | "revert"
  | "copyId"
  | "copySummary";

interface Props {
  repo: Repository;
  selection: Selection | null;
  scrollRequest: ScrollRequest | null;
  onSelect(selection: Selection): void;
  onCommitAction(action: CommitAction, row: GraphRow): void;
}

const MAX_BADGES = 3;
/** Keeps the "Graph" column header readable even for a linear history. */
const MIN_LANES = 3;
const SEARCH_LIMIT = 500;

/** The virtualized list of commits with their graph lanes, topped by the
 *  uncommitted changes when there are any. */
export function CommitGraph({ repo, selection, scrollRequest, onSelect, onCommitAction }: Props) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Row 0 stands for the working tree when it has changes; commits follow.
  const wipRows = isClean(repo.status) ? 0 : 1;
  const virtualizer = useVirtualizer({
    count: repo.commitCount + wipRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const items = virtualizer.getVirtualItems();
  const first = Math.max((items[0]?.index ?? 0) - wipRows, 0);
  const last = Math.max((items[items.length - 1]?.index ?? 0) - wipRows, 0);
  const { ensureRows, rowAt, rowIndexOf } = repo;
  useEffect(() => {
    if (items.length > 0 && repo.commitCount > 0) ensureRows(first, last);
  }, [ensureRows, first, last, items.length, repo.commitCount]);

  const path = repo.info.path;
  useEffect(() => {
    if (!scrollRequest) return;
    let cancelled = false;
    api.commitIndex(path, scrollRequest.id).then(
      (index) => {
        if (!cancelled && index !== null) {
          virtualizer.scrollToIndex(index + wipRows, { align: "center" });
        }
      },
      () => {
        // The commit is not in the graph (or the id is invalid); nothing to scroll to.
      },
    );
    return () => {
      cancelled = true;
    };
    // The virtualizer instance is stable; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest, path]);

  // ---- search ---------------------------------------------------------------

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [matchCursor, setMatchCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  // A commit chosen by index whose row may still be loading.
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setMatches([]);
      setMatchCursor(0);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.searchCommits(path, needle, SEARCH_LIMIT).then(
        (found) => {
          if (cancelled) return;
          setMatches(found);
          setMatchCursor(0);
          setSearching(false);
          if (found.length > 0) setPendingIndex(found[0]);
        },
        (failure) => {
          if (cancelled) return;
          setSearching(false);
          repo.report(failure);
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `repo.report` is stable enough; the search only depends on the query and repository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, path, repo.commitCount]);

  // Once the pending row is loaded, select it.
  useEffect(() => {
    if (pendingIndex === null) return;
    virtualizer.scrollToIndex(pendingIndex + wipRows, { align: "center" });
    const row = rowAt(pendingIndex);
    if (row) {
      onSelect({ kind: "commit", id: row.id });
      setPendingIndex(null);
    } else {
      ensureRows(pendingIndex, pendingIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIndex, rowAt, ensureRows, wipRows]);

  const goToMatch = useCallback(
    (step: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (matchCursor + step + matches.length) % matches.length;
      setMatchCursor(next);
      setPendingIndex(matches[next]);
    },
    [matches, matchCursor],
  );

  // ---- keyboard -------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const total = repo.commitCount + wipRows;
    const currentIndex =
      selection?.kind === "wip"
        ? 0
        : selection?.kind === "commit"
          ? (() => {
              const index = rowIndexOf(selection.id);
              return index === undefined ? undefined : index + wipRows;
            })()
          : undefined;
    const target =
      currentIndex === undefined ? 0 : Math.min(Math.max(currentIndex + step, 0), total - 1);
    if (wipRows === 1 && target === 0) {
      onSelect({ kind: "wip" });
    } else {
      const row = rowAt(target - wipRows);
      if (row) onSelect({ kind: "commit", id: row.id });
    }
    virtualizer.scrollToIndex(target, { align: "auto" });
  };

  if (repo.commitCount + wipRows === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {repo.operation === "refresh" ? (
          <LoaderCircle className="size-5 animate-spin" />
        ) : (
          t("This repository has no commits yet.")
        )}
      </div>
    );
  }

  const lanes = Math.max(repo.laneCount, MIN_LANES);
  const graphWidth = lanes * LANE_WIDTH;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-7 w-full rounded-md border bg-background pr-7 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder={t("Search commits by message, author or id")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                setQuery("");
              }
            }}
            aria-label={t("Search commits")}
          />
          {query && (
            <button
              type="button"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label={t("Clear the search")}
              onClick={() => setQuery("")}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        {query.trim() && (
          <>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {searching
                ? "…"
                : matches.length === 0
                  ? t("No match")
                  : `${matchCursor + 1} / ${matches.length}${matches.length >= SEARCH_LIMIT ? "+" : ""}`}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("Previous match")}
              disabled={matches.length === 0}
              onClick={() => goToMatch(-1)}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("Next match")}
              disabled={matches.length === 0}
              onClick={() => goToMatch(1)}
            >
              <ChevronDown />
            </Button>
          </>
        )}
      </div>
      <div className="flex h-7 shrink-0 items-center border-b bg-muted/40 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <div className="shrink-0 pl-3" style={{ width: graphWidth + 12 }}>
          {t("Graph")}
        </div>
        <div className="min-w-0 flex-1 pl-2">{t("Commit")}</div>
        <div className="w-36 shrink-0">{t("Author")}</div>
        <div className="w-24 shrink-0 pr-3 text-right">{t("Date")}</div>
      </div>
      <div
        ref={scrollRef}
        className="app-scroll min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={t("Commit history")}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => {
            const isWip = wipRows === 1 && item.index === 0;
            const row = isWip ? undefined : repo.rowAt(item.index - wipRows);
            const selected = isWip
              ? selection?.kind === "wip"
              : row !== undefined && selection?.kind === "commit" && row.id === selection.id;
            const matched = !isWip && matchSet.has(item.index - wipRows);
            const select = isWip
              ? () => onSelect({ kind: "wip" })
              : row
                ? () => onSelect({ kind: "commit", id: row.id })
                : undefined;
            const content = isWip ? (
              <WipRow status={repo.status} lanes={lanes} />
            ) : row ? (
              <Row row={row} refs={repo.refsByCommit.get(row.id)} head={repo.info.head} lanes={lanes} />
            ) : (
              <Skeleton width={graphWidth} />
            );
            const className = cn(
              "absolute top-0 left-0 flex w-full cursor-default items-center pl-3 select-none",
              selected ? "bg-accent" : matched ? "bg-amber-500/10 hover:bg-amber-500/15" : "hover:bg-muted/60",
            );
            const style = { height: ROW_HEIGHT, transform: `translateY(${item.start}px)` };
            if (!row) {
              return (
                <div key={item.key} data-index={item.index} className={className} style={style} onClick={select}>
                  {content}
                </div>
              );
            }
            return (
              <ContextMenu key={item.key}>
                <ContextMenuTrigger asChild>
                  <div
                    data-index={item.index}
                    className={className}
                    style={style}
                    onClick={select}
                    onContextMenu={select}
                  >
                    {content}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-64">
                  <ContextMenuItem onSelect={() => onCommitAction("checkout", row)}>
                    <GitCommitHorizontal />
                    {t("Check out this commit (detached)")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onCommitAction("createBranch", row)}>
                    <GitBranchPlus />
                    {t("Create a branch here…")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onCommitAction("createTag", row)}>
                    <Tag />
                    {t("Create a tag here…")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => onCommitAction("cherryPick", row)}>
                    <Cherry />
                    {t("Cherry-pick onto the current branch")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onCommitAction("revert", row)}>
                    <RotateCcw />
                    {t("Revert this commit")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => onCommitAction("copyId", row)}>
                    <Copy />
                    {t("Copy id")} <code className="font-mono text-muted-foreground">{shortId(row.id)}</code>
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onCommitAction("copySummary", row)}>
                    <Copy />
                    {t("Copy message")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  row: GraphRow;
  refs: RefInfo[] | undefined;
  head: HeadInfo;
  lanes: number;
}

function Row({ row, refs, head, lanes }: RowProps) {
  const shown = refs?.slice(0, MAX_BADGES) ?? [];
  const hidden = (refs?.length ?? 0) - shown.length;
  return (
    <>
      <GraphLanes layout={row.layout} laneCount={lanes} merge={row.layout.outgoing.length > 1} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-3">
        {shown.map((reference) => (
          <RefBadge
            key={`${reference.kind}:${reference.name}`}
            reference={reference}
            isHead={reference.kind === "localBranch" && reference.name === head.branch}
          />
        ))}
        {hidden > 0 && (
          <span
            className="text-[11px] text-muted-foreground"
            title={refs?.slice(MAX_BADGES).map((r) => r.name).join("\n")}
          >
            +{hidden}
          </span>
        )}
        <span className="truncate text-sm" title={row.summary}>
          {row.summary}
        </span>
      </div>
      <div className="w-36 shrink-0 truncate pr-2 text-xs text-muted-foreground" title={row.authorEmail}>
        {row.authorName}
      </div>
      <div
        className="w-24 shrink-0 pr-3 text-right text-xs whitespace-nowrap text-muted-foreground"
        title={absoluteTime(row.time)}
      >
        {relativeTime(row.time)}
      </div>
    </>
  );
}

function WipRow({ status, lanes }: { status: WorkingTreeStatus | null; lanes: number }) {
  const { t } = useI18n();
  const staged = status?.staged.length ?? 0;
  const unstaged = status?.unstaged.length ?? 0;
  const conflicted = status?.conflicted.length ?? 0;
  const cx = laneX(0);
  const cy = ROW_HEIGHT / 2;
  return (
    <>
      <svg width={lanes * LANE_WIDTH} height={ROW_HEIGHT} className="shrink-0" aria-hidden>
        <circle
          cx={cx}
          cy={cy}
          r={NODE_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={LINE_WIDTH}
          strokeDasharray="2 2"
          className="text-muted-foreground"
        />
      </svg>
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-3 text-sm">
        <span className="truncate italic">{t("Uncommitted changes")}</span>
        <span className="flex shrink-0 gap-1 text-[11px] text-muted-foreground">
          {staged > 0 && <Count>{t("{n} staged", { n: staged })}</Count>}
          {unstaged > 0 && <Count>{t("{n} unstaged", { n: unstaged })}</Count>}
          {conflicted > 0 && (
            <Count className="text-destructive">{t("{n} conflicts", { n: conflicted })}</Count>
          )}
        </span>
      </div>
    </>
  );
}

function Count({ className, children }: { className?: string; children: string }) {
  return (
    <span className={cn("rounded bg-muted px-1.5 leading-4 tabular-nums", className)}>{children}</span>
  );
}

function Skeleton({ width }: { width: number }) {
  return (
    <>
      <div style={{ width }} className="shrink-0" />
      <div className="ml-3 h-3 w-1/3 animate-pulse rounded bg-muted" />
    </>
  );
}
