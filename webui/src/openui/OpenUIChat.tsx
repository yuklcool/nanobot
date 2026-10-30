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
import type { OpenUIAction } from "../../../packages/client-events/openui";
import { ChatInteraction, DisplayDataContext, chatLibrary, followupSchema } from "./chat-library";

interface ChatViews {
  blocks: UiSnapshot[];
  available: boolean;
  enabled: boolean;
  toggle: (enabled: boolean) => void;
  send: (question: string, options: SendOptions) => SubmittedTurn | null;
  save: (snapshot: UiSnapshot, question: string) => Promise<void>;
  control: (snapshot: UiSnapshot, action: "cancel" | "retry") => Promise<void>;
  prepareRecord: (snapshot: UiSnapshot, dataRef: string, recordId: string) => Promise<string>;
}
const Views = createContext<ChatViews | null>(null);
const responseSchema = z.object({ capability: z.object({ protocol: z.literal(1), library_hash: z.string() }),
  session_generation: z.string().nullable(), blocks: z.array(uiSnapshotSchema).max(100) });
const eventSchema = z.object({ event: z.literal("openui.snapshot"), chat_id: z.string(), snapshot: uiSnapshotSchema });

export function OpenUIChatProvider({ client, chatId, messages, send, children }: {
  client: NanobotClient; chatId: string | null; messages: UIMessage[];
  send: (question: string, images?: undefined, options?: SendOptions) => SubmittedTurn | null;
  children: ReactNode;
}) {
  const [blocks, setBlocks] = useState<UiSnapshot[]>([]);
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const generation = useRef<string | null>(null);
  const mode = useRef(false);
  const epoch = useRef(0);
  const turnIds = JSON.stringify([...new Set(messages.map((message) => message.turnId).filter(Boolean))]);

  const merge = useCallback((next: UiSnapshot) => {
    if (next.chat_id !== chatId || next.library_hash !== manifest.library_hash) return;
    if (generation.current !== null && next.session_generation !== generation.current) return;
    generation.current = next.session_generation;
    setBlocks((current) => {
      const previous = current.find((item) => item.block_id === next.block_id) ?? null;
      const accepted = acceptSnapshot(previous, next, next);
      return accepted && accepted !== previous
        ? [...current.filter((item) => item.block_id !== next.block_id), accepted] : current;
    });
  }, [chatId]);

  useEffect(() => {
    epoch.current += 1;
    generation.current = null;
    setBlocks([]);
    setAvailable(false);
    mode.current = false;
    setEnabled(false);
  }, [client, chatId]);

  useEffect(() => {
    let active = true;
    let latestLoad = 0;
    const supported = () => client.getOpenUI()?.library_hash === manifest.library_hash;
    async function load() {
      const requestEpoch = epoch.current;
      const invocation = ++latestLoad;
      if (!chatId || !supported()) { if (active) setAvailable(false); return; }
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
            setBlocks([]);
          }
          setAvailable(true);
          client.setOpenUIMode(chatId, mode.current);
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
        setBlocks([]);
        setAvailable(false);
      }
    });
    const unevent = client.onOpenUI((value) => {
      if (!active || !supported()) return;
      const result = eventSchema.safeParse(value);
      if (result.success && result.data.chat_id === chatId) merge(result.data.snapshot);
    });
    void load();
    return () => { active = false; unready(); unsession(); unstatus(); unevent(); };
  }, [client, chatId, merge, turnIds]);

  useEffect(() => () => { if (chatId) client.setOpenUIMode(chatId, false); }, [client, chatId]);
  const save = useCallback(async (snapshot: UiSnapshot, question: string) => {
    const requestEpoch = epoch.current;
    const result = z.object({ snapshot: uiSnapshotSchema }).parse(await client.requestMutation("openui.state", {
      chat_id: snapshot.chat_id, session_generation: snapshot.session_generation, block_id: snapshot.block_id,
      revision: snapshot.revision, expected_state_version: snapshot.state_version, question,
    }));
    if (requestEpoch === epoch.current) merge(result.snapshot);
  }, [client, merge]);
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
  const toggle = useCallback((next: boolean) => {
    mode.current = next;
    setEnabled(next);
    if (chatId) client.setOpenUIMode(chatId, next);
  }, [chatId, client]);
  const value = useMemo(() => ({ blocks, available, enabled, toggle, save, control, prepareRecord,
    send: (question: string, options: SendOptions) => send(question, undefined, options),
  }), [blocks, available, enabled, toggle, save, control, prepareRecord, send]);
  return <Views.Provider value={value}>{children}</Views.Provider>;
}

export function OpenUIControls() {
  const views = useContext(Views);
  const { t } = useTranslation();
  if (!views?.available) return null;
  return <label className="mx-3 my-1 inline-flex w-fit cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-reading-small text-muted-foreground hover:bg-muted/40 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring">
    <input type="checkbox" className="peer sr-only" checked={views.enabled} onChange={(event) => views.toggle(event.target.checked)} />
    <MousePointer2 className="h-3.5 w-3.5 peer-checked:text-foreground" aria-hidden />
    <span className="peer-checked:text-foreground">{t("openui.enable")}</span>
    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 peer-checked:bg-foreground" aria-hidden />
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
  const onError = useCallback((errors: OpenUIError[]) => {
    setParseFailed(errors.some((error) => error.severity !== "warning"));
  }, []);
  const editable = views.available && snapshot.status === "complete" && !parseFailed && !busy;
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
        const identity = JSON.stringify([record.success ? "record.analyze" : "conversation.followup", question]);
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
      {failed || (parseFailed && snapshot.status === "complete") ? fallback : <Renderer library={chatLibrary}
        response={snapshot.source} isStreaming={snapshot.status === "streaming"} initialState={snapshot.state}
        onAction={(event) => { void action(event); }} onError={onError} publishObservability={false} />}
      {snapshot.status === "streaming" && <button type="button" className="rounded-control border px-2 py-1"
        disabled={!views.available || busy} onClick={() => { void control("cancel"); }}>{t("openui.cancelView")}</button>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
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
