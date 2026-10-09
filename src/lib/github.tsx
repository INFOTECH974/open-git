import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { Account, DeviceCode, DeviceStatus } from "@/bindings";
import { api, errorMessage } from "@/lib/api";

/** The connected GitHub account, shared by every tab. */
export interface GitHubState {
  account: Account | null;
  /** True while the stored token is being checked at start-up. */
  loading: boolean;
  error: string | null;
  /** Whether this build can sign in through github.com rather than a pasted token. */
  deviceAvailable: boolean;
  dialogOpen: boolean;
  openDialog(): void;
  closeDialog(): void;
  signIn(token: string): Promise<boolean>;
  signOut(): Promise<void>;
  startDevice(): Promise<DeviceCode>;
  pollDevice(deviceCode: string): Promise<DeviceStatus>;
  clearError(): void;
}

const GitHubContext = createContext<GitHubState | null>(null);

export function GitHubProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deviceAvailable, setDeviceAvailable] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.githubDeviceAvailable().then(
      (available) => {
        if (!cancelled) setDeviceAvailable(available);
      },
      () => {},
    );
    api.githubAccount().then(
      (found) => {
        if (cancelled) return;
        setAccount(found);
        setLoading(false);
      },
      (failure) => {
        if (cancelled) return;
        setError(errorMessage(failure));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (token: string) => {
    setError(null);
    try {
      setAccount(await api.githubSignIn(token));
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    try {
      await api.githubSignOut();
    } catch (failure) {
      setError(errorMessage(failure));
    }
    setAccount(null);
  }, []);

  const pollDevice = useCallback(async (deviceCode: string) => {
    const status = await api.githubDevicePoll(deviceCode);
    if (status.kind === "signedIn") setAccount(status.value);
    return status;
  }, []);

  const value = useMemo<GitHubState>(
    () => ({
      account,
      loading,
      error,
      deviceAvailable,
      dialogOpen,
      openDialog: () => setDialogOpen(true),
      closeDialog: () => setDialogOpen(false),
      signIn,
      signOut,
      startDevice: api.githubDeviceStart,
      pollDevice,
      clearError: () => setError(null),
    }),
    [account, loading, error, deviceAvailable, dialogOpen, signIn, signOut, pollDevice],
  );

  return <GitHubContext.Provider value={value}>{children}</GitHubContext.Provider>;
}

export function useGitHub(): GitHubState {
  const state = useContext(GitHubContext);
  if (!state) throw new Error("useGitHub needs a GitHubProvider above it");
  return state;
}

/** `issue-42-fix-the-thing` for issue 42 "Fix the thing!". */
export function branchNameForIssue(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `issue-${number}-${slug}` : `issue-${number}`;
}
