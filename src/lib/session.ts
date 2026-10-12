const KEY = "open-git.session";

/** The tabs that were open when the application last ran. */
export interface SavedSession {
  tabs: string[];
  active: string | null;
}

export function loadSession(): SavedSession {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return { tabs: [], active: null };
    const { tabs, active } = parsed as Partial<SavedSession>;
    return {
      tabs: Array.isArray(tabs) ? tabs.filter((tab): tab is string => typeof tab === "string") : [],
      active: typeof active === "string" ? active : null,
    };
  } catch {
    return { tabs: [], active: null };
  }
}

export function saveSession(session: SavedSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage may be unavailable; the session is then not restored next time.
  }
}
