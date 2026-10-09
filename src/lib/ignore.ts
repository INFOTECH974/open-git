/** `.gitignore` lines that would hide a file, from the most specific to the broadest. */
export interface IgnoreChoices {
  /** This file only, anchored to the repository root. */
  file: string;
  /** Every file with the same extension, anywhere; `null` when the name has none. */
  extension: string | null;
  /** Each parent folder, deepest first. */
  folders: { label: string; pattern: string }[];
}

export function ignoreChoices(path: string): IgnoreChoices {
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  const dot = name.lastIndexOf(".");
  // `.env` has no extension; `archive.tar.gz` gives `*.gz`.
  const extension = dot > 0 && dot < name.length - 1 ? `*${name.slice(dot)}` : null;
  const folders = [];
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const dir = segments.slice(0, depth).join("/");
    folders.push({ label: `${dir}/`, pattern: `/${dir}/` });
  }
  return { file: `/${path}`, extension, folders };
}
