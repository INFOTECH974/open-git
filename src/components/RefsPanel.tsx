import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Archive,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  Link,
  Pencil,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import type { HeadInfo, RefInfo, StashEntry } from "@/bindings";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** What the context menu of a branch or tag can do. */
export type RefAction =
  | "checkout"
  | "createBranch"
  | "rename"
  | "delete"
  | "push"
  | "setUpstream"
  | "merge"
  | "rebase"
  | "deleteRemote"
  | "deleteTag"
  | "copyName";

export type StashAction = "apply" | "pop" | "drop";

/** Drag-and-drop ids carry the ref name; `refFromDragId` reads it back. */
export function dragIdOf(reference: RefInfo): string {
  return `ref:${reference.kind}:${reference.name}`;
}

export function refFromDragId(id: string, refs: RefInfo[]): RefInfo | undefined {
  const [, kind, ...name] = id.split(":");
  const fullName = name.join(":");
  return refs.find((reference) => reference.kind === kind && reference.name === fullName);
}

interface Props {
  refs: RefInfo[];
  stashes: StashEntry[];
  head: HeadInfo;
  selectedId: string | null;
  /** While an operation runs, double-clicking does not start another checkout. */
  busy: boolean;
  onSelect(id: string): void;
  onRefAction(action: RefAction, reference: RefInfo): void;
  onStashAction(action: StashAction, stash: StashEntry): void;
  /** Rendered below the stashes, inside the same scroll area (the GitHub sections). */
  children?: ReactNode;
}

type Icon = ComponentType<{ className?: string }>;

/**
 * Local branches, remote branches grouped by remote, tags and stashes.
 *
 * Branches can be dragged onto one another; the enclosing `DndContext` decides
 * what the drop means (merge, rebase…).
 */
