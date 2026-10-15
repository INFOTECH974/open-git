import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleArrowUp, CircleCheck, Download, ExternalLink, LoaderCircle, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { RELEASES_URL, REPOSITORY_URL, useUpdate } from "@/lib/update";
import { cn } from "@/lib/utils";

/**
 * The running version and its update: looks for a newer release, then
 * downloads it, installs it and restarts the application.
 */
export function UpdateDialog() {
  const { t } = useI18n();
  const update = useUpdate();
  const { available, installing, percent } = update;
  const current = update.currentVersion ?? "…";

  return (
    <Dialog
      open={update.dialogOpen}
      // The installation cannot be stopped half-way: the dialog stays until it ends.
      onOpenChange={(open) => !open && !installing && update.closeDialog()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{available ? t("Update available") : t("About Open GIT")}</DialogTitle>
          <DialogDescription>
            {available
              ? t("Open GIT {version} can be installed; this is version {current}.", {
                  version: available,
                  current,
                })
              : t("Version {version}", { version: current })}
          </DialogDescription>
        </DialogHeader>

        {installing ? (
          <div className="space-y-2" role="status">
            <p className="text-sm">
              {percent == null
                ? t("Downloading the update…")
                : percent < 100
                  ? t("Downloading the update… {percent}%", { percent })
                  : t("Installing; the application is about to restart…")}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full bg-primary transition-[width] duration-300",
                  percent == null && "w-1/3 animate-pulse",
                )}
                style={percent != null ? { width: `${percent}%` } : undefined}
              />
            </div>
          </div>
        ) : available ? (
          <div className="space-y-2 text-sm">
            <p>
              {t("The update is downloaded from the GitHub release, checked against the signature of Open GIT, then the application restarts. Your open repositories come back.")}
            </p>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-muted-foreground underline hover:text-foreground"
              onClick={() => void openUrl(`${RELEASES_URL}/tag/v${available}`)}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("What changed in {version}", { version: available })}
            </button>
          </div>
        ) : update.checking ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {t("Looking for a newer version…")}
          </p>
        ) : (
          update.upToDate &&
          !update.error && (
            <p className="flex items-center gap-2 text-sm" role="status">
              <CircleCheck className="size-4 text-emerald-500" aria-hidden />
              {t("Open GIT is up to date.")}
            </p>
          )
        )}

        {!available && !installing && (
          <button
            type="button"
            className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground underline hover:text-foreground"
            onClick={() => void openUrl(REPOSITORY_URL)}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t("Source code and releases on GitHub")}
          </button>
        )}

        {update.error && <p className="text-sm break-words text-destructive">{update.error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={installing} onClick={update.closeDialog}>
            {available ? t("Later") : t("Close")}
          </Button>
          {available ? (
            <Button type="button" disabled={installing} onClick={() => void update.install()}>
              {installing ? <LoaderCircle className="animate-spin" /> : <Download />}
              {t("Install and restart")}
            </Button>
          ) : (
            <Button type="button" disabled={update.checking} onClick={() => void update.check()}>
              <RefreshCw className={cn(update.checking && "animate-spin")} />
              {t("Check for updates")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Says, under the tabs, that a newer version is out, until it is installed or
 * the banner is closed for that version.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const update = useUpdate();
  const { available } = update;
  if (!available || update.dismissed || update.installing) return null;
  return (
    <div
      className="flex items-center gap-2 border-b border-emerald-600/30 bg-emerald-500/10 px-3 py-1.5 text-sm"
      role="status"
    >
      <CircleArrowUp className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">{t("Open GIT {version} is available.", { version: available })}</span>{" "}
        {update.currentVersion && (
          <span className="text-muted-foreground">
            {t("You have version {current}.", { current: update.currentVersion })}
          </span>
        )}
      </p>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => void openUrl(`${RELEASES_URL}/tag/v${available}`)}
      >
        <ExternalLink />
        {t("What changed")}
      </Button>
      <Button
        size="xs"
        className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
        onClick={() => {
          // The dialog follows the download, which cannot be stopped half-way.
          update.openDialog();
          void update.install();
        }}
      >
        <Download />
        {t("Install and restart")}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label={t("Not now")}
        title={t("Not now")}
        onClick={update.dismiss}
      >
        <X />
      </Button>
    </div>
  );
}
