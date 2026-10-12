import { useEffect, useState } from "react";
import { Check, Copy, GitCommitHorizontal, LoaderCircle } from "lucide-react";

import type {
  CommitDetails,
  FileChange,
  FileStatus,
  RefInfo,
  Signature,
  WorkflowRun,
} from "@/bindings";
import { CheckIcon } from "@/components/CheckIcon";
import { RefBadge } from "@/components/RefBadge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CHECK_LABELS, type CommitChecks } from "@/lib/checks";
import { absoluteTime, initials, relativeTime, shortId, splitPath } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface Props {
  details: CommitDetails | null;
  loading: boolean;
  error: string | null;
  refs: RefInfo[];
  /** The workflow runs of the commit, when GitHub has some. */
  checks: CommitChecks | undefined;
  headBranch: string | null;
  /** Path of the file whose diff is open, if any. */
  openFile: string | null;
  onSelectCommit(id: string): void;
  onOpenFile(file: FileChange): void;
  /** Opens the page of a workflow run on GitHub. */
  onOpenRun(run: WorkflowRun): void;
}

export function CommitDetailsPanel({
  details,
  loading,
  error,
  refs,
  checks,
  headBranch,
  openFile,
  onSelectCommit,
  onOpenFile,
  onOpenRun,
}: Props) {
  const { t } = useI18n();
  if (!details) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        {loading ? (
          <LoaderCircle className="size-5 animate-spin" />
        ) : error ? (
          <p className="text-destructive">{error}</p>
        ) : (
          <>
            <GitCommitHorizontal className="size-6" />
            <p>{t("Select a commit to see its details.")}</p>
          </>
        )}
      </div>
    );
  }

  const additions = details.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = details.files.reduce((sum, file) => sum + file.deletions, 0);
  const sameCommitter =
    details.committer.name === details.author.name &&
    details.committer.email === details.author.email &&
    details.committer.time === details.author.time;

  return (
    <div className={cn("app-scroll h-full overflow-y-auto", loading && "opacity-60")}>
      <header className="p-3">
        <h2 className="text-sm leading-snug font-medium break-words">{details.summary}</h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <code className="font-mono">{shortId(details.id)}</code>
          <CopyButton value={details.id} />
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{relativeTime(details.author.time)}</span>
            </TooltipTrigger>
            <TooltipContent>{absoluteTime(details.author.time)}</TooltipContent>
          </Tooltip>
        </div>
        {refs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {refs.map((reference) => (
              <RefBadge
                key={`${reference.kind}:${reference.name}`}
                reference={reference}
                isHead={reference.kind === "localBranch" && reference.name === headBranch}
              />
            ))}
          </div>
        )}
      </header>
      <Separator />

      <section className="space-y-2 p-3">
        <Person label={t("Author")} signature={details.author} />
        {!sameCommitter && <Person label={t("Committer")} signature={details.committer} />}
        {details.parents.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-muted-foreground">
              {details.parents.length > 1 ? t("Parents") : t("Parent")}
            </span>
            <div className="flex flex-wrap gap-1">
              {details.parents.map((parent) => (
                <button
                  key={parent}
                  type="button"
                  className="rounded bg-muted px-1.5 py-0.5 font-mono hover:bg-accent"
                  onClick={() => onSelectCommit(parent)}
                  title={parent}
                >
                  {shortId(parent)}
                </button>
              ))}
            </div>
          </div>
        )}
        {checks && (
          <div className="flex items-start gap-2 text-xs">
            <span className="w-16 shrink-0 py-0.5 text-muted-foreground">{t("Actions")}</span>
            <ul className="min-w-0 flex-1">
              {checks.runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted/60"
                    title={t("Open on GitHub")}
                    onClick={() => onOpenRun(run)}
                  >
                    <CheckIcon state={run.state} className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      {run.workflow} <span className="text-muted-foreground">#{run.number}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">{t(CHECK_LABELS[run.state])}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {details.body && (
        <>
          <Separator />
          <pre className="p-3 font-sans text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {details.body}
          </pre>
        </>
      )}

      <Separator />
      <section>
        <div className="flex items-center justify-between px-3 py-2 text-xs">
          <span className="font-medium">
            {details.files.length === 1
              ? t("1 file changed")
              : t("{n} files changed", { n: details.files.length })}
          </span>
          <span className="font-mono tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{deletions}</span>
          </span>
        </div>
        <ul>
          {details.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              selected={file.path === openFile}
              onClick={() => onOpenFile(file)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function Person({ label, signature }: { label: string; signature: Signature }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold"
        aria-hidden
      >
        {initials(signature.name)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate font-medium">{signature.name}</span>
        </TooltipTrigger>
        <TooltipContent>{signature.email}</TooltipContent>
      </Tooltip>
      <span className="ml-auto shrink-0 text-muted-foreground" title={relativeTime(signature.time)}>
        {absoluteTime(signature.time)}
      </span>
    </div>
  );
}

const STATUS: Record<FileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-emerald-600 dark:text-emerald-400", label: "Added" },
  deleted: { letter: "D", className: "text-red-600 dark:text-red-400", label: "Deleted" },
  modified: { letter: "M", className: "text-amber-600 dark:text-amber-400", label: "Modified" },
  renamed: { letter: "R", className: "text-sky-600 dark:text-sky-400", label: "Renamed" },
  copied: { letter: "C", className: "text-sky-600 dark:text-sky-400", label: "Copied" },
  typeChanged: { letter: "T", className: "text-violet-600 dark:text-violet-400", label: "Type changed" },
  conflicted: { letter: "!", className: "text-red-600 dark:text-red-400", label: "Conflicted" },
};

export function StatusLetter({ status, className }: { status: FileStatus; className?: string }) {
  const { t } = useI18n();
  const { letter, className: color, label } = STATUS[status];
  return (
    <span
      className={cn("inline-block w-3 shrink-0 text-center font-mono text-xs font-semibold", color, className)}
      title={t(label)}
      aria-label={t(label)}
    >
      {letter}
    </span>
  );
}

function FileRow({ file, selected, onClick }: { file: FileChange; selected: boolean; onClick(): void }) {
  const { t } = useI18n();
  const { dir, name } = splitPath(file.path);
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-muted/60",
          selected && "bg-accent text-accent-foreground",
        )}
        onClick={onClick}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <StatusLetter status={file.status} />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground">{dir}</span>
          {name}
        </span>
        {file.binary ? (
          <span className="shrink-0 text-muted-foreground">{t("binary")}</span>
        ) : (
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
          </span>
        )}
      </button>
    </li>
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={t("Copy the full commit id")}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? <Check className="text-emerald-500" /> : <Copy />}
    </Button>
  );
}
