import { createContext, useContext } from "react";
import { createLibrary, defineComponent, reactive, useIsStreaming, useStateField, useTriggerAction } from "@openuidev/react-lang";
import { useTranslation } from "react-i18next";
import { z } from "zod";

export const ChatInteraction = createContext(false);
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
const Panel = defineComponent({
  name: "Panel", description: "Public answer and follow-up form.",
  props: z.object({ children: z.array(z.union([Text.ref, Followup.ref])).max(2) }),
  component: ({ props, renderNode }) => <section className="mt-3 rounded-lg border border-border bg-muted/20 p-3">{renderNode(props.children)}</section>,
});
export const chatLibrary = createLibrary({ id: "nanobot-chat-v1", root: "Panel", components: [Panel, Text, Followup] });
export const followupSchema = z.object({ type: z.literal("continue_conversation"), params: z.object({
  action_id: z.literal("conversation.followup"), question: z.string().trim().min(1).max(2000),
}).strict() });