export function RefsPanel({
  refs,
  stashes,
  head,
  selectedId,
  busy,
  onSelect,
  onRefAction,
  onStashAction,
  children,
}: Props) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    const local: RefInfo[] = [];
    const tags: RefInfo[] = [];
    const remotes = new Map<string, RefInfo[]>();
    for (const reference of refs) {
      if (needle && !reference.name.toLowerCase().includes(needle)) continue;
      switch (reference.kind) {
        case "localBranch":
          local.push(reference);
          break;
        case "tag":
          tags.push(reference);
          break;
        case "remoteBranch": {
          const slash = reference.name.indexOf("/");
          const remote = slash < 0 ? reference.name : reference.name.slice(0, slash);
          const list = remotes.get(remote);
          if (list) list.push(reference);
          else remotes.set(remote, [reference]);
        }
      }
    }
    return { local, remotes: [...remotes.entries()], tags };
  }, [refs, needle]);

  const shownStashes = needle
    ? stashes.filter((stash) => stash.message.toLowerCase().includes(needle))
    : stashes;

  const current = head.branch;
  const item = (reference: RefInfo, label: string) => {
    const isCurrent = reference.kind === "localBranch" && reference.name === current;
    const branch = reference.kind !== "tag";
    return (
      <RefItem
        key={reference.name}
        label={label}
        hint={
          reference.kind === "tag"
            ? t("Double-click to check out (detached)")
            : isCurrent
              ? t("Checked out")
              : t("Double-click to check out, drag onto another branch to merge or rebase")
        }
        isHead={isCurrent}
        selected={reference.target === selectedId}
        dragId={branch && !busy ? dragIdOf(reference) : undefined}
        dropId={branch ? dragIdOf(reference) : undefined}
        onClick={() => onSelect(reference.target)}
        onDoubleClick={() => {
          if (!busy && !isCurrent) onRefAction("checkout", reference);
        }}
        menu={
          <RefMenu
            reference={reference}
            current={current}
            disabled={busy}
            onAction={(action) => onRefAction(action, reference)}
          />
        }
      />
    );
  };

  return (
    <nav className="flex h-full flex-col text-sm">
      <div className="relative shrink-0 px-2 pt-2">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 translate-y-[calc(-50%+4px)] text-muted-foreground" />
        <input
          className="h-7 w-full rounded-md border bg-background pr-6 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder={t("Filter branches and tags")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label={t("Filter branches and tags")}
        />
        {filter && (
          <button
            type="button"
            className="absolute top-1/2 right-3 translate-y-[calc(-50%+4px)] rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={t("Clear the filter")}
            onClick={() => setFilter("")}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto py-2">
        <Section title={t("Local")} icon={GitBranch} count={groups.local.length}>
          {groups.local.map((reference) => item(reference, reference.name))}
        </Section>
        {groups.remotes.map(([remote, list]) => (
          <Section key={remote} title={remote} icon={Cloud} count={list.length}>
            {list.map((reference) =>
              item(reference, reference.name.slice(remote.length + 1) || reference.name),
            )}
          </Section>
        ))}
        <Section
          title={t("Tags")}
          icon={Tag}
          count={groups.tags.length}
          defaultOpen={groups.tags.length <= 20}
        >
          {groups.tags.map((reference) => item(reference, reference.name))}
        </Section>
        <Section title={t("Stashes")} icon={Archive} count={shownStashes.length}>
          {shownStashes.map((stash) => (
            <RefItem
              key={stash.id}
              label={stash.message}
              hint={`stash@{${stash.index}}`}
              isHead={false}
              selected={false}
              onClick={() => {}}
              onDoubleClick={() => {
                if (!busy) onStashAction("apply", stash);
              }}
              menu={
                <ContextMenuContent className="w-56">
                  <ContextMenuItem disabled={busy} onSelect={() => onStashAction("apply", stash)}>
                    {t("Apply (keep the stash)")}
                  </ContextMenuItem>
                  <ContextMenuItem disabled={busy} onSelect={() => onStashAction("pop", stash)}>
                    {t("Pop (apply and drop)")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    disabled={busy}
                    onSelect={() => onStashAction("drop", stash)}
                  >
                    <Trash2 />
                    {t("Drop…")}
                  </ContextMenuItem>
                </ContextMenuContent>
              }
            />
          ))}
        </Section>
        {children}
      </div>
    </nav>
  );
}

interface RefMenuProps {
  reference: RefInfo;
  current: string | null;
  disabled: boolean;
  onAction(action: RefAction): void;
}

function RefMenu({ reference, current, disabled, onAction }: RefMenuProps) {
  const { t } = useI18n();
  const isCurrent = reference.kind === "localBranch" && reference.name === current;
  const short =
    reference.kind === "remoteBranch"
      ? reference.name.slice(reference.name.indexOf("/") + 1)
      : reference.name;
  const name = <code className="font-mono">{reference.name}</code>;
  const currentName = <code className="font-mono">{current ?? "HEAD"}</code>;
  return (
    <ContextMenuContent className="w-72">
      {!isCurrent && (
        <ContextMenuItem disabled={disabled} onSelect={() => onAction("checkout")}>
          <GitBranch />
          <span className="truncate">
            {reference.kind === "tag" ? (
              <>
                {t("Check out")} {name} ({t("detached")})
              </>
            ) : (
              <>
                {t("Check out")} {short}
              </>
            )}
          </span>
        </ContextMenuItem>
      )}
      <ContextMenuItem disabled={disabled} onSelect={() => onAction("createBranch")}>
        <GitBranchPlus />
        {t("Create a branch here…")}
      </ContextMenuItem>
      {reference.kind === "localBranch" && (
        <>
          <ContextMenuItem disabled={disabled} onSelect={() => onAction("rename")}>
            <Pencil />
            {t("Rename…")}
          </ContextMenuItem>
          <ContextMenuItem disabled={disabled} onSelect={() => onAction("push")}>
            <ArrowUpFromLine />
            {t("Push to remote")}
          </ContextMenuItem>
          <ContextMenuItem disabled={disabled} onSelect={() => onAction("setUpstream")}>
            <Link />
            {t("Set upstream…")}
          </ContextMenuItem>
        </>
      )}
      {!isCurrent && reference.kind !== "tag" && current && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={disabled} onSelect={() => onAction("merge")}>
            <GitMerge />
            <span className="truncate">
              {t("Merge")} {name} {t("into")} {currentName}
            </span>
          </ContextMenuItem>
          <ContextMenuItem disabled={disabled} onSelect={() => onAction("rebase")}>
            <GitMerge />
            <span className="truncate">
              {t("Rebase")} {currentName} {t("onto")} {name}
            </span>
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onAction("copyName")}>
        <Copy />
        {t("Copy name")}
      </ContextMenuItem>
      {reference.kind === "localBranch" && !isCurrent && (
        <ContextMenuItem variant="destructive" disabled={disabled} onSelect={() => onAction("delete")}>
          <Trash2 />
          {t("Delete…")}
        </ContextMenuItem>
      )}
      {reference.kind === "remoteBranch" && (
        <ContextMenuItem
          variant="destructive"
          disabled={disabled}
          onSelect={() => onAction("deleteRemote")}
        >
          <Trash2 />
          {t("Delete on the remote…")}
        </ContextMenuItem>
      )}
      {reference.kind === "tag" && (
        <ContextMenuItem variant="destructive" disabled={disabled} onSelect={() => onAction("deleteTag")}>
          <Trash2 />
          {t("Delete tag…")}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

interface SectionProps {
  title: string;
  icon: Icon;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, icon: Icon, count, defaultOpen = true, children }: SectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="mb-1">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Chevron className="size-3.5" aria-hidden />
        <Icon className="size-3.5" aria-hidden />
        <span className="truncate">{title}</span>
        <span className="ml-auto tabular-nums">{count}</span>
      </button>
      {open && (
        <ul>
          {children}
          {count === 0 && <li className="px-7 py-1 text-xs text-muted-foreground">{t("None")}</li>}
        </ul>
      )}
    </section>
  );
}

interface RefItemProps {
  label: string;
  hint: string;
  isHead: boolean;
  selected: boolean;
  /** Set to make the item draggable (branches only). */
  dragId?: string;
  /** Set to accept a dragged branch. */
  dropId?: string;
  onClick(): void;
  onDoubleClick(): void;
  menu: ReactNode;
}

function RefItem({
  label,
  hint,
  isHead,
  selected,
  dragId,
  dropId,
  onClick,
  onDoubleClick,
  menu,
}: RefItemProps) {
  const { t } = useI18n();
  const draggable = useDraggable({ id: dragId ?? `none:${label}`, disabled: !dragId });
  const droppable = useDroppable({ id: dropId ?? `none:${label}`, disabled: !dropId });
  // Dropping a branch onto itself means nothing.
  const over = droppable.isOver && droppable.active?.id !== dropId;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li ref={droppable.setNodeRef}>
          <button
            ref={draggable.setNodeRef}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 py-1 pr-2 pl-7 text-left select-none hover:bg-muted/60",
              selected && "bg-accent text-accent-foreground",
              isHead && "font-semibold",
              over && "bg-primary/10 ring-1 ring-primary ring-inset",
              draggable.isDragging && "opacity-40",
            )}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            title={`${label}\n${hint}`}
            {...draggable.listeners}
            {...draggable.attributes}
          >
            <span className="truncate">{label}</span>
            {isHead && (
              <span
                className="ml-auto size-1.5 shrink-0 rounded-full bg-emerald-500"
                aria-label={t("Checked out")}
              />
            )}
          </button>
        </li>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}
