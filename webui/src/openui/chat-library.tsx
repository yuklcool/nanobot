import { createContext, useContext, useState } from "react";
import { createLibrary, defineComponent, reactive, useIsStreaming, useStateField, useTriggerAction } from "@openuidev/react-lang";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import type { DisplayTable } from "./data-contract";

export const ChatInteraction = createContext(false);
export const DisplayDataContext = createContext<Record<string, DisplayTable>>({});
const Text = defineComponent({
  name: "Text", description: "Literal public answer text.",
  props: z.object({ text: z.string().max(16000) }),
  component: ({ props }) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{props.text}</p>,
});
const Followup = defineComponent({
  name: "Followup", description: "User-authored follow-up sent to the same Agent session.",
  props: z.object({ value: reactive(z.string()) }),
  component: function FollowupField({ props }) {
    const { t } = useTranslation();
    const value = useStateField("question", props.value);
    const trigger = useTriggerAction();
    const enabled = useContext(ChatInteraction);
    const streaming = useIsStreaming();
    return <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (enabled && !streaming && value.value?.trim()) void trigger("followup", undefined, {
        type: "continue_conversation", params: { action_id: "conversation.followup", question: value.value },
      });
    }}>
      <input className="min-w-0 flex-1 rounded-control border bg-background px-2 py-1" maxLength={2000}
        aria-label={t("openui.followup")} placeholder={t("openui.followup")}
        disabled={!enabled || streaming} value={value.value ?? ""}
        onChange={(event) => value.setValue(event.target.value)} />
      <button className="rounded-control border px-3 py-1" type="button" disabled={!enabled || streaming}
        onClick={() => { void trigger("save", undefined, { type: "save_draft", params: { question: value.value ?? "" } }); }}>
        {t("openui.saveDraft")}</button>
      <button className="rounded-control border px-3 py-1" type="submit"
        disabled={!enabled || streaming || !value.value?.trim()}>{t("openui.submit")}</button>
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
    return <section className="my-3 min-w-0">
      <h3 className="font-medium">{data.title}</h3>
      <time className="text-xs text-muted-foreground" dateTime={new Date(data.captured_at * 1000).toISOString()}>
        {t("openui.snapshotTime", { time: new Date(data.captured_at * 1000).toLocaleString() })}
      </time>
      <input className="my-2 w-full rounded-control border bg-background px-2 py-1"
        aria-label={t("openui.filterRecords")} placeholder={t("openui.filterRecords")} maxLength={200}
        value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm" aria-label={data.title}>
        <thead><tr>{Object.entries(data.columns).map(([key, label]) => <th className="p-2" key={key}>{label}</th>)}
          <th className="p-2">{t("openui.analyzeRecord")}</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          {Object.keys(data.columns).map((key) => <td className="border-t p-2" key={key}>{String(row.values[key] ?? "")}</td>)}
          <td className="border-t p-2"><button type="button" className="rounded-control border px-2 py-1"
            disabled={!enabled || streaming} onClick={() => { void trigger("analyze", undefined, {
              type: "record_analyze", params: { data_ref: data.data_ref, record_id: row.id },
            }); }}>{t("openui.analyzeRecord")}</button></td>
        </tr>)}</tbody>
      </table></div>
      <p className="text-xs text-muted-foreground">{t("openui.showingRows", { shown: rows.length, total: data.total_rows ?? data.rows.length })}</p>
    </section>;
  },
});
const Panel = defineComponent({
  name: "Panel", description: "Public answer and follow-up form.",
  props: z.object({ children: z.array(z.union([Text.ref, Followup.ref, DataTable.ref])).max(6) }),
  component: ({ props, renderNode }) => <section className="mt-3 rounded-lg border border-border bg-muted/20 p-3">{renderNode(props.children)}</section>,
});
export const chatLibrary = createLibrary({ id: "nanobot-chat-v1", root: "Panel", components: [Panel, Text, Followup, DataTable] });
export const followupSchema = z.object({ type: z.literal("continue_conversation"), params: z.object({
  action_id: z.literal("conversation.followup"), question: z.string().trim().min(1).max(2000),
}).strict() });
