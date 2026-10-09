import { type FormEvent, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";

export type FormField =
  | {
      key: string;
      label: string;
      type: "text";
      placeholder?: string;
      initial?: string;
      required?: boolean;
      /** Rendered in a monospace font (branch names, URLs). */
      mono?: boolean;
    }
  | { key: string; label: string; type: "textarea"; placeholder?: string; initial?: string }
  | { key: string; label: string; type: "checkbox"; initial?: boolean; hint?: string }
  /** A directory path, typed or picked with the system dialog. */
  | { key: string; label: string; type: "folder"; initial?: string; required?: boolean };

export type FormValues = Record<string, string | boolean>;

/** What a form asks; `null` closes the dialog. */
export interface FormRequest {
  title: string;
  description?: string;
  fields: FormField[];
  /** Label of the submit button. */
  action: string;
  onSubmit(values: FormValues): void;
}

interface Props {
  request: FormRequest | null;
  onClose(): void;
}

/** One small form dialog for the whole repository view: branch names, tags, stashes… */
export function FormDialog({ request, onClose }: Props) {
  const { t } = useI18n();
  const [values, setValues] = useState<FormValues>({});

  // Reset the fields whenever a new request opens the dialog.
  useEffect(() => {
    if (!request) return;
    const initial: FormValues = {};
    for (const field of request.fields) {
      initial[field.key] = field.initial ?? (field.type === "checkbox" ? false : "");
    }
    setValues(initial);
  }, [request]);

  const complete =
    request?.fields.every(
      (field) =>
        (field.type !== "text" && field.type !== "folder") ||
        !field.required ||
        String(values[field.key] ?? "").trim() !== "",
    ) ?? false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!request || !complete) return;
    const trimmed: FormValues = {};
    for (const [key, value] of Object.entries(values)) {
      trimmed[key] = typeof value === "string" ? value.trim() : value;
    }
    request.onSubmit(trimmed);
    onClose();
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{request?.title}</DialogTitle>
            {request?.description && <DialogDescription>{request.description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-3">
            {request?.fields.map((field, index) => {
              const id = `form-${field.key}`;
              if (field.type === "checkbox") {
                return (
                  <div key={field.key} className="flex items-start gap-2">
                    <Checkbox
                      id={id}
                      checked={Boolean(values[field.key])}
                      onCheckedChange={(checked) =>
                        setValues((previous) => ({ ...previous, [field.key]: checked === true }))
                      }
                    />
                    <div className="grid gap-0.5 leading-none">
                      <Label htmlFor={id}>{field.label}</Label>
                      {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                    </div>
                  </div>
                );
              }
              if (field.type === "textarea") {
                return (
                  <div key={field.key} className="grid gap-1.5">
                    <Label htmlFor={id}>{field.label}</Label>
                    <textarea
                      id={id}
                      className="min-h-20 w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      placeholder={field.placeholder}
                      value={String(values[field.key] ?? "")}
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                      }
                    />
                  </div>
                );
              }
              if (field.type === "folder") {
                return (
                  <div key={field.key} className="grid gap-1.5">
                    <Label htmlFor={id}>{field.label}</Label>
                    <div className="flex gap-2">
                      <Input
                        id={id}
                        className="font-mono"
                        value={String(values[field.key] ?? "")}
                        onChange={(event) =>
                          setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          void openDialog({ directory: true, multiple: false, title: field.label }).then(
                            (chosen) => {
                              if (typeof chosen === "string") {
                                setValues((previous) => ({ ...previous, [field.key]: chosen }));
                              }
                            },
                          );
                        }}
                      >
                        <FolderOpen />
                        {t("Browse…")}
                      </Button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={field.key} className="grid gap-1.5">
                  <Label htmlFor={id}>{field.label}</Label>
                  <Input
                    id={id}
                    autoFocus={index === 0}
                    className={field.mono ? "font-mono" : undefined}
                    placeholder={field.placeholder}
                    value={String(values[field.key] ?? "")}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                    }
                  />
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!complete}>
              {request?.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
