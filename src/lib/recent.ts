const KEY = "open-git.recentRepositories";
const LIMIT = 8;

export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function save(list: string[]): string[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage may be unavailable; the list then only lives for this session.
  }
  return list;
}

/** Moves `path` to the front of the recent list and returns the new list. */
export function rememberRecent(path: string): string[] {
  return save([path, ...loadRecent().filter((item) => item !== path)].slice(0, LIMIT));
}

export function forgetRecent(path: string): string[] {
  return save(loadRecent().filter((item) => item !== path));
}
