import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CircleArrowUp, CircleUser, Download, Languages, Monitor, Moon, Sparkles, Sun, X } from "lucide-react";

import type { RepoInfo } from "@/bindings";
import { AiSettingsDialog } from "@/components/AiSettingsDialog";
import { CloneDialog } from "@/components/dialogs/CloneDialog";
import { FormDialog, type FormRequest } from "@/components/dialogs/FormDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { GitHubAccountDialog } from "@/components/GitHubAccountDialog";
import { OpenMenu } from "@/components/OpenMenu";
import { RepositoryView } from "@/components/RepositoryView";
import { TabBar } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { UpdateDialog } from "@/components/UpdateDialog";
import { AiProvider, modelLabel, useAi } from "@/lib/ai";
import { api, errorMessage, events, isCancelled } from "@/lib/api";
import { type CloneJob, overallCloneProgress } from "@/lib/cloneProgress";
import { GitHubProvider, useGitHub } from "@/lib/github";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { forgetRecent, loadRecent, rememberRecent } from "@/lib/recent";
import { loadSession, saveSession } from "@/lib/session";
import { type Theme, applyTheme, followSystemTheme, loadTheme, nextTheme } from "@/lib/theme";
import { UpdateProvider, useUpdate } from "@/lib/update";
import { cn } from "@/lib/utils";

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABELS = { system: "Theme: follows the system", light: "Theme: light", dark: "Theme: dark" };

/** The providers every component relies on, then the application itself. */
export default function App() {
  return (
    <I18nProvider>
      <GitHubProvider>
        <AiProvider>
          <UpdateProvider>
            <TooltipProvider>
              <Shell />
            </TooltipProvider>
          </UpdateProvider>
        </AiProvider>
      </GitHubProvider>
    </I18nProvider>
  );
}

function Shell() {
  const { t } = useI18n();
  const update = useUpdate();
  const [tabs, setTabs] = useState<RepoInfo[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormRequest | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  // The saved session is written only after it was restored, or it would be wiped.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => followSystemTheme(() => theme), [theme]);

  // The clone dialog, and the clone it started: it carries on when the dialog is
  // hidden, followed by a strip under the tabs.
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneJob, setCloneJob] = useState<CloneJob | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  // A clone reports its progress under its destination path until it is opened.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    events.operationProgress
      .listen((event) => {
        const { operation, path, message, percent } = event.payload;
        if (operation !== "clone") return;
        setCloneJob((job) =>
          job && job.destination === path
            ? { ...job, message, percent: overallCloneProgress(message, percent) ?? job.percent }
            : job,
        );
      })
      .then(
        (stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        },
        () => {
          // No event system available: the clone only shows its spinner.
        },
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  /** Shows the repository `info` describes in a tab (reusing one for the same path). */
  const show = useCallback((info: RepoInfo) => {
    setTabs((previous) =>
      previous.some((tab) => tab.path === info.path) ? previous : [...previous, info],
    );
    setActivePath(info.path);
    setRecent(rememberRecent(info.path));
    setError(null);
  }, []);

  /** Runs an opening action (open, clone, init) and shows the result. */
  const opened = useCallback(
    async (action: () => Promise<RepoInfo>, quiet = false): Promise<RepoInfo | null> => {
      setOpening(true);
      try {
        const info = await action();
        show(info);
        return info;
      } catch (failure) {
        // A quiet failure (session restore) keeps the entry in the recent list: the
        // repository may simply be unavailable for now.
        if (!quiet && !isCancelled(failure)) setError(errorMessage(failure));
        return null;
      } finally {
        setOpening(false);
      }
    },
    [show],
  );

  /** Opens `path` in a tab, or activates its tab if it is already open. */
  const openPath = useCallback(
    (path: string, quiet = false) => {
      const existing = tabs.find((tab) => tab.path === path);
      if (existing) {
        setActivePath(existing.path);
        return Promise.resolve(existing);
      }
      return opened(() => api.openRepository(path), quiet);
    },
    [tabs, opened],
  );

  // Reopen the tabs of the previous session; a repository that cannot be opened is skipped.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const session = loadSession();
    void (async () => {
      const reopened: string[] = [];
      for (const path of session.tabs) {
        const info = await openPath(path, true);
        if (info) reopened.push(info.path);
      }
      if (session.active && reopened.includes(session.active)) setActivePath(session.active);
      setRestored(true);
    })();
    // Runs once at start-up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (restored) saveSession({ tabs: tabs.map((tab) => tab.path), active: activePath });
  }, [restored, tabs, activePath]);

  const closeTab = useCallback(
    (path: string) => {
      const index = tabs.findIndex((tab) => tab.path === path);
      if (index < 0) return;
      void api.closeRepository(path);
      const remaining = tabs.filter((tab) => tab.path !== path);
      setTabs(remaining);
      if (activePath === path) {
        setActivePath((remaining[index] ?? remaining[index - 1])?.path ?? null);
      }
    },
    [tabs, activePath],
  );

  const browse = useCallback(async () => {
    const chosen = await openDialog({
      directory: true,
      multiple: false,
      title: t("Open a Git repository"),
    });
    if (typeof chosen === "string") await openPath(chosen);
  }, [openPath, t]);

  const clone = useCallback(
    async (url: string, destination: string) => {
      setCloneError(null);
      setCloneJob({ url, destination, message: "", percent: null });
      setOpening(true);
      try {
        show(await api.cloneRepository(url, destination));
        setCloneOpen(false);
      } catch (failure) {
        if (!isCancelled(failure)) {
          // Back to the form, with what was typed and why it failed.
          setCloneError(errorMessage(failure));
          setCloneOpen(true);
        }
      } finally {
        setOpening(false);
        setCloneJob(null);
      }
    },
    [show],
  );

  const init = useCallback(() => {
    setForm({
      title: t("Create a repository"),
      description: t("Runs git init in the folder; an existing folder is kept as it is."),
      fields: [{ key: "folder", label: t("Folder"), type: "folder", required: true }],
      action: t("Create"),
      onSubmit: (values) => void opened(() => api.initRepository(String(values.folder))),
    });
  }, [opened, t]);

  // Ctrl+O opens, Ctrl+W closes the current tab, Ctrl+Tab cycles through the tabs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "o") {
        event.preventDefault();
        void browse();
      } else if (key === "w" && activePath) {
        event.preventDefault();
        closeTab(activePath);
      } else if (key === "tab" && tabs.length > 1 && activePath) {
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.path === activePath);
        const step = event.shiftKey ? -1 : 1;
        setActivePath(tabs[(index + step + tabs.length) % tabs.length].path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [browse, closeTab, tabs, activePath]);

  const ThemeIcon = THEME_ICONS[theme];
  const themeLabel = t(THEME_LABELS[theme]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TabBar
        tabs={tabs}
        activePath={activePath}
        onActivate={setActivePath}
        onClose={closeTab}
        onAbout={update.openDialog}
        trailing={
          <OpenMenu
            recent={recent}
            openPaths={tabs.map((tab) => tab.path)}
            busy={opening}
            onBrowse={() => void browse()}
            onClone={() => {
              setCloneError(null);
              setCloneOpen(true);
            }}
            onInit={init}
            onOpenPath={(path) => void openPath(path)}
            onClearRecent={() => {
              for (const path of recent) forgetRecent(path);
              setRecent([]);
            }}
          />
        }
        end={
          <>
            <UpdateButton />
            <AssistantButton />
            <AccountButton />
            <LanguageButton />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={themeLabel}
                  onClick={() => setTheme(nextTheme(theme))}
                >
                  <ThemeIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{themeLabel}</TooltipContent>
            </Tooltip>
          </>
        }
      />
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {cloneJob && !cloneOpen && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm" role="status">
          <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <button
            type="button"
            className="min-w-0 truncate hover:underline"
            title={cloneJob.destination}
            onClick={() => setCloneOpen(true)}
          >
            {t("Cloning into")} <code className="font-mono text-xs">{cloneJob.destination}</code>
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={cloneJob.message}>
            {cloneJob.message}
          </span>
          <div className="h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] duration-300",
                cloneJob.percent == null && "w-1/3 animate-pulse",
              )}
              style={cloneJob.percent != null ? { width: `${cloneJob.percent}%` } : undefined}
            />
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Cancel the clone")}
            onClick={() => void api.cancelOperation(cloneJob.destination)}
          >
            <X />
          </Button>
        </div>
      )}

      {tabs.length === 0 ? (
        <EmptyState
          recent={recent}
          busy={opening}
          onOpen={() => void browse()}
          onOpenPath={(path) => void openPath(path)}
          onForget={(path) => setRecent(forgetRecent(path))}
        />
      ) : (
        <div className="relative min-h-0 flex-1">
          {tabs.map((tab) => {
            const active = tab.path === activePath;
            return (
              // Inactive tabs stay mounted but hidden, so their scroll position
              // and loaded history survive switching back and forth.
              <div
                key={tab.path}
                className={cn("absolute inset-0", !active && "invisible")}
                aria-hidden={!active}
                inert={!active}
              >
                <RepositoryView info={tab} active={active} />
              </div>
            );
          })}
        </div>
      )}
      <FormDialog request={form} onClose={() => setForm(null)} />
      <CloneDialog
        open={cloneOpen}
        job={cloneJob}
        error={cloneError}
        onClone={(url, destination) => void clone(url, destination)}
        onCancel={() => cloneJob && void api.cancelOperation(cloneJob.destination)}
        onClose={() => setCloneOpen(false)}
      />
      <GitHubAccountDialog />
      <AiSettingsDialog />
      <UpdateDialog />
    </div>
  );
}

