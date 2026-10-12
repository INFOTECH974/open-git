import type { CheckState, WorkflowRun } from "@/bindings";

/** Whether GitHub is still working on it, which is when it is worth asking again soon. */
export function isRunning(state: CheckState): boolean {
  return state === "queued" || state === "inProgress";
}

/** The English name of each state, to pass through `t`. */
export const CHECK_LABELS: Record<CheckState, string> = {
  queued: "Queued",
  waiting: "Waiting for approval",
  inProgress: "In progress",
  success: "Succeeded",
  failure: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  neutral: "No verdict",
};

// Which state speaks for several runs: anything unfinished first, as on
// github.com, then the worst verdict.
const PRECEDENCE: CheckState[] = [
  "inProgress",
  "queued",
  "waiting",
  "failure",
  "cancelled",
  "success",
  "neutral",
  "skipped",
];

/** The workflow runs of one commit, and the state that sums them up. */
export interface CommitChecks {
  state: CheckState;
  /** The latest run of each workflow, newest first. */
  runs: WorkflowRun[];
}

/** Groups `runs` (newest first) by the commit they ran on. */
export function checksByCommit(runs: WorkflowRun[]): Map<string, CommitChecks> {
  const byCommit = new Map<string, CommitChecks>();
  for (const run of runs) {
    const checks = byCommit.get(run.commit);
    if (!checks) {
      byCommit.set(run.commit, { state: run.state, runs: [run] });
    } else if (!checks.runs.some((newer) => newer.workflow === run.workflow)) {
      // An older run of the same workflow was superseded; it does not count.
      checks.runs.push(run);
      if (PRECEDENCE.indexOf(run.state) < PRECEDENCE.indexOf(checks.state)) checks.state = run.state;
    }
  }
  return byCommit;
}
