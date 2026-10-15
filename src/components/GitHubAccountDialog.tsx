import { type FormEvent, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, KeyRound, LoaderCircle, LogOut, UserPlus } from "lucide-react";

import type { DeviceCode } from "@/bindings";
import { AccountAvatar } from "@/components/AccountAvatar";
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
import { errorMessage } from "@/lib/api";
import { type AccountDialogView, useGitHub } from "@/lib/github";
import { useI18n } from "@/lib/i18n";

const TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:user&description=Open%20GIT";

/**
 * The connected GitHub accounts (which one is active, signing out), and the form
 * that connects one more, with a token or through github.com.
 */
export function GitHubAccountDialog() {
  const { t } = useI18n();
  const github = useGitHub();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const pollTimer = useRef<number | undefined>(undefined);

  const open = github.dialog !== null;
  // The view outlives the dialog, which still shows it while it fades out.
  const [view, setView] = useState<AccountDialogView>("add");
  if (github.dialog && github.dialog !== view) setView(github.dialog);
  // Without any account there is nothing to list: the form is all there is.
  const adding = view === "add" || github.accounts.length === 0;

  const stopPolling = () => {
    window.clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
  };

  // Everything transient is dropped when the dialog closes.
  useEffect(() => {
    if (open) return;
    stopPolling();
    setToken("");
    setDevice(null);
    setDeviceError(null);
    setBusy(false);
  }, [open]);

  const submitToken = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    const ok = await github.signIn(token);
    setBusy(false);
    if (ok) github.closeDialog();
  };

  const startDevice = async () => {
    setDeviceError(null);
    setBusy(true);
    try {
      const code = await github.startDevice();
      setDevice(code);
      void openUrl(code.verificationUri).catch(() => {});
      const poll = async (intervalSeconds: number) => {
        try {
          const status = await github.pollDevice(code.deviceCode);
          if (status.kind === "signedIn") {
            github.closeDialog();
            return;
          }
          if (status.kind === "failed") {
            setDeviceError(status.value);
            setDevice(null);
            return;
          }
          const next = status.kind === "slowDown" ? intervalSeconds + 5 : intervalSeconds;
          pollTimer.current = window.setTimeout(() => void poll(next), next * 1000);
        } catch (failure) {
          setDeviceError(errorMessage(failure));
          setDevice(null);
        }
      };
      pollTimer.current = window.setTimeout(() => void poll(code.interval), code.interval * 1000);
    } catch (failure) {
      setDeviceError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && github.closeDialog()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{adding ? t("Connect a GitHub account") : t("GitHub accounts")}</DialogTitle>
          <DialogDescription>
            {!adding
              ? t("A repository uses the account it was cloned with or given, else one of these that can push to it, the active one first.")
              : github.reconnecting
                ? t("GitHub no longer accepts the token of {login}. Connect it again, signed in as {login} on github.com.", {
                    login: github.reconnecting,
                  })
                : github.accounts.length > 0
                  ? t("The account you connect becomes the active one; the others stay connected.")
                  : t("Connect an account to follow the workflow runs, and to list and create pull requests and issues.")}
          </DialogDescription>
        </DialogHeader>

        {github.error && <p className="text-sm text-destructive">{github.error}</p>}

        {!adding ? (
          <>
            <ul className="divide-y rounded-md border">
              {github.accounts.map((account) => {
                const active = account.login === github.account?.login;
                const refused = github.refused.includes(account.login);
                const signOutLabel = t("Sign out of {login}", { login: account.login });
                return (
                  <li key={account.login} className="flex items-center gap-3 px-3 py-2">
                    <AccountAvatar account={account} className="size-9" />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{account.login}</span>
                        {active && <Badge variant="secondary">{t("Active")}</Badge>}
                        {refused && <Badge variant="destructive">{t("Token refused")}</Badge>}
                      </p>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => void openUrl(account.htmlUrl)}
                      >
                        {t("Open the profile")} <ExternalLink className="size-3" />
                      </button>
                    </div>
                    {refused ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => github.openDialog("add", account.login)}
                      >
                        {t("Connect again")}
                      </Button>
                    ) : (
                      !active && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void github.switchAccount(account.login)}
                        >
                          {t("Make active")}
                        </Button>
                      )
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={signOutLabel}
                      title={signOutLabel}
                      onClick={() => void github.signOut(account.login)}
                    >
                      <LogOut />
                    </Button>
                  </li>
                );
              })}
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => github.openDialog("add")}>
                <UserPlus />
                {t("Connect another account")}
              </Button>
              <Button type="button" onClick={github.closeDialog}>
                {t("Close")}
              </Button>
            </DialogFooter>
          </>
        ) : device ? (
          <div className="space-y-3 text-sm">
            <p>{t("Enter this code on GitHub, then come back here. The page opened in your browser; if not, open it below.")}</p>
            <p className="rounded-md border bg-muted px-3 py-2 text-center font-mono text-2xl tracking-widest select-all">
              {device.userCode}
            </p>
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={() => void openUrl(device.verificationUri)}>
                <ExternalLink />
                {t("Open")} {device.verificationUri.replace(/^https?:\/\//, "")}
              </Button>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" />
                {t("Waiting for GitHub…")}
              </span>
            </div>
            {github.accounts.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {github.reconnecting
                  ? t("GitHub connects the account your browser is signed in to: check that it is {login}.", {
                      login: github.reconnecting,
                    })
                  : t("GitHub connects the account your browser is signed in to: to add a different one, switch account on github.com first.")}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={submitToken} className="space-y-4">
            {github.deviceAvailable && (
              <>
                <Button type="button" className="w-full" onClick={() => void startDevice()} disabled={busy}>
                  {t("Sign in with GitHub")}
                </Button>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {t("or use a token")}
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="github-token">{t("Personal access token")}</Label>
              <Input
                id="github-token"
                type="password"
                autoComplete="off"
                className="font-mono"
                placeholder="ghp_…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                {t("The token needs the")} <code className="font-mono">repo</code>{" "}
                {t("scope. It is kept in the system keychain, never in a file.")}{" "}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => void openUrl(TOKEN_URL)}
                >
                  {t("Create one on GitHub")}
                </button>
                .
              </p>
            </div>
            {deviceError && <p className="text-sm text-destructive">{deviceError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={github.closeDialog}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={busy || !token.trim()}>
                {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                {t("Sign in")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
