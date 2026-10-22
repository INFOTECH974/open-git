import { type ReactNode, useEffect, useState } from "react";
import { GitCommitVertical, GitMerge } from "lucide-react";

import type { PullMode } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";

/** A branch and its upstream that both have commits of their own. */
export interface DivergedBranches {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
}

/**
 * Asked when Pull finds diverged branches and the Git configuration does not say
 * how to join them: merge or rebase, and whether to always do so here.
 */
export function PullChoiceDialog({
  diverged,
  onChoose,
  onClose,
}: {
  diverged: DivergedBranches | null;
  onChoose: (mode: PullMode, remember: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    if (diverged) setRemember(false);
  }, [diverged]);

  const choice = (mode: PullMode, icon: ReactNode, title: ReactNode, detail: string) => (
    <Button
      variant="outline"
      className="h-auto justify-start py-2 text-left"
      onClick={() => onChoose(mode, remember)}
    >
      {icon}
      <span className="min-w-0">
        <span className="block truncate">{title}</span>
        <span className="block text-xs whitespace-normal text-muted-foreground">{detail}</span>
      </span>
    </Button>
  );

  return (
    <Dialog open={diverged !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {diverged && (
          <>
            <DialogHeader>
              <DialogTitle>{t("The branches have diverged")}</DialogTitle>
              <DialogDescription>
                {t(
                  "{branch} and {upstream} each have commits the other lacks (↑{ahead} ↓{behind}). How should they be joined?",
                  {
                    branch: diverged.branch,
                    upstream: diverged.upstream,
                    ahead: String(diverged.ahead),
                    behind: String(diverged.behind),
                  },
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {choice(
                "rebase",
                <GitCommitVertical />,
                <>
                  {t("Rebase")} <code className="font-mono">{diverged.branch}</code> {t("onto")}{" "}
                  <code className="font-mono">{diverged.upstream}</code>
                </>,
                t("Replays your commits on top of {upstream}: the history stays in a straight line.", {
                  upstream: diverged.upstream,
                }),
              )}
              {choice(
                "merge",
                <GitMerge />,
                <>
                  {t("Merge")} <code className="font-mono">{diverged.upstream}</code> {t("into")}{" "}
                  <code className="font-mono">{diverged.branch}</code>
                </>,
                t("Joins both sides with a merge commit on {branch}.", { branch: diverged.branch }),
              )}
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="pull-remember"
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked === true)}
              />
              <Label htmlFor="pull-remember" className="font-normal">
                {t("Always do this when pulling in this repository")}
              </Label>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t("Cancel")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
