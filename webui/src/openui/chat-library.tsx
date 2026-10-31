import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { createLibrary, defineComponent, reactive, useIsStreaming, useStateField, useTriggerAction, createParser } from "@openuidev/react-lang";
import { ArrowUp, ArrowUpRight, Search, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "../components/ui/button";
import type { DataQuery, DisplayTable, SessionDetail } from "./data-contract";
import { emptyFormValue, formComplete, formContent, formDefinitionSchema, initialFormValues, normalizeFormValues, visibleFields,
  type FormInput, type FormState, type FormValue } from "./form-contract";
import { SessionRenameForm } from "./SessionRenameForm";

export const ChatInteraction = createContext(false);
export const DisplayDataContext = createContext<Record<string, DisplayTable>>({});
export const ReadonlyQuery = createContext<((request: DataQuery) => Promise<SessionDetail | null>) | null>(null);
export const FormRecovery = createContext<{
  forms: Record<string, FormState>;
  update: (form: FormInput) => Promise<FormState>;
} | null>(null);
const FormPosition = createContext("form-0");
const Text = defineComponent({
  name: "Text", description: "A short introduction to an interaction. In a replacement Panel, preserve essential explanation and caveats from the answer; otherwise the answer is already visible, so never repeat it. Tabular facts belong in DataTable.",
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
  name: "Form", description: "Collect details or render an entire questionnaire (1–12 fields). Keep a survey together in ONE Form, with description and presentation:questionnaire; use it as the only Panel child. Preserve the questions and options from the answer. Use type:radio for one choice, checkbox for multiple choices, select for a dropdown, otherwise text. Fields are required unless required:false. when:{field:0,value:\"Other\"} shows a field only when that earlier choice is selected (also matches checkbox selections). Add conditional text fields for Other details and conditional follow-up questions. Set persist:true ONLY for explicitly non-sensitive details; omit it for employee, income or other personal survey answers. When revising a submitted questionnaire, create a NEW Form; initial may contain an existing answer from the public question or answer ONLY with persist:true and explicit permission to retain it. Never invent initial answers or copy personal survey answers into initial. Never ask for secrets. Submission sends all visible answers together to this conversation. Exception: for an explicit request to rename THIS conversation, use one required text field and action:{type:session.rename,title:requested title}; the user reviews and confirms before its sidebar title is saved. Never use this action for files or other conversations.",
  props: formDefinitionSchema,
  component: ({ props }) => <FormInteraction props={props} />,
});
function FormInteraction({ props }: { props: z.infer<typeof formDefinitionSchema> }) {
  const formId = useContext(FormPosition);
  const enabled = useContext(ChatInteraction);
    const streaming = useIsStreaming();
  return props.action ? <SessionRenameForm formId={formId} title={props.title} label={props.fields[0].label}
    initialTitle={props.action.title} enabled={enabled} /> : <DetailForm key={streaming ? "preview" : "complete"} props={props} />;
}
function DetailForm({ props }: { props: z.infer<typeof formDefinitionSchema> }) {
    const { t } = useTranslation();
    const id = useId();
    const recovery = useContext(FormRecovery);
    const formId = useContext(FormPosition);
    const restored = recovery?.forms[formId];
    const [values, setValues] = useState<FormValue[]>(() => restored?.values ?? initialFormValues(props.fields));
    const [notice, setNotice] = useState("");
    const [saveFailed, setSaveFailed] = useState(false);
    const [draftConflict, setDraftConflict] = useState(false);
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
    const complete = formComplete(props.fields, values);
    const visible = visibleFields(props.fields, values);
    const questionnaire = props.presentation === "questionnaire";
    const remembered = JSON.stringify(normalizeFormValues(props.fields, values, true));
    const saved = JSON.stringify(restored?.values ?? props.fields.map(emptyFormValue));
    const acknowledgedDraft = useRef(saved);
    const ownDraft = useRef<string | null>(null);
    useEffect(() => {
      if (saved === acknowledgedDraft.current) return;
      const previous = acknowledgedDraft.current;
      acknowledgedDraft.current = saved;
      const own = ownDraft.current;
      ownDraft.current = null;
      if (saved === own || saved === remembered || locked) return;
      if (remembered !== previous) {
        setDraftConflict(true);
        setNotice("");
      } else {
        setValues((current) => normalizeFormValues(props.fields, props.fields.map((field, index) =>
          field.persist ? restored?.values[index] ?? emptyFormValue(field) : current[index] ?? emptyFormValue(field))));
      }
    }, [saved, remembered, locked, props.fields, restored?.values]);
    const total = props.fields.filter((field, index) => visible[index] && field.required !== false).length;
    const done = props.fields.filter((field, index) => visible[index] && field.required !== false && formComplete([ { ...field, when: undefined } ], [values[index] ?? emptyFormValue(field)])).length;
    function change(index: number, value: FormValue) {
      setSaveFailed(false);
      setValues((current) => normalizeFormValues(props.fields,
        props.fields.map((field, i) => i === index ? value : current[i] ?? emptyFormValue(field))));
    }
    async function saveDraft() {
      const current = latest.current;
      if (!current.recovery || saving.current || submitting.current) return;
      saving.current = true;
      setNotice(t("openui.savingDraft"));
      const draftValues = normalizeFormValues(current.props.fields, current.values, true);
      ownDraft.current = JSON.stringify(draftValues);
      try {
        await current.recovery.update({ form_id: formId, ...current.props,
          values: draftValues, submit: false });
        setNotice(t("openui.saved"));
        setSaveFailed(false);
        setDraftConflict(false);
      } catch { ownDraft.current = null; setNotice(t("openui.draftFailed")); setSaveFailed(true); }
      finally { saving.current = false; }
    }
    const saveRef = useRef(saveDraft);
    saveRef.current = saveDraft;
    useEffect(() => {
      if (!recovery || !enabled || streaming || locked || draftConflict || restored?.request_id || remembered === saved || saveFailed) return;
      const timer = setTimeout(() => { void saveRef.current(); }, 500);
      return () => clearTimeout(timer);
    }, [recovery, enabled, streaming, locked, draftConflict, restored?.request_id, remembered, saved, saveFailed]);
    async function submit() {
      if (!enabled || streaming || !complete || locked || draftConflict || submitting.current) return;
      const form = { form_id: formId, ...props, values: normalizeFormValues(props.fields, values), submit: true };
      const question = formContent(form);
      if ([...question].length > (recovery ? 4000 : 2000)) { setNotice(t("openui.formTooLong")); return; }
      submitting.current = true;
      setSending(true);
      setNotice("");
      try {
        if (recovery) {
          const entry = await recovery.update(form);
          if (entry.status === "unknown") { setNotice(t("openui.submissionUnknown")); return; }
          setSubmitted(true);
        } else {
          await trigger("details", undefined, { type: "continue_conversation", params: { action_id: "conversation.followup", question } });
        }
      } catch { setNotice(t("openui.submitFailed")); }
      finally { submitting.current = false; setSending(false); }
    }
    const disabled = !enabled || streaming || locked || sending;
    return <form aria-label={props.title} className={questionnaire
      ? "flex w-full max-w-2xl flex-col gap-5"
      : "flex w-full max-w-lg flex-col gap-3 rounded-control border border-border/70 p-4"}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="flex flex-col gap-2">
        <p className={questionnaire ? "text-title font-semibold [text-wrap:balance]" : "text-reading-small font-medium"}>{props.title}</p>
        {props.description && <p className="whitespace-pre-wrap text-reading-small text-muted-foreground">{props.description}</p>}
      </div>
      <div className={questionnaire ? "flex flex-col gap-5" : "flex flex-col gap-3"}>
      {props.fields.map((field, index) => {
        if (!visible[index]) return null;
        const fieldId = `${id}-${index}`;
        const value = values[index] ?? emptyFormValue(field);
        const kind = field.type ?? (field.options ? "select" : "text");
        return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2" key={index}>
          <legend className="mb-2 max-w-full text-reading-small font-medium [overflow-wrap:anywhere]">
            <label htmlFor={kind === "text" || kind === "select" ? fieldId : undefined}>{field.label}</label>
            {field.required === false && <span className="ml-2 text-caption font-normal text-muted-foreground">{t("openui.optional")}</span>}
          </legend>
          {kind === "radio" || kind === "checkbox" ? <div className="flex flex-wrap gap-x-4 gap-y-2">
            {field.options?.map((option, optionIndex) => <label key={optionIndex}
              className="flex min-h-9 cursor-pointer items-center gap-2 text-reading-small has-[:disabled]:cursor-default has-[:disabled]:text-muted-foreground">
              <input type={kind} name={fieldId} value={option} className="h-4 w-4 shrink-0 accent-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                checked={Array.isArray(value) ? value.includes(option) : value === option}
                onChange={(event) => change(index, kind === "radio" ? option : event.target.checked
                  ? [...(Array.isArray(value) ? value : []), option]
                  : (Array.isArray(value) ? value : []).filter((item) => item !== option))} />
              <span className="[overflow-wrap:anywhere]">{option}</span>
            </label>)}
          </div> : kind === "select" ? <select id={fieldId} required={field.required !== false}
            className="h-10 min-w-0 rounded-control border border-input bg-background px-3 text-reading-small focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={typeof value === "string" ? value : ""} onChange={(event) => change(index, event.target.value)}>
            <option value="" disabled={field.required !== false}>{field.placeholder || field.label}</option>
            {field.options?.map((option, optionIndex) => <option key={optionIndex} value={option}>{option}</option>)}
          </select> : <input id={fieldId} required={field.required !== false} maxLength={400}
            className="h-10 min-w-0 rounded-control border border-input bg-background px-3 text-reading-small placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={field.placeholder} value={typeof value === "string" ? value : ""}
            onChange={(event) => change(index, event.target.value)} />}
          {recovery && field.persist && <span className="text-caption text-muted-foreground">{t("openui.rememberedField")}</span>}
        </fieldset>;
      })}</div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {questionnaire && <span className="text-caption tabular-nums text-muted-foreground">{t("openui.formProgress", { done, total })}</span>}
        <Button type="submit" size="sm" className="ml-auto gap-2" disabled={disabled || !complete || draftConflict}>
          {t(questionnaire ? "openui.submitForm" : "openui.submit")}<ArrowUp className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      {(locked || notice) && <p role="status" className="text-caption text-muted-foreground">{
        restored?.status === "unknown" ? t("openui.submissionUnknown") : locked ? t("openui.submitted") : notice
      }</p>}
      {draftConflict && !locked && <div role="alert" className="flex flex-col items-start gap-2 text-reading-small">
        <p>{t("openui.draftConflict")}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || saving.current}
            onClick={() => {
              setValues((current) => normalizeFormValues(props.fields, props.fields.map((field, index) =>
                field.persist ? restored?.values[index] ?? emptyFormValue(field) : current[index] ?? emptyFormValue(field))));
              ownDraft.current = null;
              setDraftConflict(false); setSaveFailed(false); setNotice("");
            }}>{t("openui.reloadDraft")}</Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled || saving.current}
            onClick={() => { void saveDraft(); }}>{t("openui.keepDraft")}</Button>
        </div>
      </div>}
      {saveFailed && !draftConflict && !locked && <Button type="button" variant="ghost" size="sm" className="self-start"
        disabled={disabled} onClick={() => { void saveDraft(); }}>{t("openui.saveDraft")}</Button>}
    </form>;
}
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
const dataTableProps = z.object({ data_ref: z.string().min(1).max(128) });
const DataTable = defineComponent({
  name: "DataTable", description: "Show an authoritative dataset, with local filtering on its columns and an explicit Agent analysis action. Choose datasets using the request, final answer and explicit Agent subsets. Ordinary keyword candidates remain usable for browsing or comparison; absence of a selection is not an error. The Agent owns content qualification; do not independently reclassify history from dataset titles. Empty data renders a compact status; include it only when revisiting that dataset helps. Supported session tables provide refresh and inline details without a model call. Never supply cell values or query instructions in the layout.",
  props: dataTableProps,
  component: function CapturedTable({ props }) {
    const { t } = useTranslation();
    const datasets = useContext(DisplayDataContext);
    const data = Object.hasOwn(datasets, props.data_ref) ? datasets[props.data_ref] : undefined;
    const enabled = useContext(ChatInteraction);
    const streaming = useIsStreaming();
    const trigger = useTriggerAction();
    const [filter, setFilter] = useState("");
    const query = useContext(ReadonlyQuery);
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState<DataQuery | null>(null);
    const pending = useRef(false);
    useEffect(() => { setDetail(null); setFailed(null); }, [data?.captured_at]);
    const canQuery = !!query && data?.source_tool === "search_sessions" && !!data.session_query;
    async function read(request: DataQuery) {
      if (!query || !enabled || streaming || pending.current) return;
      pending.current = true;
      setLoading(true);
      setFailed(null);
      setDetail(null);
      try { setDetail(await query(request)); }
      catch { setFailed(request); }
      finally { pending.current = false; setLoading(false); }
    }
    if (!data) return <p role="status">{t("openui.unavailable")}</p>;
    const rows = data.rows.filter((row) => Object.values(row.values).some((value) =>
      String(value ?? "").toLocaleLowerCase().includes(filter.toLocaleLowerCase())));
    return <section className="flex min-w-0 flex-col gap-3" aria-busy={loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="text-reading-small font-medium">{data.title}</h3>
      <time className="text-caption text-muted-foreground" dateTime={new Date(data.captured_at * 1000).toISOString()}>
        {t("openui.snapshotTime", { time: new Date(data.captured_at * 1000).toLocaleString() })}
      </time></div>
      {(data.rows.length > 0 || canQuery) && <div className="flex flex-wrap items-center gap-2">{data.rows.length > 0 && <div className="relative max-w-xs"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
      <input className="h-10 w-full rounded-control border border-input bg-background pl-9 pr-3 text-reading-small focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={t("openui.filterRecords")} placeholder={t("openui.filterRecords")} maxLength={200}
        value={filter} onChange={(event) => setFilter(event.target.value)} /></div>}
      {canQuery && <Button type="button" variant="outline" size="sm" className="gap-2"
        disabled={!enabled || streaming || loading} onClick={() => { void read({ data_ref: data.data_ref, operation: "refresh" }); }}>
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />{t("openui.refreshData")}
      </Button>}</div>}
      {rows.length > 0 && <><div className="max-w-full overflow-x-auto rounded-control border border-border/70"><table className="w-full text-left text-reading-small tabular-nums" aria-label={data.title}>
        <thead className="bg-muted/40 text-muted-foreground"><tr>{Object.entries(data.columns).map(([key, label]) => <th scope="col" className="px-3 py-2.5 font-medium" key={key}>{label}</th>)}
          {canQuery && <th scope="col" className="px-3 py-2.5 font-medium">{t("openui.viewDetails")}</th>}
          <th scope="col" className="px-3 py-2.5 font-medium">{t("openui.analyzeRecord")}</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className="hover:bg-muted/20">
          {Object.keys(data.columns).map((key) => <td className="border-t border-border/60 px-3 py-2" key={key}>{String(row.values[key] ?? "")}</td>)}
          {canQuery && <td className="border-t border-border/60 px-3 py-2"><Button type="button" variant="ghost" size="sm"
            disabled={!enabled || streaming || loading} onClick={() => { void read({ data_ref: data.data_ref, operation: "detail", record_id: row.id }); }}>
            {t("openui.viewDetails")}</Button></td>}
          <td className="border-t border-border/60 px-3 py-2"><Button type="button" variant="ghost" size="sm"
            disabled={!enabled || streaming || loading} onClick={() => { void trigger("analyze", undefined, {
              type: "record_analyze", params: { data_ref: data.data_ref, record_id: row.id },
            }); }}>{t("openui.analyzeRecord")}</Button></td>
        </tr>)}</tbody>
      </table></div>
      <p className="text-caption text-muted-foreground">{t("openui.showingRows", { shown: rows.length, total: data.total_rows ?? data.rows.length })}</p></>}
      {!rows.length && !loading && !failed && <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="text-reading-small text-muted-foreground">{t(data.rows.length ? "openui.noRecords" : "openui.emptyData")}</p>
        {data.rows.length > 0 && filter && <Button type="button" variant="ghost" size="sm" onClick={() => setFilter("")}>{t("openui.clearFilter")}</Button>}
      </div>}
      {loading && <p role="status" className="text-reading-small text-muted-foreground">{t("openui.loadingData")}</p>}
      {failed && <div role="alert" className="flex flex-wrap items-center gap-2 text-reading-small">
        <span>{t("openui.queryFailed")}</span><Button type="button" variant="outline" size="sm" disabled={!enabled || streaming || loading}
          onClick={() => { void read(failed); }}>{t("openui.retryData")}</Button>
      </div>}
      {detail && <section aria-label={t("openui.recordDetails")} className="flex min-w-0 flex-col gap-3 rounded-control border border-border/70 p-4">
        <div className="flex items-center justify-between gap-3"><h4 className="text-reading-small font-medium [overflow-wrap:anywhere]">{detail.title}</h4>
          <Button type="button" variant="ghost" size="icon" aria-label={t("openui.closeDetails")} onClick={() => setDetail(null)}><X className="h-4 w-4" aria-hidden /></Button></div>
        {detail.messages.length ? detail.messages.map((message, index) => <div key={index} className="min-w-0">
          <p className="mb-1 text-caption text-muted-foreground">{t(message.role === "user" ? "openui.historyUser" : "openui.historyAssistant")}</p>
          <p className="whitespace-pre-wrap text-reading-small [overflow-wrap:anywhere]">{message.content}</p>
        </div>) : <p className="text-reading-small text-muted-foreground">{t("openui.noMessages")}</p>}
      </section>}
    </section>;
  },
});
const Panel = defineComponent({
  name: "Panel", description: "Inline interactions. Choose presentation explicitly: replace when DataTable children present a list/table already in the answer, including multiple comparison tables; supplement for added interactions that need the original answer visible. In replace mode preserve essential explanation, caveats and scope labels in Text children. Every visible component must be included in children. When a static candidate list does not supply the requested content, replace it with ONE nonempty Text explaining that conclusion and search limits. The complete original answer remains expandable. Use empty children when no interaction or replacement helps. Never add redundant controls or a generic form to every reply.",
  props: z.object({ children: z.array(z.union([Text.ref, Choices.ref, Form.ref, Followup.ref, DataTable.ref])).max(6),
    presentation: z.enum(["supplement", "replace"]).optional() }),
  component: ({ props, renderNode }) => props.children.length ? <div className="mt-4 flex min-w-0 flex-col gap-4">{
    props.children.map((child, index) => <FormPosition.Provider key={index} value={`form-${index}`}>{renderNode(child)}</FormPosition.Provider>)
  }</div> : null,
});
export const chatLibrary = createLibrary({ id: "nanobot-chat-v1", root: "Panel", components: [Panel, Text, Choices, Form, Followup, DataTable] });
export const followupSchema = z.object({ type: z.literal("continue_conversation"), params: z.object({
  action_id: z.literal("conversation.followup"), question: z.string().trim().min(1).max(2000),
}).strict() });

const parser = createParser(chatLibrary.toJSONSchema(), chatLibrary.root);
export function replacesAnswer(source: string, tables: Record<string, DisplayTable>): boolean {
  try {
    const result = parser.parse(source);
    if (result.meta.incomplete || result.meta.errors.length || result.meta.unresolved.length) return false;
    const children = result.root?.typeName === "Panel" ? result.root.props.children : null;
    if (!Array.isArray(children)) return false;
    const node = children[0];
    if (children.length === 1 && node?.typeName === "Form" && node.props?.presentation === "questionnaire"
      && formDefinitionSchema.safeParse(node.props).success) return true;
    const data = children.filter((child) => child?.typeName === "DataTable");
    const explanation = children.length === 1 && node?.typeName === "Text"
      && typeof node.props?.text === "string" && node.props.text.trim().length > 0 && node.props.text.length <= 16000;
    return result.root?.props.presentation === "replace" && (explanation || (data.length > 0 && data.every((child) => {
      const parsed = dataTableProps.safeParse(child.props);
      return parsed.success && Object.hasOwn(tables, parsed.data.data_ref);
    })));
  } catch { return false; }
}
