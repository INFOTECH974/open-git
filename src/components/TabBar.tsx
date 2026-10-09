import type { ReactNode } from "react";
import { GitBranch, X } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface TabItem {
  path: string;
  name: string;
}

interface Props {
  tabs: TabItem[];
  activePath: string | null;
  onActivate(path: string): void;
  onClose(path: string): void;
  /** Rendered after the tabs, typically the "open" menu. */
  trailing?: ReactNode;
  /** Rendered at the far right, such as the theme switch. */
  end?: ReactNode;
}

/** The application header: one tab per open repository. */
export function TabBar({ tabs, activePath, onActivate, onClose, trailing, end }: Props) {
  const { t } = useI18n();
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/40 pr-2 pl-3 select-none">
      <div className="flex shrink-0 items-center gap-2 text-sm font-semibold">
        <GitBranch className="size-4" aria-hidden />
        gitui
      </div>
      <div role="tablist" className="app-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.path === activePath;
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.path}
              className={cn(
                "group flex h-7 max-w-56 min-w-0 shrink items-center gap-1 rounded-md pr-1 pl-2.5 text-sm",
                active
                  ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={() => onActivate(tab.path)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.path);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onActivate(tab.path);
                }
              }}
            >
              <span className="truncate">{tab.name}</span>
              <button
                type="button"
                aria-label={t("Close {name}", { name: tab.name })}
                className={cn(
                  "rounded p-0.5 hover:bg-muted-foreground/20 focus-visible:opacity-100",
                  active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.path);
                }}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
        {trailing}
      </div>
      {end && <div className="flex shrink-0 items-center gap-1">{end}</div>}
    </header>
  );
}