/** Shown once a newer release exists; opens the dialog that installs it. */
function UpdateButton() {
  const { t } = useI18n();
  const update = useUpdate();
  if (!update.available) return null;
  const label = t("Open GIT {version} is available", { version: update.available });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-1.5 text-emerald-600 dark:text-emerald-400"
          aria-label={label}
          onClick={update.openDialog}
        >
          <CircleArrowUp />
          <span className="text-xs font-medium">{t("Update")}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Opens the GitHub account dialog; shows the avatar once signed in. */
function AccountButton() {
  const { t } = useI18n();
  const github = useGitHub();
  const label = github.account
    ? t("GitHub: {login}", { login: github.account.login })
    : t("Connect a GitHub account");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={label}
          onClick={github.openDialog}
        >
          {github.account ? (
            <img
              src={github.account.avatarUrl}
              alt=""
              className="size-5 rounded-full bg-muted"
              referrerPolicy="no-referrer"
            />
          ) : (
            <CircleUser />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Opens the settings of the commit message assistant; lit once it can be used. */
function AssistantButton() {
  const { t } = useI18n();
  const ai = useAi();
  const label = ai.ready
    ? t("Commit message assistant: {model}", { model: modelLabel(ai.settings) })
    : t("Set up the commit message assistant");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(!ai.ready && "text-muted-foreground")}
          aria-label={label}
          onClick={ai.openDialog}
        >
          <Sparkles />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Switches the interface between English and French. */
function LanguageButton() {
  const { language, setLanguage, t } = useI18n();
  const label = language === "fr" ? t("Switch to English") : t("Switch to French");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-1.5 text-muted-foreground"
          aria-label={label}
          onClick={() => setLanguage(language === "fr" ? "en" : "fr")}
        >
          <Languages />
          <span className="text-xs font-medium uppercase">{language}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
