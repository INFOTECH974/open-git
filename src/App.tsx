import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CircleUser, Download, Languages, Monitor, Moon, Sun, X } from "lucide-react";

import type { RepoInfo } from "@/bindings";
import { FormDialog, type FormRequest } from "@/components/dialogs/FormDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { GitHubAccountDialog } from "@/components/GitHubAccountDialog";
import { OpenMenu } from "@/components/OpenMenu";
import { RepositoryView } from "@/components/RepositoryView";
import { TabBar } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, events } from "@/lib/api";
import { joinPath } from "@/lib/format";
import { GitHubProvider, useGitHub } from "@/lib/github";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { forgetRecent, loadRecent, rememberRecent } from "@/lib/recent";
import { loadSession, saveSession } from "@/lib/session";
import { type Theme, applyTheme, followSystemTheme, loadTheme, nextTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABELS = { system: "Theme: follows the system", light: "Theme: light", dark: "Theme: dark" };

/** `my-repo` for `https://github.com/me/my-repo.git`. */
function repositoryNameFromUrl(url: string): string {
  const last = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "") || "repository";
}

/** The providers every component relies on, then the application itself. */
export default function App() {
  return (
    <I18nProvider>
      <GitHubProvider>
        <TooltipProvider>
          <Shell />
        </TooltipProvider>
      </GitHubProvider>
    </I18nProvider>
  );
}

function Shell() {
  const { t } = useI18n();
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

  // A clone reports its progress under its destination path until it is opened.
  const [cloneProgress, setCloneProgress] = useState<{
    path: string;
    message: string;
    percent: number | null;
  } | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    events.operationProgress
      .listen((event) => {
        if (event.payload.operation !== "clone") return;
        setCloneProgress({
          path: event.payload.path,
          message: event.payload.message,
          percent: event.payload.percent,
        });
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
  useEffect(() => {
    if (!opening) setCloneProgress(null);
  }, [opening]);

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
        if (!quiet) setError(errorMessage(failure));
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

  const clone = useCallback(() => {
    setForm({
      title: t("Clone a repository"),
      description: t("The clone is made with your own git, so your SSH keys and credential helper apply."),
      fields: [
        {
          key: "url",
          label: t("Repository URL"),
          type: "text",
          required: true,
          mono: true,
          placeholder: "https://github.com/user/repo.git",
        },
        { key: "parent", label: t("Clone into folder"), type: "folder", required: true },
        {
          key: "name",
          label: t("Folder name (optional, taken from the URL otherwise)"),
          type: "text",
          mono: true,
        },
      ],
      action: t("Clone"),
      onSubmit: (values) => {
        const url = String(values.url);
        const name = String(values.name) || repositoryNameFromUrl(url);
        void opened(() => api.cloneRepository(url, joinPath(String(values.parent), name)));
      },
    });
  }, [opened, t]);

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
        trailing={
          <OpenMenu
            recent={recent}
            openPaths={tabs.map((tab) => tab.path)}
            busy={opening}
            onBrowse={() => void browse()}
            onClone={clone}
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
      {cloneProgress && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm" role="status">
          <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate" title={cloneProgress.path}>
            {t("Cloning into")} <code className="font-mono text-xs">{cloneProgress.path}</code>
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={cloneProgress.message}>
            {cloneProgress.message}
          </span>
          <div className="h-1 w-40 shrink-0 overflow-hidden rounded bg-muted">
            <div
              className={cn(
                "h-full rounded bg-primary transition-[width] duration-200",
                cloneProgress.percent == null && "w-1/3 animate-pulse",
              )}
              style={cloneProgress.percent != null ? { width: `${cloneProgress.percent}%` } : undefined}
            />
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Cancel the clone")}
            onClick={() => void api.cancelOperation(cloneProgress.path)}
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
      <GitHubAccountDialog />
    </div>
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
