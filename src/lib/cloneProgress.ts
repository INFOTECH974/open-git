/** A clone running in the background, as the interface follows it. */
export interface CloneJob {
  url: string;
  destination: string;
  /** The latest line git printed. */
  message: string;
  /** How far the whole clone is, 0 to 100; `null` until git says something countable. */
  percent: number | null;
}

/**
 * Git clones in phases that each count from 0 to 100%. These are the shares of
 * one bar they get: receiving the objects is nearly all of the wait.
 */
const PHASES: [pattern: RegExp, from: number, to: number][] = [
  [/^(remote: )?Counting objects/, 0, 4],
  [/^(remote: )?Compressing objects/, 4, 8],
  [/^Receiving objects/, 8, 80],
  [/^Resolving deltas/, 80, 94],
  [/^(Updating|Checking out) files/, 94, 100],
];

/**
 * Where the whole clone stands after the progress line `message`, whose own
 * percentage is `percent`; `null` when the line does not tell.
 */
export function overallCloneProgress(message: string, percent: number | null): number | null {
  if (percent === null) return null;
  for (const [pattern, from, to] of PHASES) {
    if (pattern.test(message)) return Math.round(from + ((to - from) * percent) / 100);
  }
  return null;
}

/** `my-repo` for `https://github.com/me/my-repo.git`. */
export function repositoryNameFromUrl(url: string): string {
  const last = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "") || "repository";
}
