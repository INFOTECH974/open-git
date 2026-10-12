import { type ReactNode, useEffect, useState } from "react";
import { LoaderCircle, Minus, Plus, WrapText, X } from "lucide-react";

import type { DiffLine, FileContents, FileDiff, FileStatus, Hunk } from "@/bindings";
import { CodeDiff, type DiffMode } from "@/components/CodeDiff";
import { StatusLetter } from "@/components/CommitDetailsPanel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The file whose changes are shown; stats come from the diff once loaded. */
export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
}

/** Offered on every hunk of a working tree diff. */
export interface HunkAction {
  label: "Stage hunk" | "Unstage hunk";
  disabled: boolean;
  onClick(hunk: number): void;
}

/** How the changes are laid out: by hunk (with staging), or whole file. */
type ViewMode = "hunks" | DiffMode;

interface Props {
  file: DiffFile;
  /** Where the changes come from, such as "in 3223721" or "unstaged". */
  context: ReactNode;
  diff: FileDiff | null;
  /** Both sides of the file, for the whole-file modes; `null` while loading. */
  contents: FileContents | null;
  loading: boolean;
  error: string | null;
  hunkAction?: HunkAction;
  /** Remembers the chosen mode separately for commits and the working tree. */
  modeKey: "commit" | "worktree";
  onClose(): void;
}

const MODES: { value: ViewMode; label: string; hint: string }[] = [
  { value: "hunks", label: "Hunks", hint: "Changed regions only, with staging" },
  { value: "unified", label: "Unified", hint: "Whole file, old and new lines interleaved" },
  { value: "split", label: "Split", hint: "Whole file, old and new side by side" },
];

function loadMode(key: string, fallback: ViewMode): ViewMode {
  try {
    const stored = localStorage.getItem(`open-git.diffMode.${key}`);
    return MODES.some((mode) => mode.value === stored) ? (stored as ViewMode) : fallback;
  } catch {
    return fallback;
  }
}

/** The changes to one file, by hunk or as a whole. */
export function FileDiffView({
  file,
  context,
  diff,
  contents,
  loading,
  error,
  hunkAction,
  modeKey,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<ViewMode>(() =>
    loadMode(modeKey, modeKey === "worktree" ? "hunks" : "unified"),
  );
  const [wrap, setWrap] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(`open-git.diffMode.${modeKey}`, mode);
    } catch {
      // Storage may be unavailable; the choice then lasts for this session.
    }
  }, [mode, modeKey]);

  const stats = diff ? countChanges(diff) : null;
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <StatusLetter status={file.status} />
        <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
          {file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{context}</span>
        {stats && !diff?.binary && (
          <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{stats.deletions}</span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div role="radiogroup" className="flex rounded-md border p-0.5" aria-label={t("Diff layout")}>
            {MODES.map((option) => (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === option.value}
                    className={cn(
                      "rounded px-2 py-0.5 text-xs",
                      mode === option.value
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setMode(option.value)}
                  >
                    {t(option.label)}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t(option.hint)}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          {mode !== "hunks" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-pressed={wrap}
                  aria-label={t("Wrap long lines")}
                  className={cn(wrap && "bg-muted")}
                  onClick={() => setWrap((value) => !value)}
                >
                  <WrapText />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Wrap long lines")}</TooltipContent>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Close the diff")}
            title={t("Close (Esc)")}
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </header>
      <div className={cn("min-h-0 flex-1", mode === "hunks" ? "app-scroll overflow-auto" : "overflow-hidden")}>
        {mode === "hunks" ? (
          <HunksBody diff={diff} loading={loading} error={error} file={file} hunkAction={hunkAction} />
        ) : (
          <WholeFileBody
            path={file.path}
            contents={contents}
            loading={loading}
            error={error}
            mode={mode}
            wrap={wrap}
          />
        )}
      </div>
    </div>
  );
}

function countChanges(diff: FileDiff): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "addition") additions++;
      else if (line.kind === "deletion") deletions++;
    }
  }
  return { additions, deletions };
}

function WholeFileBody({
  path,
  contents,
  loading,
  error,
  mode,
  wrap,
}: {
  path: string;
  contents: FileContents | null;
  loading: boolean;
  error: string | null;
  mode: DiffMode;
  wrap: boolean;
}) {
  const { t } = useI18n();
  if (error) return <Notice className="text-destructive">{error}</Notice>;
  if (!contents) {
    return (
      <Notice>{loading ? <LoaderCircle className="size-5 animate-spin" /> : t("No content loaded.")}</Notice>
    );
  }
  if (contents.binary) return <Notice>{t("Binary file, no textual diff to show.")}</Notice>;
  if (contents.tooLarge) return <Notice>{t("This file is too large to show whole; use the hunk view.")}</Notice>;
  return <CodeDiff path={path} contents={contents} mode={mode} wrap={wrap} />;
}

function HunksBody({
  diff,
  loading,
  error,
  file,
  hunkAction,
}: {
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  file: DiffFile;
  hunkAction?: HunkAction;
}) {
  const { t } = useI18n();
  if (error) return <Notice className="text-destructive">{error}</Notice>;
  if (!diff) {
    return (
      <Notice>{loading ? <LoaderCircle className="size-5 animate-spin" /> : t("No diff loaded.")}</Notice>
    );
  }
  if (diff.binary) return <Notice>{t("Binary file, no textual diff to show.")}</Notice>;
  if (diff.hunks.length === 0) {
    return (
      <Notice>
        {file.oldPath
          ? t("Renamed from {path} without changing its content.", { path: file.oldPath })
          : t("No textual changes.")}
      </Notice>
    );
  }
  return (
    <table className="w-full border-collapse font-mono text-xs leading-5" style={{ tabSize: 4 }}>
      <tbody>
        {diff.hunks.map((hunk, index) => (
          <HunkRows key={index} hunk={hunk} index={index} action={hunkAction} />
        ))}
      </tbody>
    </table>
  );
}

function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function HunkRows({ hunk, index, action }: { hunk: Hunk; index: number; action?: HunkAction }) {
  const { t } = useI18n();
  return (
    <>
      <tr className="bg-muted/60 text-muted-foreground">
        <td colSpan={3} className="sticky left-0 w-[7.5rem] bg-muted/60 px-2 py-0.5 select-none">
          {action && (
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 font-sans text-[11px]"
              disabled={action.disabled}
              onClick={() => action.onClick(index)}
            >
              {action.label === "Stage hunk" ? <Plus /> : <Minus />}
              {t(action.label)}
            </Button>
          )}
        </td>
        <td className="px-2 py-0.5 whitespace-pre">{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, lineIndex) => (
        <LineRow key={lineIndex} line={line} />
      ))}
    </>
  );
}

const LINE_STYLES = {
  context: { row: "", sign: " " },
  addition: {
    row: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    sign: "+",
  },
  deletion: { row: "bg-red-500/10 text-red-800 dark:text-red-200", sign: "−" },
  noNewline: { row: "text-muted-foreground italic", sign: " " },
} as const;

function LineRow({ line }: { line: DiffLine }) {
  const style = LINE_STYLES[line.kind];
  return (
    <tr className={style.row}>
      <td className="w-12 min-w-12 px-2 text-right align-top text-muted-foreground tabular-nums select-none">
        {line.oldLineno ?? ""}
      </td>
      <td className="w-12 min-w-12 px-2 text-right align-top text-muted-foreground tabular-nums select-none">
        {line.newLineno ?? ""}
      </td>
      <td className="w-6 min-w-6 text-center align-top select-none">{style.sign}</td>
      <td className="pr-4 align-top whitespace-pre">{line.content}</td>
    </tr>
  );
}
