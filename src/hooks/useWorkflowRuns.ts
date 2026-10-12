import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkflowRun } from "@/bindings";
import { api, errorMessage } from "@/lib/api";
import { type CommitChecks, checksByCommit, isRunning } from "@/lib/checks";
import { useGitHub } from "@/lib/github";

/** While a run is queued or in progress, GitHub is asked again this often. */
export const LIVE_POLL_MS = 5_000;
/** Otherwise, often enough to notice a run started from elsewhere. */
const IDLE_POLL_MS = 60_000;
/** GitHub creates the runs a few seconds after a push: look closely for this long. */
const EXPECTING_MS = 45_000;

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
}

/**
 * Follows the workflow runs of the repository at `path`. GitHub cannot notify a
 * desktop application, so it is asked again and again: every few seconds while
 * something runs or was just pushed, every minute otherwise, and only for the
 * visible tab of a visible window. `remoteTips` is any string that changes when
 * a remote branch moves, which is when new runs are to be expected.
 */
export function useWorkflowRuns(path: string, active: boolean, remoteTips: string): WorkflowRuns {
  const { account } = useGitHub();
  const [onGitHub, setOnGitHub] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const expectingUntil = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api.githubRepository(path).then(
      (found) => {
        if (!cancelled) setOnGitHub(found !== null);
      },
      () => {
        if (!cancelled) setOnGitHub(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const signedIn = account !== null;
  useEffect(() => {
    if (signedIn) return;
    setRuns(null);
    setError(null);
  }, [signedIn]);

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

  const enabled = active && onGitHub && signedIn;
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
  }, [enabled, path, reloads]);

  const byCommit = useMemo(() => checksByCommit(runs ?? []), [runs]);

  return { runs, byCommit, loading, error, reload };
}
