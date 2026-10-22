import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GraphRow, RefInfo, RepoInfo, StashEntry, WorkingTreeStatus } from "@/bindings";
import { api, errorMessage, events, isCancelled, isRepositoryNotOpen } from "@/lib/api";
import { rowLaneCount } from "@/lib/graph";

/** Rows fetched per request; a page covers several screens of history. */
export const PAGE_SIZE = 200;

/** A backend call that changes the repository; the UI disables conflicting actions meanwhile. */
export type Operation =
  | "refresh"
  | "status"
  | "stage"
  | "commit"
  | "checkout"
  | "branch"
  | "merge"
  | "stash"
  | "remote"
  | "fetch"
  | "pull"
  | "push";

/** The latest line git printed during a network operation. */
export interface Progress {
  operation: string;
  message: string;
  percent: number | null;
}

export interface Repository {
  info: RepoInfo;
  refs: RefInfo[];
  /** Branches and tags grouped by the commit they point at. */
  refsByCommit: Map<string, RefInfo[]>;
  stashes: StashEntry[];
  commitCount: number;
  /** Widest row loaded so far, so the graph column keeps one width. */
  laneCount: number;
  /** Uncommitted changes; `null` until the first load. */
  status: WorkingTreeStatus | null;
  operation: Operation | null;
  /** Progress of the running fetch, pull or push; `null` otherwise. */
  progress: Progress | null;
  /** How the remotes were last brought up to date. */
  fetchStatus: FetchStatus;
  error: string | null;
  /** Stops the running network operation. */
  cancel(): void;
  /** Re-reads everything after the repository changed on disk. */
  refresh(): Promise<boolean>;
  /**
   * Runs a mutating backend call, then reloads the whole repository (or only the
   * working tree status). Resolves to whether the call succeeded.
   */
  run(operation: Operation, action: () => Promise<unknown>, reload?: "all" | "status"): Promise<boolean>;
  /** Shows a failure that happened outside `run`. */
  report(failure: unknown): void;
  /** The loaded row at `index`, or `undefined` while its page is still loading. */
  rowAt(index: number): GraphRow | undefined;
  /** Row of a loaded commit, or `undefined` when its page is not loaded. */
  rowIndexOf(id: string): number | undefined;
  /** Starts loading the pages covering rows `first..=last`. */
  ensureRows(first: number, last: number): void;
  clearError(): void;
}

export interface FetchStatus {
  /** When the remotes were last fetched, in seconds since the epoch; `null` if never. */
  lastFetch: number | null;
  /** Why the latest fetch failed, automatic or not; `null` once one succeeds. */
  failure: string | null;
  /** Whether the automatic fetch is running. */
  running: boolean;
}

/** The failure recorded when the automatic fetch gives up waiting for the remote. */
export const FETCH_TIMED_OUT = "The remote did not answer within 45 seconds";

function isNetworkOperation(operation: Operation | null): boolean {
  return operation === "fetch" || operation === "pull" || operation === "push";
}

export function isClean(status: WorkingTreeStatus | null): boolean {
  return (
    status === null ||
    (status.staged.length === 0 && status.unstaged.length === 0 && status.conflicted.length === 0)
  );
}

/** Changes noticed this long after one of our own operations are that operation's. */
const OWN_CHANGE_GRACE_MS = 800;
/** Lets a burst of events (a checkout touching many files) settle before reloading. */
const EVENT_SETTLE_MS = 250;
/** How often the remotes are fetched without the user asking. */
const AUTO_FETCH_INTERVAL_MS = 60_000;
/** Coming back to the window fetches at once, unless the last fetch is this recent. */
const AUTO_FETCH_MIN_GAP_MS = 10_000;

/**
 * State of one open repository. `active` is whether its tab is the one shown:
 * only that repository fetches its remotes on its own.
 */
