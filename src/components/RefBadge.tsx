import { Cloud, GitBranch, Tag } from "lucide-react";

import type { RefInfo } from "@/bindings";
import { cn } from "@/lib/utils";

const STYLES = {
  localBranch: {
    Icon: GitBranch,
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  remoteBranch: {
    Icon: Cloud,
    className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  tag: {
    Icon: Tag,
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
} as const;

interface Props {
  reference: RefInfo;
  /** Whether this is the checked-out branch. */
  isHead?: boolean;
  className?: string;
}

/** A small pill naming a branch or tag. */
export function RefBadge({ reference, isHead = false, className }: Props) {
  const { Icon, className: kindClass } = STYLES[reference.kind];
  return (
    <span
      className={cn(
        "inline-flex max-w-48 items-center gap-1 rounded-md border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap",
        kindClass,
        isHead && "font-semibold ring-1 ring-current",
        className,
      )}
      title={reference.name}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{reference.name}</span>
    </span>
  );
}
