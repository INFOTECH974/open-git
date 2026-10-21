import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { Account, Accounts, DeviceCode, DeviceStatus, GitHubLink } from "@/bindings";
import { api, errorMessage } from "@/lib/api";

/** What the account dialog shows: the connected accounts, or the form that connects one. */
export type AccountDialogView = "accounts" | "add";

/** The connected GitHub accounts, shared by every tab. */
export interface GitHubState {
  /** In the order they were connected. */
  accounts: Account[];
  /**
   * The active account: the one that works wherever a repository names no
   * other. `null` when none is connected.
   */
  account: Account | null;
  /** Logins of the accounts whose token GitHub no longer accepts: to connect again. */
  refused: string[];
  /** True while the keychain is being read at start-up. */
  loading: boolean;
  error: string | null;
  /** Whether this build can sign in through github.com rather than a pasted token. */
  deviceAvailable: boolean;
  /** `null` while the dialog is closed. */
  dialog: AccountDialogView | null;
  /** The account the form connects again, when GitHub turned its token down. */
  reconnecting: string | null;
  /**
   * Without a view: the accounts, or the form when none is connected yet. With
   * `reconnect`, the form says which account to connect again.
   */
  openDialog(view?: AccountDialogView, reconnect?: string): void;
  closeDialog(): void;
  /**
   * Connects the account `token` belongs to, which becomes the active one;
   * resolves to that account, or `null` when GitHub refused the token.
   */
  signIn(token: string): Promise<Account | null>;
  signOut(login: string): Promise<void>;
  /** Makes `login` the active account. */
  switchAccount(login: string): Promise<void>;
  /** Asks the backend again, after GitHub turned down a token. */
  reload(): Promise<void>;
  startDevice(): Promise<DeviceCode>;
  pollDevice(deviceCode: string): Promise<DeviceStatus>;
  clearError(): void;
}

const GitHubContext = createContext<GitHubState | null>(null);

const NO_ACCOUNT: Accounts = { accounts: [], active: null, refused: [] };

export function GitHubProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState<Accounts>(NO_ACCOUNT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deviceAvailable, setDeviceAvailable] = useState(false);
  const [dialog, setDialog] = useState<AccountDialogView | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.githubDeviceAvailable().then(
      (available) => {
        if (!cancelled) setDeviceAvailable(available);
      },
      () => {},
    );
    api.githubAccounts().then(
      (found) => {
        if (cancelled) return;
        setConnected(found);
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
      const account = await api.githubSignIn(token);
      setConnected(await api.githubAccounts());
      return account;
    } catch (failure) {
      setError(errorMessage(failure));
      return null;
    }
  }, []);

  const signOut = useCallback(async (login: string) => {
    setError(null);
    try {
      setConnected(await api.githubSignOut(login));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  const switchAccount = useCallback(async (login: string) => {
    setError(null);
    try {
      setConnected(await api.githubSwitchAccount(login));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      setConnected(await api.githubAccounts());
    } catch {
      // What is shown stays as it was.
    }
  }, []);

  const pollDevice = useCallback(async (deviceCode: string) => {
    const status = await api.githubDevicePoll(deviceCode);
    if (status.kind === "signedIn") setConnected(await api.githubAccounts());
    return status;
  }, []);

  const value = useMemo<GitHubState>(
    () => ({
      accounts: connected.accounts,
      account: connected.accounts.find((account) => account.login === connected.active) ?? null,
      refused: connected.refused,
      loading,
      error,
      deviceAvailable,
      dialog,
      reconnecting,
      openDialog: (view, reconnect) => {
        setReconnecting(reconnect ?? null);
        setDialog(view ?? (connected.accounts.length > 0 ? "accounts" : "add"));
      },
      closeDialog: () => setDialog(null),
      signIn,
      signOut,
      switchAccount,
      reload,
      startDevice: api.githubDeviceStart,
      pollDevice,
      clearError: () => setError(null),
    }),
    [
      connected,
      loading,
      error,
      deviceAvailable,
      dialog,
      reconnecting,
      signIn,
      signOut,
      switchAccount,
      reload,
      pollDevice,
    ],
  );

  return <GitHubContext.Provider value={value}>{children}</GitHubContext.Provider>;
}

export function useGitHub(): GitHubState {
  const state = useContext(GitHubContext);
  if (!state) throw new Error("useGitHub needs a GitHubProvider above it");
  return state;
}

/** Where the repository of a tab lives on GitHub, and the account that works on it. */
export interface RepositoryLink {
  /** `undefined` until it is known, `null` when `origin` is not on GitHub. */
  link: GitHubLink | null | undefined;
  /** The account used for this repository; `null` when there is none to use. */
  account: Account | null;
  /** Whether GitHub no longer accepts the token of that account. */
  refused: boolean;
  /** Gives the repository an account of its own; `null` lets it be chosen automatically again. */
  setAccount(login: string | null): Promise<void>;
}

/**
 * Follows which account works on the repository at `path`: the one it names,
 * else one that GitHub lets push to it, the active one first. The backend
 * decides; this asks again whenever an answer may have changed, including
 * when the repository's `remotes` change (an `origin` added after the fact).
 */
export function useRepositoryLink(path: string, remotes: readonly string[]): RepositoryLink {
  const { accounts, account: active, refused } = useGitHub();
  const [link, setLink] = useState<GitHubLink | null | undefined>(undefined);
  const [changes, setChanges] = useState(0);
  const connected = `${accounts.map((account) => account.login).join(" ")} > ${active?.login ?? ""} ! ${refused.join(" ")} @ ${remotes.join(" ")}`;

  useEffect(() => {
    let cancelled = false;
    api.githubRepository(path).then(
      (found) => {
        if (!cancelled) setLink(found);
      },
      () => {
        if (!cancelled) setLink(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, connected, changes]);

  const setAccount = useCallback(
    async (login: string | null) => {
      await api.githubSetRepositoryAccount(path, login);
      setChanges((value) => value + 1);
    },
    [path],
  );

  const login = link?.account ?? null;
  const account = useMemo(
    () => accounts.find((candidate) => candidate.login === login) ?? null,
    [accounts, login],
  );
  return { link, account, refused: account !== null && refused.includes(account.login), setAccount };
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
