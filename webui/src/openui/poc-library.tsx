import { createContext, useContext } from "react";
import {
  createLibrary, defineComponent, reactive, useIsStreaming, useStateField, useTriggerAction,
} from "@openuidev/react-lang";
import { z } from "zod";

// Explicitly experimental: P0 proves the SDK contracts without advertising a
// gateway capability or adding a tool execution path to the shipped chat.
export const POC_LIBRARY_ID = "nanobot-openui-poc-v1";
export const UiInteractionContext = createContext(false);

const Text = defineComponent({
  name: "Text", description: "Plain text; no HTML or Markdown execution.",
  props: z.object({ text: z.string().max(2000) }),
  component: ({ props }) => <p>{props.text}</p>,
});

const Period = defineComponent({
  name: "Period", description: "Choose the analysis period in days.",
  props: z.object({ value: reactive(z.string()) }),
  component: function PeriodField({ props }) {
    const field = useStateField("period", props.value);
    const enabled = useContext(UiInteractionContext);
    const streaming = useIsStreaming();
    return <label>Period<select aria-label="Period" value={field.value ?? "7"}
      disabled={!enabled || streaming} onChange={(event) => field.setValue(event.target.value)}>
      <option value="7">7 days</option><option value="30">30 days</option>
    </select></label>;
  },
});

const Inspect = defineComponent({
  name: "Inspect", description: "Request analysis of the fixture task; never execute a tool directly.",
  props: z.object({ period: reactive(z.string()) }),
  component: function InspectButton({ props }) {
    const period = useStateField("period", props.period);
    const trigger = useTriggerAction();
    const enabled = useContext(UiInteractionContext);
    const streaming = useIsStreaming();
    return <button disabled={!enabled || streaming} onClick={() => {
      void trigger("Inspect task", undefined, {
        type: "continue_conversation",
        params: { action_id: "task.inspect", record_id: "task_08", period: period.value },
      });
    }}>Inspect task</button>;
  },
});

const Panel = defineComponent({
  name: "Panel", description: "A compact task card.",
  props: z.object({ children: z.array(z.union([Text.ref, Period.ref, Inspect.ref])).max(20) }),
  component: ({ props, renderNode }) => <section aria-label="Task card">{renderNode(props.children)}</section>,
});

export const pocLibrary = createLibrary({
  id: POC_LIBRARY_ID, root: "Panel", components: [Panel, Text, Period, Inspect],
});

export const inspectActionSchema = z.object({
  type: z.literal("continue_conversation"),
  params: z.object({
    action_id: z.literal("task.inspect"), record_id: z.literal("task_08"),
    period: z.enum(["7", "30"]),
  }).strict(),
});

/** P0 read-only intent; P1 must carry structured metadata through server admission. */
export function inspectIntent(event: unknown): string | null {
  const result = inspectActionSchema.safeParse(event);
  return result.success
    ? `Inspect task ${result.data.params.record_id} for ${result.data.params.period} days.`
    : null;
}
