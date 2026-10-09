import { FolderOpen, GitBranch, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { basename } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

interface Props {
  recent: string[];
  busy: boolean;
  onOpen(): void;
  onOpenPath(path: string): void;
  onForget(path: string): void;
}

/** What the window shows before a repository is open. */
export function EmptyState({ recent, busy, onOpen, onOpenPath, onForget }: Props) {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md text-center">
        <GitBranch className="mx-auto size-10 text-muted-foreground" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold">{t("No repository open")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Open a folder that contains a Git repository to browse its history.")}
        </p>
        <Button className="mt-5" onClick={onOpen} disabled={busy}>
          <FolderOpen />
          {t("Open a repository")}
        </Button>

        {recent.length > 0 && (
          <div className="mt-8 text-left">
            <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("Recent")}
            </h2>
            <ul className="divide-y rounded-lg border">
              {recent.map((path) => (
                <li key={path} className="flex items-center">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col px-3 py-2 text-left hover:bg-muted/60 disabled:opacity-50"
                    onClick={() => onOpenPath(path)}
                    disabled={busy}
                  >
                    <span className="text-sm font-medium">{basename(path)}</span>
                    <span className="w-full truncate text-xs text-muted-foreground">{path}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-2 text-muted-foreground"
                    aria-label={t("Remove {name} from the recent list", { name: basename(path) })}
                    onClick={() => onForget(path)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
