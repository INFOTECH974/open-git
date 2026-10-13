import type { Account } from "@/bindings";
import { cn } from "@/lib/utils";

/** The picture of a GitHub account; `className` gives its size. */
export function AccountAvatar({ account, className }: { account: Account; className?: string }) {
  return (
    <img
      src={account.avatarUrl}
      alt=""
      className={cn("shrink-0 rounded-full bg-muted", className)}
      referrerPolicy="no-referrer"
    />
  );
}
