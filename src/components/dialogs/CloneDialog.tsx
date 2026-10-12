import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Archive, BookMarked, FolderOpen, GitFork, LoaderCircle, Lock, RefreshCw, Search } from "lucide-react";

import type { RemoteRepository } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { type CloneJob, repositoryNameFromUrl } from "@/lib/cloneProgress";
import { joinPath, relativeTime } from "@/lib/format";
import { useGitHub } from "@/lib/github";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The folder the last clone went into, offered again next time. */
const PARENT_KEY = "open-git.cloneParent";

function loadParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? "";
  } catch {
    return "";
  }
}

interface Props {
  open: boolean;
  /** The clone under way; the dialog then shows its progress instead of the form. */
  job: CloneJob | null;
  /** Why the last clone failed. */
  error: string | null;
  onClone(url: string, destination: string): void;
  /** Stops the clone under way. */
  onCancel(): void;
  /** Closes the dialog; a clone under way carries on. */
  onClose(): void;
}

/**
 * Picks what to clone (one of the account's GitHub repositories, or any URL)
 * and where, then follows the clone.
 */
export function CloneDialog({ open, job, error, onClone, onCancel, onClose }: Props) {
  const { t } = useI18n();
  const github = useGitHub();
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(loadParent);
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  // `null` until the list was asked for; kept between two openings of the dialog.
  const [repositories, setRepositories] = useState<RemoteRepository[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const login = github.account?.login ?? null;

  const loadRepositories = useCallback(() => {
    setLoading(true);
    setListError(null);
    api.githubRepositories().then(
      (found) => {
        setRepositories(found);
        setLoading(false);
      },
      (failure) => {
        setListError(errorMessage(failure));
        setLoading(false);
      },
    );
  }, []);

  // Another account sees other repositories.
  useEffect(() => {
    setRepositories(null);
    setListError(null);
  }, [login]);

  useEffect(() => {
    if (open && login && repositories === null && !loading && !listError) loadRepositories();
  }, [open, login, repositories, loading, listError, loadRepositories]);

  // A dialog opened for a new clone starts empty; one reopened on a clone that
  // runs or failed keeps what was typed.
  useEffect(() => {
    if (!open || job || error) return;
    setUrl("");
    setName("");
    setFilter("");
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!repositories || !needle) return repositories ?? [];
    return repositories.filter(
      (repository) =>
        repository.fullName.toLowerCase().includes(needle) ||
        repository.description.toLowerCase().includes(needle),
    );
  }, [repositories, filter]);

  const derivedName = url.trim() ? repositoryNameFromUrl(url.trim()) : "";
  const complete = url.trim() !== "" && parent.trim() !== "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!complete) return;
    try {
      localStorage.setItem(PARENT_KEY, parent.trim());
    } catch {
      // Storage may be unavailable; the folder is then asked again next time.
    }
    onClone(url.trim(), joinPath(parent.trim(), name.trim() || derivedName));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {job ? (
          <CloneProgress job={job} onCancel={onCancel} onClose={onClose} />
        ) : (
          <form onSubmit={submit} className="min-w-0 space-y-4">
            <DialogHeader>
              <DialogTitle>{t("Clone a repository")}</DialogTitle>
              <DialogDescription>
                {t("The clone is made with your own git, so your SSH keys and credential helper apply.")}
              </DialogDescription>
            </DialogHeader>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm whitespace-pre-wrap text-destructive" role="alert">
                {error}
              </p>
            )}

            {login ? (
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="clone-filter">{t("Your GitHub repositories")}</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label={t("Reload the list")}
                    title={t("Reload the list")}
                    disabled={loading}
                    onClick={loadRepositories}
                  >
                    <RefreshCw className={cn(loading && "animate-spin")} />
                  </Button>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="clone-filter"
                    className="pl-7"
                    placeholder={t("Filter by name or description")}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="h-56 overflow-y-auto rounded-md border" role="listbox" aria-label={t("Your GitHub repositories")}>
                  {listError ? (
                    <p className="p-3 text-sm text-destructive">{listError}</p>
                  ) : repositories === null ? (
                    <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                      <LoaderCircle className="size-3.5 animate-spin" />
                      {t("Loading your repositories…")}
                    </p>
                  ) : shown.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">
                      {repositories.length === 0
                        ? t("This account has no repository yet.")
                        : t("No repository matches the filter.")}
                    </p>
                  ) : (
                    shown.map((repository) => (
                      <RepositoryRow
                        key={repository.fullName}
                        repository={repository}
                        selected={repository.cloneUrl === url}
                        onSelect={() => {
                          setUrl(repository.cloneUrl);
                          setName("");
                        }}
                      />
                    ))
                  )}
                </div>
              </div>
            ) : (
              <p className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-sm text-muted-foreground">
                {t("Connect a GitHub account to pick from your repositories.")}
                <Button type="button" variant="outline" size="sm" onClick={github.openDialog}>
                  {t("Connect")}
                </Button>
              </p>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="clone-url">{t("Repository URL")}</Label>
              <Input
                id="clone-url"
                className="font-mono"
                placeholder="https://github.com/user/repo.git"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus={!login}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="clone-parent">{t("Clone into folder")}</Label>
              <div className="flex gap-2">
                <Input
                  id="clone-parent"
                  className="font-mono"
                  value={parent}
                  onChange={(event) => setParent(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void openDialog({ directory: true, multiple: false, title: t("Clone into folder") }).then(
                      (chosen) => {
                        if (typeof chosen === "string") setParent(chosen);
                      },
                    );
                  }}
                >
                  <FolderOpen />
                  {t("Browse…")}
                </Button>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="clone-name">{t("Folder name (optional, taken from the URL otherwise)")}</Label>
              <Input
                id="clone-name"
                className="font-mono"
                placeholder={derivedName}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={!complete}>
                {t("Clone")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RepositoryRow({
  repository,
  selected,
  onSelect,
}: {
  repository: RemoteRepository;
  selected: boolean;
  onSelect(): void;
}) {
  const { t } = useI18n();
  const Icon = repository.private ? Lock : repository.fork ? GitFork : BookMarked;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={cn(
        "flex w-full items-start gap-2 border-b px-2 py-1.5 text-left last:border-b-0 hover:bg-accent/60",
        selected && "bg-accent",
      )}
      onClick={onSelect}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{repository.fullName}</span>
          {repository.private && <Badge variant="outline">{t("Private")}</Badge>}
          {repository.archived && (
            <Badge variant="outline">
              <Archive />
              {t("Archived")}
            </Badge>
          )}
        </span>
        {repository.description && (
          <span className="block truncate text-xs text-muted-foreground">{repository.description}</span>
        )}
      </span>
      {repository.pushedAt > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(repository.pushedAt)}</span>
      )}
    </button>
  );
}

function CloneProgress({ job, onCancel, onClose }: { job: CloneJob; onCancel(): void; onClose(): void }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 space-y-4">
      <DialogHeader>
        <DialogTitle>{t("Cloning {name}…", { name: repositoryNameFromUrl(job.url) })}</DialogTitle>
        <DialogDescription className="truncate font-mono text-xs" title={job.destination}>
          {job.destination}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5" role="status">
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={job.percent ?? undefined}
        >
          <div
            className={cn(
              "h-full rounded-full bg-primary transition-[width] duration-300",
              job.percent === null && "w-1/4 animate-pulse",
            )}
            style={job.percent !== null ? { width: `${job.percent}%` } : undefined}
          />
        </div>
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={job.message}>
            {job.message || t("Contacting the server…")}
          </span>
          {job.percent !== null && <span className="shrink-0 tabular-nums">{job.percent} %</span>}
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("Hide")}
        </Button>
        <Button type="button" variant="destructive" onClick={onCancel}>
          {t("Cancel the clone")}
        </Button>
      </DialogFooter>
    </div>
  );
}
