import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { createLibrary, defineComponent, reactive, useIsStreaming, useStateField, useTriggerAction } from "@openuidev/react-lang";
import { ArrowUp, ArrowUpRight, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "../components/ui/button";
import type { DisplayTable } from "./data-contract";

export const ChatInteraction = createContext(false);
export const DisplayDataContext = createContext<Record<string, DisplayTable>>({});
export const formFieldSchema = z.object({
  label: z.string().min(1).max(80), placeholder: z.string().max(120).optional(),
  options: z.array(z.string().min(1).max(120)).min(2).max(6).optional(),
  persist: z.boolean().optional(),
});
export const formInputSchema = z.object({
  form_id: z.string().regex(/^form-[0-5]$/), title: z.string().min(1).max(160),
  fields: z.array(formFieldSchema).min(1).max(3), values: z.array(z.string().max(400)).min(1).max(3),
  submit: z.boolean(),
});
export type FormInput = z.infer<typeof formInputSchema>;
export const formStateSchema = z.object({
  schema: z.string(), values: z.array(z.string().max(400)).max(3),
  status: z.enum(["draft", "prepared", "unknown", "submitted"]),
  request_id: z.string().optional(), content_digest: z.string().optional(),
});
export type FormState = z.infer<typeof formStateSchema>;
export const FormRecovery = createContext<{
  forms: Record<string, FormState>;
  update: (form: FormInput) => Promise<FormState>;
} | null>(null);
const FormPosition = createContext("form-0");
const Text = defineComponent({
  name: "Text", description: "A short plain-text introduction to an interaction. The answer is already visible; never repeat it.",
  props: z.object({ text: z.string().max(16000) }),
  component: ({ props }) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{props.text}</p>,
});
const Choices = defineComponent({
  name: "Choices", description: "Two to four contextual replies or confirmation choices. A click sends the selected question to the same conversation; it does not execute a business operation directly.",
  props: z.object({
    title: z.string().min(1).max(160),
    options: z.array(z.object({ label: z.string().min(1).max(80), question: z.string().trim().min(1).max(2000) })).min(2).max(4),
  }),
  component: function ReplyChoices({ props }) {
    const enabled = useContext(ChatInteraction);
    const streaming = useIsStreaming();
    const trigger = useTriggerAction();
    return <div role="group" aria-label={props.title} className="flex min-w-0 flex-col items-start gap-2.5">
      <p className="text-reading-small text-muted-foreground">{props.title}</p>
      <div className="flex max-w-full flex-wrap gap-2">{props.options.map((option, index) =>
        <Button key={index} type="button" variant="outline" size="sm"
          className="h-auto min-h-9 max-w-full gap-2 whitespace-normal py-2 text-left font-normal"
          disabled={!enabled || streaming} onClick={() => { void trigger(`choice-${index}`, undefined, {
            type: "continue_conversation", params: { action_id: "conversation.followup", question: option.question },
          }); }}>
          <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>)}</div>
    </div>;
  },
});
const Form = defineComponent({
  name: "Form", description: "Ask for one to three missing details in a compact form. All fields are required. Use options for a select, otherwise a short text input. Set persist:true only for non-sensitive details such as project name or priority to restore drafts. Omitted persist means memory only. Never request passwords, tokens, credentials or other secrets. Submitted values become a user message, never a direct tool call. Do not prefill business facts.",
  props: z.object({
    title: z.string().min(1).max(160),
    fields: z.array(formFieldSchema).min(1).max(3),
  }),
  component: function DetailForm({ props }) {
    const { t } = useTranslation();
    const id = useId();
    const recovery = useContext(FormRecovery);
    const formId = useContext(FormPosition);
    const restored = recovery?.forms[formId];
    const [values, setValues] = useState<string[]>(() => props.fields.map((_, index) => restored?.values[index] ?? ""));
    const [notice, setNotice] = useState("");
    const [saveFailed, setSaveFailed] = useState(false);
    const [sending, setSending] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const saving = useRef(false);
    const submitting = useRef(false);
    const latest = useRef({ recovery, props, values });
    latest.current = { recovery, props, values };
    const enabled = useContext(ChatInteraction);
    const streaming = useIsStreaming();
    const trigger = useTriggerAction();
    const locked = submitted || restored?.status === "submitted" || restored?.status === "unknown";
    const complete = props.fields.every((field, index) => values[index]?.trim()
      && (!field.options || field.options.includes(values[index])));
    const remembered = JSON.stringify(props.fields.map((field, index) => field.persist ? values[index] : ""));
    const saved = JSON.stringify(restored?.values ?? props.fields.map(() => ""));
    async function saveDraft() {
      const current = latest.current;
      if (!current.recovery || saving.current || submitting.current) return;
      saving.current = true;
      setNotice(t("openui.savingDraft"));
      try {
        await current.recovery.update({ form_id: formId, ...current.props,
          values: current.props.fields.map((field, index) => field.persist ? current.values[index] : ""), submit: false });
        setNotice(t("openui.saved"));
        setSaveFailed(false);
      } catch { setNotice(t("openui.draftFailed")); setSaveFailed(true); }
      finally { saving.current = false; }
    }
    const saveRef = useRef(saveDraft);
    saveRef.current = saveDraft;
    useEffect(() => {
      if (!recovery || !enabled || streaming || locked || restored?.request_id || remembered === saved || saveFailed) return;
      const timer = setTimeout(() => { void saveRef.current(); }, 500);
      return () => clearTimeout(timer);
    }, [recovery, enabled, streaming, locked, restored?.request_id, remembered, saved, saveFailed]);
    async function submit() {
      if (!enabled || streaming || !complete || locked || submitting.current) return;
      submitting.current = true;
      setSending(true);
      setNotice("");
      try {
        if (recovery) {
          const entry = await recovery.update({ form_id: formId, ...props, values, submit: true });
          if (entry.status === "unknown") { setNotice(t("openui.submissionUnknown")); return; }
          setSubmitted(true);
        } else {
          const question = [props.title, ...props.fields.map((field, index) => `${field.label}: ${values[index].trim()}`)].join("\n");
          await trigger("details", undefined, { type: "continue_conversation", params: { action_id: "conversation.followup", question } });
        }
      } catch { setNotice(t("openui.submitFailed")); }
      finally { submitting.current = false; setSending(false); }
    }
    return <form aria-label={props.title} className="flex w-full max-w-lg flex-col gap-3 rounded-control border border-border/70 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}>
      <p className="text-reading-small font-medium">{props.title}</p>
      {props.fields.map((field, index) => <div className="flex min-w-0 flex-col gap-1.5" key={index}>
        <label className="text-reading-small text-muted-foreground" htmlFor={`${id}-${index}`}>{field.label}</label>
        {field.options ? <select id={`${id}-${index}`} required disabled={!enabled || streaming || locked || sending}
          className="h-10 min-w-0 rounded-control border border-input bg-background px-3 text-reading-small focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={values[index] ?? ""} onChange={(event) => { setSaveFailed(false); setValues((current) => props.fields.map((_, i) => i === index ? event.target.value : current[i] ?? "")); }}>
          <option value="" disabled>{field.placeholder || field.label}</option>
          {field.options.map((option, optionIndex) => <option key={optionIndex} value={option}>{option}</option>)}
        </select> : <input id={`${id}-${index}`} required maxLength={400} disabled={!enabled || streaming || locked || sending}
          className="h-10 min-w-0 rounded-control border border-input bg-background px-3 text-reading-small placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={field.placeholder} value={values[index] ?? ""}
          onChange={(event) => { setSaveFailed(false); setValues((current) => props.fields.map((_, i) => i === index ? event.target.value : current[i] ?? "")); }} />}
        {recovery && field.persist && <span className="text-caption text-muted-foreground">{t("openui.rememberedField")}</span>}
      </div>)}
      <Button type="submit" size="sm" className="self-end gap-2" disabled={!enabled || streaming || !complete || locked || sending}>
        {t("openui.submit")}<ArrowUp className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {(locked || notice) && <p role="status" className="text-caption text-muted-foreground">{
        restored?.status === "unknown" ? t("openui.submissionUnknown") : locked ? t("openui.submitted") : notice
      }</p>}
      {saveFailed && !locked && <Button type="button" variant="ghost" size="sm" className="self-start"
        disabled={!enabled || streaming || sending} onClick={() => { void saveDraft(); }}>{t("openui.saveDraft")}</Button>}
    </form>;
  },
});
const Followup = defineComponent({
  name: "Followup", description: "Optional free-text follow-up with an explicitly saved draft. Use only when an open-ended answer is needed; the conversation already has a composer. Prefer Choices or Form for specific questions.",
  props: z.object({ value: reactive(z.string()) }),
  component: function FollowupField({ props }) {
    const { t } = useTranslation();
    const value = useStateField("question", props.value);
    const trigger = useTriggerAction();
    const enabled = useContext(ChatInteraction);
    const streaming = useIsStreaming();
    return <form className="flex max-w-lg flex-wrap items-center gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (enabled && !streaming && value.value?.trim()) void trigger("followup", undefined, {
        type: "continue_conversation", params: { action_id: "conversation.followup", question: value.value },
      });
    }}>
      <input className="h-10 min-w-0 flex-1 rounded-control border border-input bg-background px-3 text-reading-small focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" maxLength={2000}
        aria-label={t("openui.followup")} placeholder={t("openui.followup")}
        disabled={!enabled || streaming} value={value.value ?? ""}
        onChange={(event) => value.setValue(event.target.value)} />
      <Button variant="ghost" size="sm" type="button" disabled={!enabled || streaming}
        onClick={() => { void trigger("save", undefined, { type: "save_draft", params: { question: value.value ?? "" } }); }}>
        {t("openui.saveDraft")}</Button>
      <Button size="icon" type="submit" aria-label={t("openui.submit")}
        disabled={!enabled || streaming || !value.value?.trim()}><ArrowUp className="h-4 w-4" aria-hidden /></Button>
    </form>;
  },
});
const DataTable = defineComponent({
  name: "DataTable", description: "Authoritative captured table, local filtering and a read-only Agent analysis action; never supply cell values in the layout.",
  props: z.object({ data_ref: z.string().min(1).max(128) }),
  component: function CapturedTable({ props }) {
    const { t } = useTranslation();
    const datasets = useContext(DisplayDataContext);
    const data = Object.hasOwn(datasets, props.data_ref) ? datasets[props.data_ref] : undefined;
    const enabled = useContext(ChatInteraction);
    const streaming = useIsStreaming();
    const trigger = useTriggerAction();
    const [filter, setFilter] = useState("");
    if (!data) return <p role="status">{t("openui.unavailable")}</p>;
    const rows = data.rows.filter((row) => Object.values(row.values).some((value) =>
      String(value ?? "").toLocaleLowerCase().includes(filter.toLocaleLowerCase())));
    return <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="text-reading-small font-medium">{data.title}</h3>
      <time className="text-caption text-muted-foreground" dateTime={new Date(data.captured_at * 1000).toISOString()}>
        {t("openui.snapshotTime", { time: new Date(data.captured_at * 1000).toLocaleString() })}
      </time></div>
      <div className="relative max-w-xs"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
      <input className="h-10 w-full rounded-control border border-input bg-background pl-9 pr-3 text-reading-small focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={t("openui.filterRecords")} placeholder={t("openui.filterRecords")} maxLength={200}
        value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
      <div className="max-w-full overflow-x-auto rounded-control border border-border/70"><table className="w-full text-left text-reading-small tabular-nums" aria-label={data.title}>
        <thead className="bg-muted/40 text-muted-foreground"><tr>{Object.entries(data.columns).map(([key, label]) => <th scope="col" className="px-3 py-2.5 font-medium" key={key}>{label}</th>)}
          <th scope="col" className="px-3 py-2.5 font-medium">{t("openui.analyzeRecord")}</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className="hover:bg-muted/20">
          {Object.keys(data.columns).map((key) => <td className="border-t border-border/60 px-3 py-2" key={key}>{String(row.values[key] ?? "")}</td>)}
          <td className="border-t border-border/60 px-3 py-2"><Button type="button" variant="ghost" size="sm"
            disabled={!enabled || streaming} onClick={() => { void trigger("analyze", undefined, {
              type: "record_analyze", params: { data_ref: data.data_ref, record_id: row.id },
            }); }}>{t("openui.analyzeRecord")}</Button></td>
        </tr>)}</tbody>
      </table></div>
      <p className="text-caption text-muted-foreground">{t("openui.showingRows", { shown: rows.length, total: data.total_rows ?? data.rows.length })}</p>
    </section>;
  },
});
const Panel = defineComponent({
  name: "Panel", description: "Inline interactions that supplement the already visible answer. Use an empty children array when no interaction helps. Never duplicate the answer or add a generic form to every reply.",
  props: z.object({ children: z.array(z.union([Text.ref, Choices.ref, Form.ref, Followup.ref, DataTable.ref])).max(6) }),
  component: ({ props, renderNode }) => props.children.length ? <div className="mt-4 flex min-w-0 flex-col gap-4">{
    props.children.map((child, index) => <FormPosition.Provider key={index} value={`form-${index}`}>{renderNode(child)}</FormPosition.Provider>)
  }</div> : null,
});
export const chatLibrary = createLibrary({ id: "nanobot-chat-v1", root: "Panel", components: [Panel, Text, Choices, Form, Followup, DataTable] });
export const followupSchema = z.object({ type: z.literal("continue_conversation"), params: z.object({
  action_id: z.literal("conversation.followup"), question: z.string().trim().min(1).max(2000),
}).strict() });
