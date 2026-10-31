import { createContext, useContext, useId, useRef, useState } from "react";
import { useIsStreaming } from "@openuidev/react-lang";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "../components/ui/button";

export const renameReceiptSchema = z.object({
  operation_id: z.string().regex(/^[a-f0-9]{32}$/), title: z.string().min(1).max(160),
  previous_title: z.string().nullable(), expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["prepared", "applied", "conflict", "unknown"]),
}).strict();
export type RenameReceipt = z.infer<typeof renameReceiptSchema>;
export type RenameRequest = { form_id: string } & (
  { operation: "prepare"; title: string } | { operation: "confirm" | "status"; operation_id: string }
);
export const SessionRename = createContext<{
  receipts: Record<string, RenameReceipt>;
  request: (request: RenameRequest) => Promise<void>;
} | null>(null);

export function SessionRenameForm({ formId, title, label, initialTitle, enabled }: {
  formId: string; title: string; label: string; initialTitle: string; enabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const actions = useContext(SessionRename);
  const receipt = actions?.receipts[formId];
  const [value, setValue] = useState(receipt?.title ?? initialTitle);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const streaming = useIsStreaming();
  const locked = receipt?.status === "applied" || receipt?.status === "unknown" || uncertain;
  const disabled = !enabled || streaming || busy || !actions;
  const prepared = receipt?.status === "prepared" && receipt.title === value.trim();
  async function request(operation: "prepare" | "confirm" | "status") {
    if (disabled || pending.current || !actions || (operation !== "prepare" && !receipt)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await actions.request(operation === "prepare"
        ? { form_id: formId, operation, title: value.trim() }
        : { form_id: formId, operation, operation_id: receipt!.operation_id });
      setUncertain(false);
    } catch {
      if (operation === "confirm") setUncertain(true);
      setError(t(operation === "confirm" ? "openui.renameUncertain" : "openui.renameFailed"));
    } finally { pending.current = false; setBusy(false); }
  }
  return <form aria-label={title} className="flex w-full max-w-lg flex-col gap-3 rounded-control border border-border/70 p-4"
    onSubmit={(event) => { event.preventDefault(); if (!locked) void request(prepared ? "confirm" : "prepare"); }}>
    <p className="text-reading-small font-medium">{title}</p>
    <label htmlFor={id} className="text-reading-small">{label}</label>
    <input id={id} value={value} required maxLength={160} disabled={disabled || locked}
      className="h-10 min-w-0 rounded-control border border-input bg-background px-3 text-reading-small"
      onChange={(event) => { setValue(event.target.value); setError(""); }} />
    {prepared && !locked && <p className="whitespace-pre-wrap text-reading-small text-muted-foreground">{
      t("openui.renamePreview", { before: receipt.previous_title ?? t("openui.defaultTitle"), after: receipt.title })
    }</p>}
    {!locked && <Button type="submit" size="sm" className="self-start" disabled={disabled || !value.trim()}>
      {t(busy ? "openui.renameWorking" : prepared ? "openui.renameConfirm" : "openui.renameReview")}
    </Button>}
    {receipt?.status === "applied" && <p role="status">{t("openui.renameApplied", { title: receipt.title })}</p>}
    {receipt?.status === "conflict" && <p role="status">{t("openui.renameConflict")}</p>}
    {(receipt?.status === "unknown" || uncertain) && <p role="status">{t("openui.renameUncertain")}</p>}
    {error && <p role="alert">{error}</p>}
    {receipt && <Button type="button" size="sm" variant="ghost" className="self-start" disabled={disabled}
      onClick={() => { void request("status"); }}>{t("openui.renameStatus")}</Button>}
    {!actions && <p role="status">{t("openui.renameUnavailable")}</p>}
  </form>;
}
