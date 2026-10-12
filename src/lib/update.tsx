import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { api, errorMessage, events } from "@/lib/api";

/** How often an open application looks for a newer release. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** Where the source code lives. */
export const REPOSITORY_URL = "https://github.com/INFOTECH974/open-git";
/** Where the releases are published, for the link to what changed. */
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

/** The update of the application itself, from the latest GitHub release. */
export interface UpdateState {
  /** The running version; `null` until the application answered. */
  currentVersion: string | null;
  /** The version of the latest release, when it is newer than the running one. */
  available: string | null;
  checking: boolean;
  /** Whether the last look found the running version to be the latest. */
  upToDate: boolean;
  installing: boolean;
  /** The download, from 0 to 100; `null` before it starts or when its size is unknown. */
  percent: number | null;
  error: string | null;
  /** Looks at the latest release and reports what it finds, failures included. */
  check(): Promise<void>;
  /** Downloads and installs the release; the application restarts when it succeeds. */
  install(): Promise<void>;
  dialogOpen: boolean;
  openDialog(): void;
  closeDialog(): void;
}

const UpdateContext = createContext<UpdateState | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [available, setAvailable] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    getVersion().then(setCurrentVersion, () => {
      // Outside the application (a plain browser) there is no version to show.
    });
  }, []);

  const look = useCallback(async (quiet: boolean) => {
    if (!quiet) {
      setChecking(true);
      setError(null);
    }
    try {
      const version = await api.updateCheck();
      setAvailable(version);
      setUpToDate(version === null);
    } catch (failure) {
      // An unattended look says nothing: no network, or no release yet.
      if (!quiet) setError(errorMessage(failure));
    } finally {
      if (!quiet) setChecking(false);
    }
  }, []);

  // Once at start-up, then now and then while the application stays open.
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void look(true);
    }
    const timer = window.setInterval(() => void look(true), CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [look]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    events.updateProgress
      .listen((event) => setPercent(event.payload.percent))
      .then(
        (stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        },
        () => {
          // No event system available: the download only shows as running.
        },
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const install = useCallback(async () => {
    setInstalling(true);
    setPercent(null);
    setError(null);
    try {
      // Resolves only when the application was not restarted.
      await api.updateInstall();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setInstalling(false);
    }
  }, []);

  const value = useMemo<UpdateState>(
    () => ({
      currentVersion,
      available,
      checking,
      upToDate,
      installing,
      percent,
      error,
      check: () => look(false),
      install,
      dialogOpen,
      openDialog: () => setDialogOpen(true),
      closeDialog: () => {
        setDialogOpen(false);
        setError(null);
      },
    }),
    [currentVersion, available, checking, upToDate, installing, percent, error, look, install, dialogOpen],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateState {
  const state = useContext(UpdateContext);
  if (!state) throw new Error("useUpdate needs an UpdateProvider above it");
  return state;
}