export function useRepository(initial: RepoInfo, active: boolean): Repository {
  const path = initial.path;
  const [info, setInfo] = useState(initial);
  const [refs, setRefs] = useState<RefInfo[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [commitCount, setCommitCount] = useState(0);
  const [laneCount, setLaneCount] = useState(1);
  const [status, setStatus] = useState<WorkingTreeStatus | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fetches that succeeded without changing anything do not reload `info`, whose
  // `lastFetch` then lags: the time of the latest one is kept here too.
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [fetchFailure, setFetchFailure] = useState<string | null>(null);
  const [autoFetching, setAutoFetching] = useState(false);
  const [pages, setPages] = useState<Map<number, GraphRow[]>>(() => new Map());
  const inFlight = useRef(new Set<number>());
  // Bumped on every reload so responses to an older state are dropped.
  const generation = useRef(0);
  const operationRef = useRef<Operation | null>(null);
  const lastOperationEnd = useRef(0);
  // The automatic fetch in flight, and when the last one started.
  const autoFetch = useRef<Promise<void> | null>(null);
  const lastAutoFetch = useRef(0);

  const loadAll = useCallback(async () => {
    const current = ++generation.current;
    let nextInfo: RepoInfo;
    try {
      nextInfo = await api.refreshRepository(path);
    } catch (failure) {
      // The backend forgot the repository (it restarted); open it again once.
      if (!isRepositoryNotOpen(failure)) throw failure;
      nextInfo = await api.openRepository(path);
    }
    const [nextRefs, count, nextStatus, nextStashes] = await Promise.all([
      api.refs(path),
      api.commitCount(path),
      api.status(path),
      api.stashList(path),
    ]);
    if (current !== generation.current) return;
    inFlight.current.clear();
    setPages(new Map());
    setLaneCount(1);
    setInfo(nextInfo);
    setRefs(nextRefs);
    setCommitCount(count);
    setStatus(nextStatus);
    setStashes(nextStashes);
  }, [path]);

  const loadStatus = useCallback(async () => {
    const [nextInfo, nextStatus] = await Promise.all([
      api.refreshRepository(path),
      api.status(path),
    ]);
    // Staging does not change history, so the loaded rows stay valid.
    setInfo(nextInfo);
    setStatus(nextStatus);
  }, [path]);

  const run = useCallback<Repository["run"]>(
    async (nextOperation, action, reload = "all") => {
      operationRef.current = nextOperation;
      setOperation(nextOperation);
      setError(null);
      try {
        // Two `git` processes updating the same remote branches would fight over them.
        if (isNetworkOperation(nextOperation)) await autoFetch.current;
        await action();
        // Both bring the remote branches up to date.
        if (nextOperation === "fetch" || nextOperation === "pull") {
          setFetchedAt(Math.floor(Date.now() / 1000));
          setFetchFailure(null);
        }
        await (reload === "all" ? loadAll() : loadStatus());
        return true;
      } catch (failure) {
        if (!isCancelled(failure)) setError(errorMessage(failure));
        if (nextOperation === "fetch" && !isCancelled(failure)) {
          setFetchFailure(errorMessage(failure));
        }
        // The operation may have changed things before failing (a merge with conflicts).
        await loadAll().catch(() => {});
        return false;
      } finally {
        operationRef.current = null;
        lastOperationEnd.current = Date.now();
        setOperation(null);
        setProgress(null);
      }
    },
    [loadAll, loadStatus],
  );

  const refresh = useCallback(() => run("refresh", async () => {}), [run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Follow changes made outside the application (editor, terminal, another tool).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let timer: number | undefined;
    let pending: "history" | "workingTree" | null = null;

    const flush = () => {
      const kind = pending;
      pending = null;
      if (!kind) return;
      (kind === "history" ? loadAll() : loadStatus()).catch((failure) =>
        setError(errorMessage(failure)),
      );
    };

    events.repositoryChanged
      .listen((event) => {
        if (event.payload.path !== path) return;
        // Our own operations reload on their own.
        if (operationRef.current !== null) return;
        if (Date.now() - lastOperationEnd.current < OWN_CHANGE_GRACE_MS) return;
        pending = pending === "history" || event.payload.kind === "history" ? "history" : "workingTree";
        window.clearTimeout(timer);
        timer = window.setTimeout(flush, EVENT_SETTLE_MS);
      })
      .then(
        (stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        },
        () => {
          // No event system (plain browser without the mock): nothing to follow.
        },
      );
    return () => {
      cancelled = true;
      unlisten?.();
      window.clearTimeout(timer);
    };
  }, [path, loadAll, loadStatus]);

  // Remote branches only move when fetched. Fetch regularly, and whenever the user
  // comes back to the window, so a push made elsewhere (a teammate, a CI job
  // promoting a branch) shows up by itself.
  const hasRemote = info.remotes.length > 0;
  useEffect(() => {
    if (!active || !hasRemote) return;
    let stopped = false;

    const fetchNow = () => {
      if (document.hidden || autoFetch.current) return;
      // Reading (the first load, a refresh) can overlap; anything else goes first.
      if (operationRef.current !== null && operationRef.current !== "refresh") return;
      lastAutoFetch.current = Date.now();
      setAutoFetching(true);
      autoFetch.current = api
        .fetchInBackground(path)
        // Recorded even when this effect was cleaned up meanwhile (the tab became
        // active, for one): the outcome is still the latest, and the next fetch
        // is up to a minute away.
        .then(
          (changed) => {
            setFetchedAt(Math.floor(Date.now() / 1000));
            setFetchFailure(null);
            return changed;
          },
          (failure) => {
            // Offline, no credentials, a remote that is gone: nobody asked for this
            // fetch, so no error banner; the header shows why the remote branches
            // may be stale, and the next fetch tries again.
            setFetchFailure(isCancelled(failure) ? FETCH_TIMED_OUT : errorMessage(failure));
            return false;
          },
        )
        .then(async (changed) => {
          if (!changed || stopped) return;
          // The watcher reports the same change; one reload is enough.
          lastOperationEnd.current = Date.now();
          await loadAll();
          lastOperationEnd.current = Date.now();
        })
        .catch((failure) => setError(errorMessage(failure)))
        .finally(() => {
          autoFetch.current = null;
          setAutoFetching(false);
        });
    };
    const fetchIfStale = () => {
      if (Date.now() - lastAutoFetch.current >= AUTO_FETCH_MIN_GAP_MS) fetchNow();
    };

    fetchIfStale();
    const timer = window.setInterval(fetchNow, AUTO_FETCH_INTERVAL_MS);
    window.addEventListener("focus", fetchIfStale);
    document.addEventListener("visibilitychange", fetchIfStale);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", fetchIfStale);
      document.removeEventListener("visibilitychange", fetchIfStale);
    };
  }, [path, active, hasRemote, loadAll]);

  // Progress lines of the running fetch, pull or push.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    events.operationProgress
      .listen((event) => {
        if (event.payload.path !== path) return;
        setProgress({
          operation: event.payload.operation,
          message: event.payload.message,
          percent: event.payload.percent,
        });
      })
      .then(
        (stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        },
        () => {
          // No event system available: the operation just shows its spinner.
        },
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [path]);

  const cancel = useCallback(() => {
    api.cancelOperation(path).catch(() => {
      // Nothing was running, or the backend is gone; either way there is nothing to stop.
    });
  }, [path]);

  const ensureRows = useCallback(
    (first: number, last: number) => {
      const current = generation.current;
      const firstPage = Math.floor(Math.max(first, 0) / PAGE_SIZE);
      const lastPage = Math.floor(Math.max(last, 0) / PAGE_SIZE);
      for (let page = firstPage; page <= lastPage; page++) {
        if (pages.has(page) || inFlight.current.has(page)) continue;
        inFlight.current.add(page);
        api.graphRows(path, page * PAGE_SIZE, PAGE_SIZE).then(
          (rows) => {
            if (current !== generation.current) return;
            inFlight.current.delete(page);
            setPages((previous) => new Map(previous).set(page, rows));
            setLaneCount((previous) =>
              rows.reduce((max, row) => Math.max(max, rowLaneCount(row.layout)), previous),
            );
          },
          (failure) => {
            inFlight.current.delete(page);
            if (current === generation.current) setError(errorMessage(failure));
          },
        );
      }
    },
    [path, pages],
  );

  const rowAt = useCallback(
    (index: number) => pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE],
    [pages],
  );

  const rowIndexOf = useCallback(
    (id: string) => {
      for (const [page, rows] of pages) {
        const offset = rows.findIndex((row) => row.id === id);
        if (offset >= 0) return page * PAGE_SIZE + offset;
      }
      return undefined;
    },
    [pages],
  );

  const refsByCommit = useMemo(() => {
    const map = new Map<string, RefInfo[]>();
    for (const ref of refs) {
      const list = map.get(ref.target);
      if (list) list.push(ref);
      else map.set(ref.target, [ref]);
    }
    return map;
  }, [refs]);

  const lastFetch =
    info.lastFetch === null || fetchedAt === null
      ? (info.lastFetch ?? fetchedAt)
      : Math.max(info.lastFetch, fetchedAt);
  const fetchStatus = useMemo<FetchStatus>(
    () => ({ lastFetch, failure: fetchFailure, running: autoFetching }),
    [lastFetch, fetchFailure, autoFetching],
  );

  const clearError = useCallback(() => setError(null), []);
  const report = useCallback((failure: unknown) => setError(errorMessage(failure)), []);

  return {
    info,
    refs,
    refsByCommit,
    stashes,
    commitCount,
    laneCount,
    status,
    operation,
    progress,
    fetchStatus,
    error,
    cancel,
    refresh,
    run,
    report,
    rowAt,
    rowIndexOf,
    ensureRows,
    clearError,
  };
}
