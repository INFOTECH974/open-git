import { Download, FolderGit2, FolderOpen, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { basename } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

interface Props {
  recent: string[];
  /** Paths already open in a tab. */
  openPaths: string[];
  busy: boolean;
  onBrowse(): void;
  onClone(): void;
  onInit(): void;
  onOpenPath(path: string): void;
  onClearRecent(): void;
}

/** The "+" menu: open, clone or create a repository, or reopen a recent one. */
export function OpenMenu({
  recent,
  openPaths,
  busy,
  onBrowse,
  onClone,
  onInit,
  onOpenPath,
  onClearRecent,
}: Props) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          aria-label={t("Open a repository")}
          disabled={busy}
        >
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onSelect={onBrowse}>
          <FolderOpen />
          {t("Open a folder…")}
          <DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onClone}>
          <Download />
          {t("Clone a repository…")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onInit}>
          <FolderGit2 />
          {t("Create a repository…")}
        </DropdownMenuItem>
        {recent.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("Recent")}</DropdownMenuLabel>
            {recent.map((path) => {
              const open = openPaths.includes(path);
              return (
                <DropdownMenuItem key={path} onSelect={() => onOpenPath(path)} title={path}>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{basename(path)}</span>
                    <span className="truncate text-xs text-muted-foreground">{path}</span>
                  </div>
                  {open && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-emerald-500"
                      title={t("Open in a tab")}
                      aria-label={t("Open in a tab")}
                    />
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClearRecent} variant="destructive">
              <Trash2 />
              {t("Clear the recent list")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
