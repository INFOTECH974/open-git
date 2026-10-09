import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { setLocale } from "@/lib/format";
import { fr } from "@/lib/locales/fr";

export type Language = "en" | "fr";

const KEY = "gitui.language";
const DICTIONARIES: Record<Language, Record<string, string>> = { en: {}, fr };

type Vars = Record<string, string | number>;

/** Translates `key` (the English text) and fills `{placeholders}` from `vars`. */
export type Translate = (key: string, vars?: Vars) => string;

interface I18n {
  language: Language;
  setLanguage(language: Language): void;
  t: Translate;
}

const I18nContext = createContext<I18n | null>(null);

function loadLanguage(): Language {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "en" || stored === "fr") return stored;
  } catch {
    // Storage may be unavailable; fall back to the system language.
  }
  return navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function makeTranslate(language: Language): Translate {
  const dictionary = DICTIONARIES[language];
  return (key, vars) => fill(dictionary[key] ?? key, vars);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(loadLanguage);

  useEffect(() => {
    setLocale(language);
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage may be unavailable; the choice then lasts for this session.
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({ language, setLanguage, t: makeTranslate(language) }),
    [language, setLanguage],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n needs an I18nProvider above it");
  return context;
}
