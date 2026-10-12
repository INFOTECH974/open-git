export function shortId(id: string): string {
  return id.slice(0, 7);
}

let relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
let absolute = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
let justNow = "just now";

/** Formats dates in `language` from now on (called when the UI language changes). */
export function setLocale(language: "en" | "fr"): void {
  relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  absolute = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  justNow = language === "fr" ? "à l'instant" : "just now";
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 days ago", for a time in seconds since the Unix epoch. */
export function relativeTime(seconds: number, now = Date.now()): string {
  const elapsed = now / 1000 - seconds;
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) {
      return relative.format(-Math.round(elapsed / size), unit);
    }
  }
  return justNow;
}

export function absoluteTime(seconds: number): string {
  return absolute.format(new Date(seconds * 1000));
}

/** "2m 14s", for a length of time in seconds. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

/** Splits `src/lib/utils.ts` into `src/lib/` and `utils.ts`. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** Last segment of a file system path, whichever separator it uses. */
export function basename(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** `root` + `relative`, with the separator the root already uses. */
export function joinPath(root: string, relative: string): string {
  const windows = root.includes("\\") || /^[A-Za-z]:/.test(root);
  const base = root.replace(/[\\/]+$/, "");
  return windows ? `${base}\\${relative.replace(/\//g, "\\")}` : `${base}/${relative}`;
}

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
