import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** What a confirmation asks; `null` closes the dialog. */
export interface Confirmation {
  title: string;
  description: ReactNode;
  /** Label of the confirming button. */
  action: string;
  /** Red button for data loss. */
  destructive?: boolean;
  onConfirm(): void;
}

interface Props {
  confirmation: Confirmation | null;
  onClose(): void;
}

/** One confirmation dialog for the whole repository view; callers set what it asks. */
export function ConfirmDialog({ confirmation, onClose }: Props) {
  const { t } = useI18n();
  return (
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">{confirmation?.description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(confirmation?.destructive && buttonVariants({ variant: "destructive" }))}
            onClick={() => {
              confirmation?.onConfirm();
              onClose();
            }}
          >
            {confirmation?.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
