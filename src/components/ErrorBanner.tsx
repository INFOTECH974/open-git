import { CircleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

interface Props {
  message: string;
  onDismiss(): void;
}

/** A dismissible strip reporting a failed operation. */
export function ErrorBanner({ message, onDismiss }: Props) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <pre className="min-w-0 flex-1 font-sans break-words whitespace-pre-wrap">{message}</pre>
      <Button variant="ghost" size="icon-xs" aria-label={t("Dismiss")} onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}
