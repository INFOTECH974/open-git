import {
  commands,
  events,
  type AppError,
  type ConflictSide,
  type ItemState,
  type RefKind,
} from "@/bindings";

export { events };

type CommandResult<T> =
  | { status: "ok"; data: T }
  | { status: "error"; error: AppError };

/** A command the backend refused, carrying the structured error it sent. */
export class CommandError extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = "CommandError";
    this.error = error;
  }
}

async function unwrap<T>(result: Promise<CommandResult<T>>): Promise<T> {
  const outcome = await result;
  if (outcome.status === "ok") return outcome.data;
  throw new CommandError(outcome.error);
}

/** The backend commands, with errors thrown instead of returned. */
export const api = {
  // repositories
  openRepository: (path: string) => unwrap(commands.openRepository(path)),
  initRepository: (path: string) => unwrap(commands.initRepository(path)),
  cloneRepository: (url: string, destination: string) =>
    unwrap(commands.cloneRepository(url, destination)),
  /** Stops the network operation running for `path`; resolves to whether there was one. */
  cancelOperation: (path: string) => commands.cancelOperation(path),
  closeRepository: (path: string) => commands.closeRepository(path),
  refreshRepository: (path: string) => unwrap(commands.refreshRepository(path)),
  refs: (path: string) => unwrap(commands.repositoryRefs(path)),
  openInEditor: (path: string, file: string) => unwrap(commands.openInEditor(path, file)),
  revealInFileManager: (path: string, file: string) =>
    unwrap(commands.revealInFileManager(path, file)),

  // history
  commitCount: (path: string) => unwrap(commands.commitCount(path)),
  graphRows: (path: string, offset: number, limit: number) =>
    unwrap(commands.graphRows(path, offset, limit)),
  commitIndex: (path: string, id: string) => unwrap(commands.commitIndex(path, id)),
  searchCommits: (path: string, query: string, limit: number) =>
    unwrap(commands.searchCommits(path, query, limit)),
  commitDetails: (path: string, id: string) => unwrap(commands.commitDetails(path, id)),
  commitFileDiff: (path: string, id: string, file: string) =>
    unwrap(commands.commitFileDiff(path, id, file)),
  commitFileContents: (path: string, id: string, file: string, oldFile: string | null) =>
    unwrap(commands.commitFileContents(path, id, file, oldFile)),

  // working tree
  status: (path: string) => unwrap(commands.workingTreeStatus(path)),
  stageFiles: (path: string, files: string[]) => unwrap(commands.stageFiles(path, files)),
  unstageFiles: (path: string, files: string[]) => unwrap(commands.unstageFiles(path, files)),
  stageAll: (path: string) => unwrap(commands.stageAll(path)),
  unstageAll: (path: string) => unwrap(commands.unstageAll(path)),
  stageHunk: (path: string, file: string, oldFile: string | null, hunk: number) =>
    unwrap(commands.stageHunk(path, file, oldFile, hunk)),
  unstageHunk: (path: string, file: string, oldFile: string | null, hunk: number) =>
    unwrap(commands.unstageHunk(path, file, oldFile, hunk)),
  discardFiles: (path: string, files: string[]) => unwrap(commands.discardFiles(path, files)),
  discardAll: (path: string) => unwrap(commands.discardAll(path)),
  workdirFileDiff: (path: string, file: string, oldFile: string | null, staged: boolean) =>
    unwrap(commands.workdirFileDiff(path, file, oldFile, staged)),
  workdirFileContents: (path: string, file: string, oldFile: string | null, staged: boolean) =>
    unwrap(commands.workdirFileContents(path, file, oldFile, staged)),
  ignore: (path: string, patterns: string[]) => unwrap(commands.ignorePaths(path, patterns)),
  commit: (path: string, message: string, amend: boolean) =>
    unwrap(commands.commit(path, message, amend)),

  // branches and tags
  checkout: (path: string, name: string, kind: RefKind) =>
    unwrap(commands.checkout(path, name, kind)),
  checkoutCommit: (path: string, id: string) => unwrap(commands.checkoutCommit(path, id)),
  createBranch: (path: string, name: string, startPoint: string, checkout: boolean) =>
    unwrap(commands.createBranch(path, name, startPoint, checkout)),
  renameBranch: (path: string, name: string, newName: string) =>
    unwrap(commands.renameBranch(path, name, newName)),
  deleteBranch: (path: string, name: string, force: boolean) =>
    unwrap(commands.deleteBranch(path, name, force)),
  deleteRemoteBranch: (path: string, name: string) =>
    unwrap(commands.deleteRemoteBranch(path, name)),
  pushBranch: (path: string, name: string, remote: string | null) =>
    unwrap(commands.pushBranch(path, name, remote)),
  setUpstream: (path: string, branch: string, upstream: string) =>
    unwrap(commands.setUpstream(path, branch, upstream)),
  createTag: (path: string, name: string, target: string, message: string | null) =>
    unwrap(commands.createTag(path, name, target, message)),
  deleteTag: (path: string, name: string) => unwrap(commands.deleteTag(path, name)),

  // merges and friends
  merge: (path: string, reference: string) => unwrap(commands.merge(path, reference)),
  rebase: (path: string, onto: string) => unwrap(commands.rebase(path, onto)),
  cherryPick: (path: string, id: string) => unwrap(commands.cherryPick(path, id)),
  revert: (path: string, id: string) => unwrap(commands.revert(path, id)),
  abortOperation: (path: string) => unwrap(commands.abortOperation(path)),
  continueOperation: (path: string) => unwrap(commands.continueOperation(path)),
  resolveConflict: (path: string, file: string, side: ConflictSide) =>
    unwrap(commands.resolveConflict(path, file, side)),

  // stashes
  stashList: (path: string) => unwrap(commands.stashList(path)),
  stashPush: (path: string, message: string, includeUntracked: boolean) =>
    unwrap(commands.stashPush(path, message, includeUntracked)),
  stashApply: (path: string, index: number) => unwrap(commands.stashApply(path, index)),
  stashPop: (path: string, index: number) => unwrap(commands.stashPop(path, index)),
  stashDrop: (path: string, index: number) => unwrap(commands.stashDrop(path, index)),

  // remotes
  fetch: (path: string) => unwrap(commands.fetch(path)),
  pull: (path: string) => unwrap(commands.pull(path)),
  push: (path: string) => unwrap(commands.push(path)),

  // GitHub
  githubAccount: () => unwrap(commands.githubAccount()),
  githubSignIn: (token: string) => unwrap(commands.githubSignIn(token)),
  githubSignOut: () => unwrap(commands.githubSignOut()),
  githubDeviceAvailable: () => commands.githubDeviceAvailable(),
  githubDeviceStart: () => unwrap(commands.githubDeviceStart()),
  githubDevicePoll: (deviceCode: string) => unwrap(commands.githubDevicePoll(deviceCode)),
  githubRepository: (path: string) => unwrap(commands.githubRepository(path)),
  githubPullRequests: (path: string, itemState: ItemState) =>
    unwrap(commands.githubPullRequests(path, itemState)),
  githubCreatePullRequest: (
    path: string,
    title: string,
    body: string,
    head: string,
    base: string,
    draft: boolean,
  ) => unwrap(commands.githubCreatePullRequest(path, title, body, head, base, draft)),
  githubIssues: (path: string, itemState: ItemState) =>
    unwrap(commands.githubIssues(path, itemState)),
  githubCreateIssue: (path: string, title: string, body: string) =>
    unwrap(commands.githubCreateIssue(path, title, body)),
  githubIssueComments: (path: string, number: number) =>
    unwrap(commands.githubIssueComments(path, number)),
  githubCommentIssue: (path: string, number: number, body: string) =>
    unwrap(commands.githubCommentIssue(path, number, body)),
  githubCloseIssue: (path: string, number: number) =>
    unwrap(commands.githubCloseIssue(path, number)),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isRepositoryNotOpen(error: unknown): boolean {
  return error instanceof CommandError && error.error.kind === "repositoryNotOpen";
}
