import { type ComponentType, type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import {
  Archive,
  Copy,
  ExternalLink,
  EyeOff,
  FolderOpen,
  GitCommitHorizontal,
  LoaderCircle,
  Minus,
  Plus,
  Undo2,
} from "lucide-react";

import type { ConflictSide, Identity, StatusEntry, WorkingTreeStatus } from "@/bindings";
import { StatusLetter } from "@/components/CommitDetailsPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { Operation } from "@/hooks/useRepository";
import { api } from "@/lib/api";
import { joinPath, splitPath } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { ignoreChoices } from "@/lib/ignore";
import { cn } from "@/lib/utils";

/** The working tree file whose diff is open in the centre pane. */
export interface OpenWorktreeFile {
  path: string;
  staged: boolean;
}

interface Props {
  /** Root of the working tree, for "copy absolute path" and the amend prefill. */
  repoPath: string;
  status: WorkingTreeStatus;
  operation: Operation | null;
  openFile: OpenWorktreeFile | null;
  /** From `user.name` and `user.email`; `null` when not configured. */
  author: Identity | null;
  /** The commit an amend would replace; `null` in an empty repository. */
  headId: string | null;
  onStage(entries: StatusEntry[]): void;
  onUnstage(entries: StatusEntry[]): void;
  onStageAll(): void;
  onUnstageAll(): void;
  /** Throws away the unstaged changes of `entries` (asks for confirmation first). */
  onDiscard(entries: StatusEntry[]): void;
  onDiscardAll(): void;
  /** Appends `patterns` to the root `.gitignore`. */
  onIgnore(patterns: string[]): void;
  onOpenInEditor(path: string): void;
  onReveal(path: string): void;
  onStash(): void;
  onOpenFile(entry: StatusEntry, staged: boolean): void;
  /** Keeps one side of a conflicted file whole and marks it resolved. */
  onResolveConflict(path: string, side: ConflictSide): void;
  /** Resolves to whether the commit was created. */
  onCommit(message: string, amend: boolean): Promise<boolean>;
}

/** Uncommitted changes: what to stage, and the commit to make of it. */
export function WorkInProgressPanel({
  repoPath,
  status,
  operation,
  openFile,
  author,
  headId,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onDiscard,
  onDiscardAll,
  onIgnore,
  onOpenInEditor,
  onReveal,
  onStash,
  onOpenFile,
  onResolveConflict,
  onCommit,
}: Props) {
  const { t } = useI18n();
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const busy = operation !== null;
  const committing = operation === "commit";
  const canCommit =
    (status.staged.length > 0 || amend) && summary.trim().length > 0 && !busy && author !== null;

  // Amending starts from the message of the commit being replaced.
  useEffect(() => {
    if (!amend || !headId) return;
    let cancelled = false;
    api.commitDetails(repoPath, headId).then(
      (details) => {
        if (cancelled) return;
        setSummary((current) => current || details.summary);
        setDescription((current) => current || details.body);
      },
      () => {
        // Without the previous message the fields simply stay as they are.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [amend, headId, repoPath]);

  const commit = async () => {
    if (!canCommit) return;
    const message = description.trim()
      ? `${summary.trim()}\n\n${description.trim()}\n`
      : `${summary.trim()}\n`;
    if (await onCommit(message, amend)) {
      setSummary("");
      setDescription("");
      setAmend(false);
    }
  };

  const submitOnCtrlEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void commit();
    }
  };

  const total = status.staged.length + status.unstaged.length + status.conflicted.length;
  const common = { repoPath, disabled: busy, onOpenInEditor, onReveal };

  return (
    <div className="flex h-full flex-col">
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto">
        <header className="flex items-start gap-2 p-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">{t("Uncommitted changes")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {total === 1
                ? t("1 file changed in the working tree")
                : t("{n} files changed in the working tree", { n: total })}
            </p>
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={onStash}
            disabled={busy || total === 0}
            title={t("Save the changes aside and clean the working tree")}
          >
            <Archive />
            {t("Stash…")}
          </Button>
        </header>
        <Separator />

        {status.conflicted.length > 0 && (
          <>
            <Section title={t("Conflicts")} count={status.conflicted.length}>
              {status.conflicted.map((path) => (
                <FileRow
                  key={path}
                  entry={{ path, oldPath: null, status: "conflicted" }}
                  selected={false}
                  {...common}
                  action={{
                    icon: Plus,
                    label: t("Mark as resolved"),
                    onClick: () => onStage([{ path, oldPath: null, status: "conflicted" }]),
                  }}
                  onKeepSide={(side) => onResolveConflict(path, side)}
                />
              ))}
            </Section>
            <Separator />
          </>
        )}

        <Section
          title={t("Unstaged")}
          count={status.unstaged.length}
          action={
            <>
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={onDiscardAll}
                disabled={busy || status.unstaged.length === 0}
              >
                {t("Discard all…")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={onStageAll}
                disabled={busy || status.unstaged.length === 0}
              >
                {t("Stage all")}
              </Button>
            </>
          }
        >
          {status.unstaged.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              selected={openFile?.path === entry.path && !openFile.staged}
              {...common}
              onClick={() => onOpenFile(entry, false)}
              action={{ icon: Plus, label: t("Stage"), onClick: () => onStage([entry]) }}
              onDiscard={() => onDiscard([entry])}
              // Only an untracked file disappears once ignored; a tracked one stays tracked.
              onIgnore={entry.status === "added" ? onIgnore : undefined}
            />
          ))}
        </Section>
        <Separator />

        <Section
          title={t("Staged")}
          count={status.staged.length}
          action={
            <Button
              variant="ghost"
              size="xs"
              onClick={onUnstageAll}
              disabled={busy || status.staged.length === 0}
            >
              {t("Unstage all")}
            </Button>
          }
        >
          {status.staged.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              selected={openFile?.path === entry.path && openFile.staged}
              {...common}
              onClick={() => onOpenFile(entry, true)}
              action={{ icon: Minus, label: t("Unstage"), onClick: () => onUnstage([entry]) }}
            />
          ))}
        </Section>
      </div>

      <form
        className="shrink-0 space-y-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <input
          className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder={t("Summary")}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={submitOnCtrlEnter}
          maxLength={200}
          aria-label={t("Commit summary")}
        />
        <textarea
          className="min-h-16 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder={t("Description (optional)")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={submitOnCtrlEnter}
          aria-label={t("Commit description")}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="amend"
            checked={amend}
            disabled={busy || !headId}
            onCheckedChange={(checked) => setAmend(checked === true)}
          />
          <Label htmlFor="amend" className="text-xs font-normal">
            {t("Amend the last commit")}
          </Label>
        </div>
        <p
          className="truncate text-xs text-muted-foreground"
          title={author ? `${author.name} <${author.email}>` : undefined}
        >
          {author ? (
            <>
              {t("Committing as")} <span className="text-foreground">{author.name}</span>
            </>
          ) : (
            <span className="text-destructive">
              {t("Set user.name and user.email in your Git configuration to commit.")}
            </span>
          )}
        </p>
        <Button type="submit" className="w-full" disabled={!canCommit} title="Ctrl+Enter">
          {committing ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
          {amend
            ? t("Amend the last commit")
            : status.staged.length === 0
              ? t("Stage files to commit")
              : status.staged.length === 1
                ? t("Commit 1 file")
                : t("Commit {n} files", { n: status.staged.length })}
        </Button>
      </form>
    </div>
  );
}

interface SectionProps {
  title: string;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}

function Section({ title, count, action, children }: SectionProps) {
  const { t } = useI18n();
  return (
    <section>
      <div className="flex h-8 items-center justify-between pr-1 pl-3 text-xs">
        <span className="font-medium">
          {title} <span className="text-muted-foreground">({count})</span>
        </span>
        <span className="flex items-center">{action}</span>
      </div>
      {count === 0 ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">{t("Nothing here.")}</p>
      ) : (
        <ul className="pb-1">{children}</ul>
      )}
    </section>
  );
}

interface FileRowProps {
  entry: StatusEntry;
  repoPath: string;
  selected: boolean;
  disabled: boolean;
  onClick?(): void;
  /** The stage or unstage button shown on hover, also offered in the context menu. */
  action?: {
    icon: ComponentType<{ className?: string }>;
    label: string;
    onClick(): void;
  };
  onDiscard?(): void;
  /** When given, the context menu offers to add the file to `.gitignore`. */
  onIgnore?(patterns: string[]): void;
  /** For a conflicted file: keep one side whole. */
  onKeepSide?(side: ConflictSide): void;
  onOpenInEditor(path: string): void;
  onReveal(path: string): void;
}

function FileRow({
  entry,
  repoPath,
  selected,
  disabled,
  onClick,
  action,
  onDiscard,
  onIgnore,
  onKeepSide,
  onOpenInEditor,
  onReveal,
}: FileRowProps) {
  const { t } = useI18n();
  const { dir, name } = splitPath(entry.path);
  const choices = ignoreChoices(entry.path);
  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const deleted = entry.status === "deleted";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="group flex items-center">
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 pl-3 text-left text-xs hover:bg-muted/60",
              selected && "bg-accent text-accent-foreground",
            )}
            onClick={onClick}
            title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
          >
            <StatusLetter status={entry.status} />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">{dir}</span>
              {name}
            </span>
          </button>
          {action && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={`${action.label} ${entry.path}`}
              title={action.label}
              disabled={disabled}
              onClick={action.onClick}
            >
              <action.icon />
            </Button>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        {onKeepSide && (
          <>
            <ContextMenuItem onSelect={() => onKeepSide("ours")} disabled={disabled}>
              {t("Keep ours (the checked-out branch)")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onKeepSide("theirs")} disabled={disabled}>
              {t("Keep theirs (the incoming changes)")}
            </ContextMenuItem>
          </>
        )}
        {action && (
          <ContextMenuItem onSelect={action.onClick} disabled={disabled}>
            <action.icon />
            {action.label}
          </ContextMenuItem>
        )}
        {onDiscard && (
          <ContextMenuItem onSelect={onDiscard} disabled={disabled} variant="destructive">
            <Undo2 />
            {t("Discard changes…")}
          </ContextMenuItem>
        )}
        {onIgnore && (
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={disabled}>
              <EyeOff />
              {t("Ignore")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-72">
              <ContextMenuItem onSelect={() => onIgnore([choices.file])}>
                <span className="min-w-0 truncate">
                  {t("Ignore")} <code className="font-mono">{name}</code>
                </span>
              </ContextMenuItem>
              {choices.extension && (
                <ContextMenuItem onSelect={() => onIgnore([choices.extension!])}>
                  <span className="min-w-0 truncate">
                    {t("Ignore all")} <code className="font-mono">{choices.extension}</code> {t("files")}
                  </span>
                </ContextMenuItem>
              )}
              {choices.folders.length > 0 && <ContextMenuSeparator />}
              {choices.folders.map((folder) => (
                <ContextMenuItem key={folder.pattern} onSelect={() => onIgnore([folder.pattern])}>
                  <span className="min-w-0 truncate">
                    {t("Ignore folder")} <code className="font-mono">{folder.label}</code>
                  </span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {(action || onDiscard || onIgnore) && <ContextMenuSeparator />}
        <ContextMenuItem disabled={deleted} onSelect={() => onOpenInEditor(entry.path)}>
          <ExternalLink />
          {t("Open in editor")}
        </ContextMenuItem>
        <ContextMenuItem disabled={deleted} onSelect={() => onReveal(entry.path)}>
          <FolderOpen />
          {t("Show in file manager")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copy(entry.path)}>
          <Copy />
          {t("Copy path")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(joinPath(repoPath, entry.path))}>
          <Copy />
          {t("Copy absolute path")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
