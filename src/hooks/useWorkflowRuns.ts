import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkflowRun } from "@/bindings";
import { api, errorMessage, isTokenRefused } from "@/lib/api";
import { type CommitChecks, checksByCommit, isRunning } from "@/lib/checks";
import { useGitHub } from "@/lib/github";

/** While a run is queued or in progress, GitHub is asked again this often. */
export const LIVE_POLL_MS = 5_000;
/** Otherwise, often enough to notice a run started from elsewhere. */
const IDLE_POLL_MS = 60_000;
/** GitHub creates the runs a few seconds after a push: look closely for this long. */
const EXPECTING_MS = 45_000;
/**
 * Runs are deleted one at a time, one every this many milliseconds at most.
 * On top of the hourly quota, GitHub allows 900 points a minute and a DELETE
 * costs 5 of them: 150 deletions a minute stay clear of that limit.
 */
const DELETE_MS = 400;

/** Where deleting runs stands. */
export interface RunDeletion {
  /** Runs deleted so far. */
  done: number;
  total: number;
  /** Still deleting; otherwise it went through, was stopped or failed. */
  running: boolean;
  /** Why it stopped before the end. */
  error: string | null;
}

/** What GitHub Actions is doing for a repository. */
export interface WorkflowRuns {
  /**
   * Newest first; `null` until the first answer, and for good when `origin` is
   * not on GitHub or no account is connected.
   */
  runs: WorkflowRun[] | null;
  byCommit: Map<string, CommitChecks>;
  loading: boolean;
  error: string | null;
  reload(): void;
  /** `null` until runs are deleted, and once how it ended was dismissed. */
  deletion: RunDeletion | null;
  /** Deletes these runs one after the other; each leaves `runs` once deleted. */
  deleteRuns(ids: number[]): void;
  /** Stops deleting once the run being deleted is gone. */
  stopDeleting(): void;
  dismissDeletion(): void;
}

/**
 * Follows the workflow runs of the repository at `path`. GitHub cannot notify a
 * desktop application, so it is asked again and again: every few seconds while
 * something runs or was just pushed, every minute otherwise, and only for the
 * visible tab of a visible window. `remoteTips` is any string that changes when
 * a remote branch moves, which is when new runs are to be expected. `account` is
 * the login of the account that works on the repository on GitHub, `null` when
 * there is none or the repository is elsewhere.
 */
export function useWorkflowRuns(
  path: string,
  active: boolean,
  remoteTips: string,
  account: string | null,
): WorkflowRuns {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const expectingUntil = useRef(0);
  const { reload: reloadAccounts } = useGitHub();

  // What one account was shown is not what another may see.
  useEffect(() => {
    setRuns(null);
    setError(null);
  }, [account]);

  const reload = useCallback(() => setReloads((value) => value + 1), []);

  const previousTips = useRef(remoteTips);
  useEffect(() => {
    if (previousTips.current === remoteTips) return;
    // The first value is the repository being read, not a push.
    const moved = previousTips.current !== "";
    previousTips.current = remoteTips;
    if (!moved) return;
    expectingUntil.current = Date.now() + EXPECTING_MS;
    reload();
  }, [remoteTips, reload]);

  const enabled = active && account !== null;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    let asking = false;
    let lastAsked = 0;

    const ask = async () => {
      window.clearTimeout(timer);
      timer = undefined;
      // A hidden window asks nothing; `onVisible` picks up where this stops.
      if (asking || document.hidden) return;
      asking = true;
      lastAsked = Date.now();
      let delay = IDLE_POLL_MS;
      try {
        const next = await api.githubWorkflowRuns(path);
        if (stopped) return;
        // Most answers repeat the last one: keep its identity, and the UI still.
        setRuns((previous) =>
          previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        setError(null);
        if (next.some((run) => isRunning(run.state)) || Date.now() < expectingUntil.current) {
          delay = LIVE_POLL_MS;
        }
      } catch (failure) {
        if (stopped) return;
        setError(errorMessage(failure));
        // The account gets flagged, and the panel asks for it to be connected again.
        if (isTokenRefused(failure)) void reloadAccounts();
      } finally {
        asking = false;
      }
      setLoading(false);
      timer = window.setTimeout(() => void ask(), delay);
    };
    const onVisible = () => {
      // No timer: the window was hidden when the last one fired.
      if (timer === undefined || Date.now() - lastAsked >= LIVE_POLL_MS) void ask();
    };

    setLoading(true);
    void ask();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      setLoading(false);
    };
  }, [enabled, path, account, reloads, reloadAccounts]);

  // Deleting runs. Those deleted leave the list at once, without waiting for
  // GitHub to be asked again, and an answer given before they were deleted
  // does not bring them back.
  const [deleted, setDeleted] = useState<ReadonlySet<number>>(() => new Set());
  const [deletion, setDeletion] = useState<RunDeletion | null>(null);
  const deleting = useRef<{ stopped: boolean } | null>(null);

  useEffect(
    () => () => {
      if (deleting.current) deleting.current.stopped = true;
    },
    [path],
  );

  const deleteRuns = useCallback(
    (ids: number[]) => {
      if (deleting.current || ids.length === 0) return;
      const job = { stopped: false };
      deleting.current = job;
      const total = ids.length;
      setDeletion({ done: 0, total, running: true, error: null });
      void (async () => {
        let done = 0;
        let error: string | null = null;
        for (const id of ids) {
          if (job.stopped) break;
          const started = Date.now();
          try {
            await api.githubDeleteWorkflowRun(path, id);
          } catch (failure) {
            error = errorMessage(failure);
            if (isTokenRefused(failure)) void reloadAccounts();
            break;
          }
          done += 1;
          setDeleted((previous) => new Set(previous).add(id));
          setDeletion({ done, total, running: true, error: null });
          const rest = DELETE_MS - (Date.now() - started);
          if (rest > 0 && done < total) await new Promise((resolve) => window.setTimeout(resolve, rest));
        }
        deleting.current = null;
        setDeletion({ done, total, running: false, error });
        reload();
      })();
    },
    [path, reload, reloadAccounts],
  );

  const stopDeleting = useCallback(() => {
    if (deleting.current) deleting.current.stopped = true;
  }, []);
  const dismissDeletion = useCallback(() => setDeletion(null), []);

  const shown = useMemo(
    () => (runs && deleted.size > 0 ? runs.filter((run) => !deleted.has(run.id)) : runs),
    [runs, deleted],
  );
  const byCommit = useMemo(() => checksByCommit(shown ?? []), [shown]);

  return {
    runs: shown,
    byCommit,
    loading,
    error,
    reload,
    deletion,
    deleteRuns,
    stopDeleting,
    dismissDeletion,
  };
}
