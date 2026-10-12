import { type FormEvent, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, KeyRound, LoaderCircle, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";

import type { AiModel, Provider } from "@/bindings";
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
import { PROGRAMS, PROVIDERS, PROVIDER_LABELS, useAi } from "@/lib/ai";
import { api, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Where to create an API key, or how to install the program. */
const SETUP_URLS: Record<Provider, string> = {
  claudecode: "https://claude.com/claude-code",
  codex: "https://github.com/openai/codex",
  anthropic: "https://platform.claude.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
};
const KEY_PLACEHOLDERS: Partial<Record<Provider, string>> = { anthropic: "sk-ant-…", openai: "sk-…" };

/**
 * Chooses who writes the commit messages: Claude Code or Codex when they are
 * installed, or an API with its key; then the model.
 */
export function AiSettingsDialog() {
  const { t } = useI18n();
  const ai = useAi();
  const provider = ai.settings.provider;
  const label = PROVIDER_LABELS[provider];
  /** The command of a provider that is a program; `undefined` for an API. */
  const program = PROGRAMS[provider];
  const usable = ai.configured.includes(provider);
  const model = ai.settings.models[provider];
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What each provider offers, asked once per provider while the dialog is open.
  const [models, setModels] = useState<Partial<Record<Provider, AiModel[]>>>({});

  // A program may have been installed since the last look.
  const { dialogOpen, refresh } = ai;
  useEffect(() => {
    if (dialogOpen) void refresh();
  }, [dialogOpen, refresh]);

  // Everything transient is dropped when the dialog closes.
  useEffect(() => {
    if (dialogOpen) return;
    setKey("");
    setError(null);
    setBusy(false);
    setModels({});
  }, [dialogOpen]);

  const known = models[provider];
  useEffect(() => {
    if (!dialogOpen || !usable || known) return;
    let cancelled = false;
    api.aiModels(provider).then(
      (found) => {
        if (!cancelled) setModels((current) => ({ ...current, [provider]: found }));
      },
      (failure) => {
        if (!cancelled) setError(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, usable, known, provider]);

  const choose = (next: Provider) => {
    setKey("");
    setError(null);
    ai.setProvider(next);
  };

  const submitKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const found = await ai.saveKey(provider, key);
      setModels((current) => ({ ...current, [provider]: found }));
      setKey("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setError(null);
    try {
      await ai.clearKey(provider);
      setModels((current) => ({ ...current, [provider]: undefined }));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const lookAgain = async () => {
    setBusy(true);
    await ai.refresh();
    setBusy(false);
  };

  // The chosen model stays selectable even when the list does not (or not yet) hold it.
  const options = known ?? [];
  const listed = options.some((option) => option.id === model);
  const modelPicker = (
    <div className="grid gap-1.5">
      <Label htmlFor="ai-model">{t("Model")}</Label>
      <div className="flex items-center gap-2">
        <select
          id="ai-model"
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={model}
          onChange={(event) => ai.setModel(provider, event.target.value)}
        >
          {program ? (
            <option value="">{t("The default of {name}", { name: label })}</option>
          ) : (
            model === "" && <option value="">{t("Choose a model…")}</option>
          )}
          {model !== "" && !listed && <option value={model}>{model}</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name === option.id ? option.id : `${option.name} (${option.id})`}
            </option>
          ))}
        </select>
        {!known && !error && <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>
    </div>
  );

  return (
    <Dialog open={dialogOpen} onOpenChange={(open) => !open && ai.closeDialog()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Commit message assistant")}</DialogTitle>
          <DialogDescription>
            {t("A language model reads the staged changes and proposes the commit message: through Claude Code or Codex when they are installed, or with your own API key.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label={t("Provider")}>
          {PROVIDERS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === provider}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                candidate === provider && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => choose(candidate)}
            >
              {PROVIDER_LABELS[candidate]}
              {ai.configured.includes(candidate) && (
                <span className="size-1.5 rounded-full bg-emerald-500" title={t("Ready to use")} />
              )}
            </button>
          ))}
        </div>

        {program ? (
          usable ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <SquareTerminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <p className="min-w-0 flex-1 text-sm">
                  <code className="font-mono">{program}</code>{" "}
                  {t("is installed. It writes the messages with the account it is signed in to: no key to give.")}
                </p>
              </div>
              {modelPicker}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm">
                <code className="font-mono">{program}</code>{" "}
                {t("was not found on this computer. Install {name}, sign in from a terminal, then look again.", {
                  name: label,
                })}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void openUrl(SETUP_URLS[provider])}>
                  <ExternalLink />
                  {t("How to install {name}", { name: label })}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void lookAgain()}>
                  <RefreshCw className={cn(busy && "animate-spin")} />
                  {t("Look again")}
                </Button>
              </div>
            </div>
          )
        ) : usable ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="min-w-0 flex-1 text-sm">{t("An API key is stored in the system keychain.")}</p>
              <Button variant="outline" size="sm" onClick={() => void removeKey()}>
                <Trash2 />
                {t("Remove")}
              </Button>
            </div>
            {modelPicker}
          </div>
        ) : (
          <form id="ai-key-form" onSubmit={submitKey} className="grid gap-1.5">
            <Label htmlFor="ai-key">{t("API key")}</Label>
            <Input
              id="ai-key"
              type="password"
              autoComplete="off"
              className="font-mono"
              placeholder={KEY_PLACEHOLDERS[provider]}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              {t("The key is kept in the system keychain, never in a file.")}{" "}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => void openUrl(SETUP_URLS[provider])}
              >
                {t("Create one")}
              </button>
              .
            </p>
          </form>
        )}

        {error && <p className="text-sm break-words text-destructive">{error}</p>}

        <p className="text-xs text-muted-foreground">
          {program
            ? t("Asking for a message sends the staged diff to the model {name} uses; nothing is sent before you ask.", {
                name: label,
              })
            : t("Asking for a message sends the staged diff to {provider}; nothing is sent before you ask.", {
                provider: label,
              })}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={ai.closeDialog}>
            {t("Close")}
          </Button>
          {!program && !usable && (
            <Button type="submit" form="ai-key-form" disabled={busy || !key.trim()}>
              {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
              {t("Save the key")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
