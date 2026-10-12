import type { ComponentType } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CirclePause,
  CircleSlash,
  CircleX,
  LoaderCircle,
} from "lucide-react";

import type { CheckState } from "@/bindings";
import { cn } from "@/lib/utils";

const ICONS: Record<CheckState, { icon: ComponentType<{ className?: string }>; className: string }> = {
  queued: { icon: CircleDashed, className: "text-amber-500" },
  waiting: { icon: CirclePause, className: "text-amber-500" },
  inProgress: { icon: LoaderCircle, className: "animate-spin text-amber-500" },
  success: { icon: CircleCheck, className: "text-emerald-500" },
  failure: { icon: CircleX, className: "text-red-500" },
  cancelled: { icon: CircleSlash, className: "text-muted-foreground" },
  skipped: { icon: CircleMinus, className: "text-muted-foreground" },
  neutral: { icon: CircleMinus, className: "text-muted-foreground" },
};

/** The state of a workflow run, a job or a step, as GitHub draws it. */
export function CheckIcon({ state, className }: { state: CheckState; className?: string }) {
  const { icon: Icon, className: color } = ICONS[state];
  return <Icon className={cn("shrink-0", color, className)} aria-hidden />;
}
