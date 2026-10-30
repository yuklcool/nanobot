import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Renderer, type OpenUIError } from "@openuidev/react-lang";
import { MousePointer2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import manifest from "../../../nanobot/openui/generated/chat-library.json";
import type { NanobotClient } from "@/lib/nanobot-client";
import type { UIMessage } from "@/lib/types";
import type { SendOptions, SubmittedTurn } from "@/hooks/useNanobotStream";
import { acceptSnapshot, uiSnapshotSchema, type UiSnapshot } from "./snapshot";
import type { OpenUIAction, OpenUIMode } from "../../../packages/client-events/openui";
import { ChatInteraction, DisplayDataContext, FormRecovery, chatLibrary, followupSchema, formStateSchema,
  type FormInput, type FormState } from "./chat-library";

interface ChatViews {
  blocks: UiSnapshot[];
  available: boolean;
  mode: OpenUIMode;
  autoAvailable: boolean;
  selectMode: (mode: OpenUIMode) => void;
  send: (question: string, options: SendOptions) => SubmittedTurn | null;
  save: (snapshot: UiSnapshot, question: string) => Promise<void>;
  control: (snapshot: UiSnapshot, action: "cancel" | "retry") => Promise<void>;
  prepareRecord: (snapshot: UiSnapshot, dataRef: string, recordId: string) => Promise<string>;
  formRecovery: boolean;
  updateForm: (snapshot: UiSnapshot, form: FormInput) => Promise<UiSnapshot>;
}
const Views = createContext<ChatViews | null>(null);
const responseSchema = z.object({ capability: z.object({ protocol: z.literal(1), library_hash: z.string() }),
  session_generation: z.string().nullable(), blocks: z.array(uiSnapshotSchema).max(100) });
const eventSchema = z.object({ event: z.literal("openui.snapshot"), chat_id: z.string(), snapshot: uiSnapshotSchema });

export function OpenUIChatProvider({ client, chatId, disabled = false, messages, send, children }: {
  client: NanobotClient; chatId: string | null; messages: UIMessage[];
  disabled?: boolean;
  send: (question: string, images?: undefined, options?: SendOptions) => SubmittedTurn | null;
  children: ReactNode;
}) {
  const [blocks, setBlocks] = useState<UiSnapshot[]>([]);
  const [available, setAvailable] = useState(false);
  const [selectedMode, setSelectedMode] = useState<OpenUIMode>("markdown");
  const [autoAvailable, setAutoAvailable] = useState(false);
  const [formRecovery, setFormRecovery] = useState(false);
  const latestBlocks = useRef(new Map<string, UiSnapshot>());
  const stateQueue = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef<string | null>(null);
  const mode = useRef<OpenUIMode>("markdown");
  const epoch = useRef(0);
  const turnIds = JSON.stringify([...new Set(messages.map((message) => message.turnId).filter(Boolean))]);

  const merge = useCallback((next: UiSnapshot) => {
    if (next.chat_id !== chatId || next.library_hash !== manifest.library_hash) return;
    if (generation.current !== null && next.session_generation !== generation.current) return;
    generation.current = next.session_generation;
    const previous = latestBlocks.current.get(next.block_id) ?? null;
    const accepted = acceptSnapshot(previous, next, next);
    if (accepted && accepted !== previous) {
      latestBlocks.current.set(next.block_id, accepted);
      setBlocks([...latestBlocks.current.values()]);
    }
  }, [chatId]);

  useEffect(() => {
    epoch.current += 1;
    generation.current = null;
    latestBlocks.current.clear();
    setBlocks([]);
    setAvailable(false);
    mode.current = disabled ? "markdown" : client.getOpenUIMode(chatId);
    setSelectedMode(mode.current);
    setAutoAvailable(false);
    setFormRecovery(false);
  }, [client, chatId, disabled]);

  useEffect(() => {
    let active = true;
    let latestLoad = 0;
    const supported = () => client.getOpenUI()?.library_hash === manifest.library_hash;
    function activate() {
      const supportsAuto = client.getOpenUI()?.modes?.includes("auto") === true;
      setAutoAvailable(supportsAuto);
      setFormRecovery(client.getOpenUI()?.form_recovery === true);
      if (mode.current === "auto" && !supportsAuto) {
        mode.current = "markdown";
        setSelectedMode("markdown");
      }
      client.setOpenUIMode(chatId, mode.current);
      setAvailable(true);
    }
    async function load() {
      const requestEpoch = epoch.current;
      const invocation = ++latestLoad;
      if (disabled || !supported()) { if (active) setAvailable(false); return; }
      if (!chatId) { if (active) activate(); return; }
      try {
        const turns: string[] = JSON.parse(turnIds);
        for (let offset = 0; offset < Math.max(1, turns.length); offset += 100) {
          const result = responseSchema.parse(await client.requestMutation("openui.subscribe", {
            chat_id: chatId, turn_ids: turns.slice(offset, offset + 100),
          }));
          if (!active || requestEpoch !== epoch.current || invocation !== latestLoad
            || !supported() || result.capability.library_hash !== manifest.library_hash) return;
          if (generation.current !== result.session_generation) {
            generation.current = result.session_generation;
            latestBlocks.current.clear();
            setBlocks([]);
          }
          activate();
          result.blocks.forEach(merge);
        }
      } catch { if (active && requestEpoch === epoch.current && invocation === latestLoad) setAvailable(false); }
    }
    const unready = client.onReady(() => { void load(); });
    const unsession = client.onSessionUpdate((updated) => { if (updated === chatId) void load(); });
    const unstatus = client.onStatus((status) => {
      if (status !== "open" && active) {
        epoch.current += 1;
        generation.current = null;
        latestBlocks.current.clear();
        setBlocks([]);
        setAvailable(false);
        setFormRecovery(false);
      }
    });
    const unevent = client.onOpenUI((value) => {
      if (!active || !supported()) return;
      const result = eventSchema.safeParse(value);
      if (result.success && result.data.chat_id === chatId) merge(result.data.snapshot);
    });
    void load();
    return () => { active = false; unready(); unsession(); unstatus(); unevent(); };
  }, [client, chatId, disabled, merge, turnIds]);

  useEffect(() => () => { client.setOpenUIMode(chatId, "markdown"); }, [client, chatId, disabled]);
  const updateState = useCallback((snapshot: UiSnapshot, action: string, payload: object) => {
    const requestEpoch = epoch.current;
    const operation = stateQueue.current.catch(() => {}).then(async () => {
      const current = latestBlocks.current.get(snapshot.block_id);
      if (requestEpoch !== epoch.current || !current || current.chat_id !== snapshot.chat_id
        || current.session_generation !== snapshot.session_generation || current.revision !== snapshot.revision) throw new Error("View changed");
      const result = z.object({ snapshot: uiSnapshotSchema }).parse(await client.requestMutation(action, {
        chat_id: snapshot.chat_id, session_generation: snapshot.session_generation, block_id: snapshot.block_id,
        revision: snapshot.revision, expected_state_version: current.state_version, ...payload,
      }));
      if (requestEpoch !== epoch.current) throw new Error("Connection changed");
      merge(result.snapshot);
      return result.snapshot;
    });
    stateQueue.current = operation;
    return operation;
  }, [client, merge]);
  const save = useCallback(async (snapshot: UiSnapshot, question: string) => {
    await updateState(snapshot, "openui.state", { question });
  }, [updateState]);
  const updateForm = useCallback((snapshot: UiSnapshot, form: FormInput) => {
    if (client.getOpenUI()?.form_recovery !== true) return Promise.reject(new Error("Form recovery unavailable"));
    return updateState(snapshot, "openui.form", { form });
  }, [client, updateState]);
  const control = useCallback(async (snapshot: UiSnapshot, action: "cancel" | "retry") => {
    const requestEpoch = epoch.current;
    const result = z.object({ snapshot: uiSnapshotSchema }).parse(await client.requestMutation(`openui.${action}`, {
      chat_id: snapshot.chat_id, session_generation: snapshot.session_generation,
      block_id: snapshot.block_id, revision: snapshot.revision,
    }));
    if (requestEpoch === epoch.current) merge(result.snapshot);
  }, [client, merge]);
  const prepareRecord = useCallback(async (snapshot: UiSnapshot, dataRef: string, recordId: string) => {
    const requestEpoch = epoch.current;
    const result = z.object({ content: z.string().min(1).max(8192) }).parse(await client.requestMutation("openui.prepare_record", {
      chat_id: snapshot.chat_id, session_generation: snapshot.session_generation, block_id: snapshot.block_id,
      revision: snapshot.revision, data_ref: dataRef, record_id: recordId,
    }));
    if (requestEpoch !== epoch.current) throw new Error("Connection changed");
    return result.content;
  }, [client]);
  const selectMode = useCallback((next: OpenUIMode) => {
    client.setOpenUIMode(chatId, next);
    mode.current = next;
    setSelectedMode(next);
  }, [chatId, client]);
  const value = useMemo(() => ({ blocks, available, mode: selectedMode, autoAvailable, formRecovery, updateForm, selectMode, save, control, prepareRecord,
    send: (question: string, options: SendOptions) => send(question, undefined, options),
  }), [blocks, available, selectedMode, autoAvailable, formRecovery, updateForm, selectMode, save, control, prepareRecord, send]);
  return <Views.Provider value={value}>{children}</Views.Provider>;
}

export function OpenUIControls() {
  const views = useContext(Views);
  const { t } = useTranslation();
  if (!views?.available) return null;
  return <label className="inline-flex w-fit items-center gap-1.5 rounded-control px-1.5 text-caption text-muted-foreground">
    <MousePointer2 className="h-3.5 w-3.5" aria-hidden />
    <span className="hidden sm:inline">{t("openui.enable")}</span>
    <select aria-label={t("openui.enable")} value={views.mode}
      className="rounded-control border border-input bg-background px-2 py-1 text-caption text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onChange={(event) => views.selectMode(event.target.value as OpenUIMode)}>
      <option value="markdown">{t("openui.modeMarkdown")}</option>
      {views.autoAvailable && <option value="auto">{t("openui.modeAuto")}</option>}
      <option value="openui">{t("openui.modeOpenui")}</option>
    </select>
  </label>;
}

class Boundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function Block({ snapshot, views }: { snapshot: UiSnapshot; views: ChatViews }) {
  const { t } = useTranslation();
  const [parseFailed, setParseFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const requests = useRef(new Map<string, string>());
  const confirmed = useRef(new Set<string>());
  const storedForms = z.record(z.string().regex(/^form-[0-5]$/), formStateSchema).safeParse(snapshot.state.$forms ?? {});
  const onError = useCallback((errors: OpenUIError[]) => {
    setParseFailed(errors.some((error) => error.severity !== "warning"));
  }, []);
  const editable = views.available && snapshot.status === "complete" && !parseFailed && !busy && storedForms.success;
  async function updateForm(form: FormInput): Promise<FormState> {
    const updated = await views.updateForm(snapshot, form);
    const entry = formStateSchema.parse(z.record(z.string(), formStateSchema).parse(updated.state.$forms)[form.form_id]);
    if (!form.submit || entry.status === "submitted" || entry.status === "unknown") return entry;
    if (!entry.request_id) throw new Error("Missing submission identity");
    const question = [form.title, ...form.fields.map((field, index) => `${field.label}: ${form.values[index].trim()}`)].join("\n");
    const result = views.send(question, { uiAction: {
      session_generation: snapshot.session_generation, block_id: snapshot.block_id, revision: snapshot.revision,
      request_id: entry.request_id, action_id: "conversation.followup", form_id: form.form_id,
    } });
    if (!result?.delivery) throw new Error("No admission receipt");
    await result.delivery;
    return { ...entry, status: "submitted" };
  }
  async function control(action: "cancel" | "retry") {
    if (pending.current || !views.available) return;
    pending.current = true;
    setBusy(true);
    try { await views.control(snapshot, action); }
    catch { setNotice(t("openui.checkConversation")); }
    finally { pending.current = false; setBusy(false); }
  }
  const fallback = <div><p role="status">{t("openui.unavailable")}</p>
    <button type="button" className="rounded-control border px-2 py-1" disabled={!views.available || busy}
      onClick={() => { void control("retry"); }}>{t("openui.retryView")}</button></div>;
  const failed = snapshot.status !== "streaming" && snapshot.status !== "complete";

  async function action(event: unknown) {
    if (!editable || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const draft = z.object({ type: z.literal("save_draft"), params: z.object({ question: z.string().max(2000) }) }).safeParse(event);
      if (draft.success) {
        await views.save(snapshot, draft.data.params.question);
        setNotice(t("openui.saved"));
      } else {
        const record = z.object({ type: z.literal("record_analyze"), params: z.object({
          data_ref: z.string().min(1).max(128), record_id: z.string().min(1).max(256),
        }).strict() }).safeParse(event);
        const question = record.success
          ? await views.prepareRecord(snapshot, record.data.params.data_ref, record.data.params.record_id)
          : followupSchema.parse(event).params.question;
        const identity = JSON.stringify([record.success ? "record.analyze" : "conversation.followup", record.success ? record.data.params : question]);
        if (confirmed.current.has(identity)) { setNotice(t("openui.submitted")); return; }
        let requestId = requests.current.get(identity);
        if (!requestId) { requestId = crypto.randomUUID(); requests.current.set(identity, requestId); }
        const uiAction: OpenUIAction = {
          session_generation: snapshot.session_generation, block_id: snapshot.block_id,
          revision: snapshot.revision, request_id: requestId,
          action_id: record.success ? "record.analyze" : "conversation.followup",
          ...(record.success ? record.data.params : {}),
        };
        const result = views.send(question, { uiAction });
        if (!result?.delivery) throw new Error("No admission receipt");
        await result.delivery;
        confirmed.current.add(identity);
        setNotice(t("openui.submitted"));
      }
    } catch { setNotice(t("openui.checkConversation")); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Boundary fallback={fallback}>
    <ChatInteraction.Provider value={editable}>
    <DisplayDataContext.Provider value={snapshot.tables ?? {}}>
    <FormRecovery.Provider value={views.formRecovery && storedForms.success ? { forms: storedForms.data, update: updateForm } : null}>
      {failed || !storedForms.success || (parseFailed && snapshot.status === "complete") ? fallback : <Renderer library={chatLibrary}
        response={snapshot.source} isStreaming={snapshot.status === "streaming"} initialState={snapshot.state}
        onAction={(event) => { void action(event); }} onError={onError} publishObservability={false} />}
      {snapshot.status === "streaming" && <button type="button" className="rounded-control border px-2 py-1"
        disabled={!views.available || busy} onClick={() => { void control("cancel"); }}>{t("openui.cancelView")}</button>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    </FormRecovery.Provider>
    </DisplayDataContext.Provider>
    </ChatInteraction.Provider>
  </Boundary>;
}
export function OpenUIMessage({ message }: { message: UIMessage }) {
  const views = useContext(Views);
  if (!views || message.role !== "assistant" || message.kind === "trace" || message.isStreaming) return null;
  const blocks = views.blocks.filter((block) => block.turn_id === message.turnId && block.anchor_seq === message.turnSeq);
  return <>{blocks.map((block) => <Block key={`${block.session_generation}:${block.block_id}:${block.revision}`}
    snapshot={block} views={views} />)}</>;
}
