import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Renderer, type OpenUIError } from "@openuidev/react-lang";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import manifest from "../../../nanobot/openui/generated/chat-library.json";
import type { NanobotClient } from "@/lib/nanobot-client";
import type { UIMessage } from "@/lib/types";
import type { SendOptions, SubmittedTurn } from "@/hooks/useNanobotStream";
import { acceptSnapshot, uiSnapshotSchema, type UiSnapshot } from "./snapshot";
import { ChatInteraction, chatLibrary, followupSchema } from "./chat-library";

interface ChatViews {
  blocks: UiSnapshot[];
  available: boolean;
  enabled: boolean;
  toggle: (enabled: boolean) => void;
  send: (question: string, options: SendOptions) => SubmittedTurn | null;
  save: (snapshot: UiSnapshot, question: string) => Promise<void>;
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
  const turnIds = JSON.stringify([...new Set(messages.map((message) => message.turnId).filter(Boolean))].slice(-100));

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
    let active = true;
    const supported = () => client.getOpenUI()?.library_hash === manifest.library_hash;
    async function load() {
      if (!chatId || !supported()) { if (active) setAvailable(false); return; }
      try {
        const result = responseSchema.parse(await client.requestMutation("openui.subscribe", {
          chat_id: chatId, turn_ids: JSON.parse(turnIds),
        }));
        if (!active || !supported() || result.capability.library_hash !== manifest.library_hash) return;
        if (generation.current !== result.session_generation) {
          generation.current = result.session_generation;
          setBlocks([]);
        }
        setAvailable(true);
        client.setOpenUIMode(chatId, mode.current);
        result.blocks.forEach(merge);
      } catch { if (active) setAvailable(false); }
    }
    const unready = client.onReady(() => { void load(); });
    const unstatus = client.onStatus((status) => {
      if (status !== "open" && active) setAvailable(false);
    });
    const unevent = client.onOpenUI((value) => {
      if (!active || !supported()) return;
      const result = eventSchema.safeParse(value);
      if (result.success && result.data.chat_id === chatId) merge(result.data.snapshot);
    });
    void load();
    return () => { active = false; unready(); unstatus(); unevent(); };
  }, [client, chatId, merge, turnIds]);

  useEffect(() => () => { if (chatId) client.setOpenUIMode(chatId, false); }, [client, chatId]);
  const save = useCallback(async (snapshot: UiSnapshot, question: string) => {
    const result = z.object({ snapshot: uiSnapshotSchema }).parse(await client.requestMutation("openui.state", {
      chat_id: snapshot.chat_id, session_generation: snapshot.session_generation, block_id: snapshot.block_id,
      revision: snapshot.revision, expected_state_version: snapshot.state_version, question,
    }));
    merge(result.snapshot);
  }, [client, merge]);
  const toggle = useCallback((next: boolean) => {
    mode.current = next;
    setEnabled(next);
    if (chatId) client.setOpenUIMode(chatId, next);
  }, [chatId, client]);
  const value = useMemo(() => ({ blocks, available, enabled, toggle, save,
    send: (question: string, options: SendOptions) => send(question, undefined, options),
  }), [blocks, available, enabled, toggle, save, send]);
  return <Views.Provider value={value}>{children}</Views.Provider>;
}

export function OpenUIControls() {
  const views = useContext(Views);
  const { t } = useTranslation();
  if (!views?.available) return null;
  return <label className="flex items-center gap-2 px-3 py-1 text-sm text-muted-foreground">
    <input type="checkbox" checked={views.enabled} onChange={(event) => views.toggle(event.target.checked)} />
    {t("openui.enable")}
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
  const fallback = <p role="status">{t("openui.unavailable")}</p>;
  if (snapshot.status !== "streaming" && snapshot.status !== "complete") return fallback;

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
        const parsed = followupSchema.parse(event);
        const question = parsed.params.question;
        if (confirmed.current.has(question)) { setNotice(t("openui.submitted")); return; }
        // Reuse the key for an unresolved identical submission. A missing ACK
        // must not silently turn into a second Agent turn.
        let requestId = requests.current.get(question);
        if (!requestId) { requestId = crypto.randomUUID(); requests.current.set(question, requestId); }
        const result = views.send(question, { uiAction: {
          session_generation: snapshot.session_generation, block_id: snapshot.block_id,
          revision: snapshot.revision, request_id: requestId, action_id: "conversation.followup",
        } });
        if (!result?.delivery) throw new Error("No admission receipt");
        await result.delivery;
        confirmed.current.add(question);
        setNotice(t("openui.submitted"));
      }
    } catch { setNotice(t("openui.checkConversation")); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Boundary fallback={fallback}>
    <ChatInteraction.Provider value={editable}>
      {parseFailed && snapshot.status === "complete" ? fallback : <Renderer library={chatLibrary}
        response={snapshot.source} isStreaming={snapshot.status === "streaming"} initialState={snapshot.state}
        onAction={(event) => { void action(event); }} onError={onError} publishObservability={false} />}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
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
