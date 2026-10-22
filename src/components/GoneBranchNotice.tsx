import { GitBranch, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export interface GoneBranch {
  /** The local branch whose remote branch was deleted. */
  branch: string;
  /** That remote branch, such as `origin/feature`. */
  upstream: string;
  /** The branch to go to instead, such as `main`. */
  target: string;
  /** Whether the application already went there. */
  switched: boolean;
}

interface Props {
  gone: GoneBranch;
  busy: boolean;
  onSwitch(): void;
  onDelete(): void;
  onDismiss(): void;
}

/**
 * Says that the checked-out branch was deleted on the remote (merged, most of
 * the time), and that the application moved to the default branch, or offers to
 * when local changes kept it from doing so.
 */
export function GoneBranchNotice({ gone, busy, onSwitch, onDelete, onDismiss }: Props) {
  const { t } = useI18n();
  const vars = { branch: gone.branch, upstream: gone.upstream, target: gone.target };
  return (
    <div className="border-b px-3 py-2 text-[11px]" role="status">
      <div className="flex items-start gap-1.5">
        <GitBranch className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1">
          {gone.switched
            ? t("{upstream} was deleted on the remote: switched to {target}.", vars)
            : t("{upstream} was deleted on the remote. Commit or stash your changes to leave {branch}.", vars)}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-mt-0.5 text-muted-foreground"
          aria-label={t("Close")}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {gone.switched ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={onDelete} title={`git branch -d ${gone.branch}`}>
            {t("Delete {branch}", vars)}
          </Button>
        ) : (
          <Button variant="outline" size="xs" disabled={busy} onClick={onSwitch}>
            {t("Switch to {target}", vars)}
          </Button>
        )}
      </div>
    </div>
  );
}
