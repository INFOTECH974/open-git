import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { AiModel, Provider } from "@/bindings";
import { api } from "@/lib/api";

/** The programs first: they need no key when they are installed. */
export const PROVIDERS: Provider[] = ["claudecode", "codex", "anthropic", "openai"];
export const PROVIDER_LABELS: Record<Provider, string> = {
  claudecode: "Claude Code",
  codex: "Codex",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
};
/** The providers that are a program on the machine, by the command that runs them. */
export const PROGRAMS: Partial<Record<Provider, string>> = { claudecode: "claude", codex: "codex" };

/** Which provider writes the messages, and with which model of each. */
export interface AiSettings {
  provider: Provider;
  models: Record<Provider, string>;
}

const KEY = "open-git.ai";
// An empty model is the program's own default; OpenAI's API has no model that
// stays the obvious pick, so there the user chooses from the list.
const DEFAULTS: AiSettings = {
  provider: "claudecode",
  models: { claudecode: "", codex: "", anthropic: "claude-opus-5-5", openai: "" },
};

function loadSettings(): AiSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AiSettings> | null;
    return {
      provider: PROVIDERS.includes(stored?.provider as Provider) ? (stored!.provider as Provider) : DEFAULTS.provider,
      models: { ...DEFAULTS.models, ...stored?.models },
    };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable; the choice then lasts for this session.
  }
}

/** The commit message assistant, shared by every tab. The keys stay in the backend. */
export interface AiState {
  settings: AiSettings;
  /** The providers that can be used: a key is stored, or the program is installed. */
  configured: Provider[];
  /** Whether a message can be asked for: the chosen provider is usable and has a model. */
  ready: boolean;
  /** Looks again for the installed programs and the stored keys. */
  refresh(): Promise<void>;
  dialogOpen: boolean;
  openDialog(): void;
  closeDialog(): void;
  setProvider(provider: Provider): void;
  setModel(provider: Provider, model: string): void;
  /** Checks and stores the key; resolves to the models it can use, rejects when refused. */
  saveKey(provider: Provider, key: string): Promise<AiModel[]>;
  clearKey(provider: Provider): Promise<void>;
}

const AiContext = createContext<AiState | null>(null);

export function AiProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AiSettings>(loadSettings);
  const [configured, setConfigured] = useState<Provider[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setConfigured(await api.aiProviders());
    } catch {
      // Without the keychain the assistant simply shows as not configured.
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const update = useCallback((change: (current: AiSettings) => AiSettings) => {
    setSettings((current) => {
      const next = change(current);
      saveSettings(next);
      return next;
    });
  }, []);

  const saveKey = useCallback(async (provider: Provider, key: string) => {
    const models = await api.aiSaveKey(provider, key);
    setConfigured((current) => (current.includes(provider) ? current : [...current, provider]));
    return models;
  }, []);

  const clearKey = useCallback(async (provider: Provider) => {
    await api.aiClearKey(provider);
    setConfigured((current) => current.filter((other) => other !== provider));
  }, []);

  const value = useMemo<AiState>(
    () => ({
      settings,
      configured,
      ready:
        configured.includes(settings.provider) &&
        (settings.provider in PROGRAMS || settings.models[settings.provider] !== ""),
      refresh,
      dialogOpen,
      openDialog: () => setDialogOpen(true),
      closeDialog: () => setDialogOpen(false),
      setProvider: (provider) => update((current) => ({ ...current, provider })),
      setModel: (provider, model) =>
        update((current) => ({ ...current, models: { ...current.models, [provider]: model } })),
      saveKey,
      clearKey,
    }),
    [settings, configured, dialogOpen, refresh, update, saveKey, clearKey],
  );

  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

/** How the model in use reads in a sentence: its name, or the program left to its default. */
export function modelLabel(settings: AiSettings): string {
  return settings.models[settings.provider] || PROVIDER_LABELS[settings.provider];
}

export function useAi(): AiState {
  const state = useContext(AiContext);
  if (!state) throw new Error("useAi needs an AiProvider above it");
  return state;
}
