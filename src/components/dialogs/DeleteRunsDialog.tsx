import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";

import type { WorkflowRun } from "@/bindings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, errorMessage, isTokenRefused } from "@/lib/api";
import { useGitHub } from "@/lib/github";
import { useI18n } from "@/lib/i18n";

/** What to delete: one run, or every run of the repository that is over. */
export type RunsToDelete = { kind: "finished" } | { kind: "one"; run: WorkflowRun };

/** GitHub lists this many finished runs at most. */
const LISTED_AT_MOST = 1000;

interface Props {
  repoPath: string;
  /** `null` closes the dialog. */
  request: RunsToDelete | null;
  onClose(): void;
  onDelete(ids: number[]): void;
}

/** Asks before deleting workflow runs; the finished ones are counted first. */
export function DeleteRunsDialog({ repoPath, request, onClose, onDelete }: Props) {
  const { t } = useI18n();
  const { reload: reloadAccounts } = useGitHub();
  // What was asked last, still shown while the dialog closes.
  const [asked, setAsked] = useState<RunsToDelete | null>(null);
  const [ids, setIds] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setAsked(request);
    setError(null);
    if (request.kind === "one") {
      setIds([request.run.id]);
      return;
    }
    setIds(null);
    let stopped = false;
    api.githubFinishedWorkflowRuns(repoPath).then(
      (found) => {
        if (!stopped) setIds(found);
      },
      (failure) => {
        if (stopped) return;
        setError(errorMessage(failure));
        if (isTokenRefused(failure)) void reloadAccounts();
      },
    );
    return () => {
      stopped = true;
    };
  }, [request, repoPath, reloadAccounts]);

  const count = ids?.length ?? 0;
  let description;
  if (asked?.kind === "one") {
    description = t("The run will be deleted from GitHub, with its logs and artifacts. This cannot be undone.");
  } else if (error) {
    description = <span className="text-destructive">{error}</span>;
  } else if (!ids) {
    description = (
      <span className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("Counting the finished runs…")}
      </span>
    );
  } else if (count === 0) {
    description = t("No run is finished: there is nothing to delete.");
  } else {
    description = (
      <>
        <p>
          {count === 1
            ? t("1 finished run will be deleted from GitHub, with its logs and artifacts.")
            : t("{n} finished runs will be deleted from GitHub, with their logs and artifacts.", { n: count })}{" "}
          {t("Queued and running ones are kept. This cannot be undone.")}
        </p>
        {count >= LISTED_AT_MOST && (
          <p className="mt-2">{t("GitHub lists a thousand at most: delete again for the older ones.")}</p>
        )}
      </>
    );
  }

  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {asked?.kind === "one"
              ? t("Delete {workflow} #{number}?", { workflow: asked.run.workflow, number: asked.run.number })
              : t("Delete the finished runs?")}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{error || (ids && count === 0) ? t("Close") : t("Cancel")}</AlertDialogCancel>
          {count > 0 && (
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (ids) onDelete(ids);
                onClose();
              }}
            >
              {count === 1 ? t("Delete the run") : t("Delete {n} runs", { n: count })}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
