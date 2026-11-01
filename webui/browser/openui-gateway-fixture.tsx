import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ClientProvider } from "../src/providers/ClientProvider";
import { NanobotClient } from "../src/lib/nanobot-client";
import { deriveWsUrl, fetchBootstrap } from "../src/lib/bootstrap";
import { useNanobotStream } from "../src/hooks/useNanobotStream";
import { useSidebarState } from "../src/hooks/useSidebarState";
import { ThreadMessages } from "../src/components/thread/ThreadMessages";
import { ThreadShell } from "../src/components/thread/ThreadShell";
import type { ChatSummary } from "../src/lib/types";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useReadingTypography } from "../src/hooks/useReadingTypography";
import { projectWebuiThreadMessages } from "../src/lib/thread-display-projection";
import { OpenUIChatProvider, OpenUIControls } from "../src/openui/OpenUIChat";
import { initializeI18n } from "../src/i18n";
import "../src/globals.css";

const chatId = "gateway-poc";
function Thread({ client, chatId = "gateway-poc", recovery = false }: { client: NanobotClient; chatId?: string; recovery?: boolean }) {
  useReadingTypography();
  const sidebar = useSidebarState([], false);
  const [question, setQuestion] = useState("Lookup");
  const { messages, send, isStreaming, loadOlder, history } = useNanobotStream(chatId, undefined, false, undefined, undefined, undefined,
    { key: `websocket:${chatId}` });
  const displayed = projectWebuiThreadMessages(messages);
  return <OpenUIChatProvider client={client} chatId={chatId} messages={displayed} send={send}>
    <main style={{ maxWidth: 768, minHeight: "100dvh" }} className="mx-auto flex flex-col gap-6 px-6 py-5">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
      <h1 className="text-title font-medium">Nanobot</h1>
      <OpenUIControls />
      <button type="button" className="text-caption text-muted-foreground hover:text-foreground" onClick={async () => {
        await client.requestMutation("session.delete", { key: `websocket:${chatId}` });
        location.reload();
      }}>Delete conversation</button></header>
      <output aria-label="Conversation title">{sidebar.state.title_overrides[`websocket:${chatId}`] ?? "Original conversation title"}</output>
      {recovery && <button type="button" disabled={!history.hasMoreBefore || history.loadingOlder}
        onClick={() => { void loadOlder(); }}>Load older messages</button>}
      <div className="flex-1" role="list" aria-label="Conversation">
        <ThreadMessages messages={displayed} isStreaming={isStreaming} />
      </div>
      <form className="flex items-center gap-2 bg-background py-4" onSubmit={(event) => { event.preventDefault(); if (send(question)) setQuestion(""); }}>
        <input className="h-12 min-w-0 flex-1 rounded-control border border-input bg-background px-4 text-reading-small" aria-label="Question" value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button className="h-10 rounded-control bg-primary px-4 text-reading-small text-primary-foreground disabled:opacity-50" disabled={isStreaming}>Ask</button>
      </form>
    </main>
  </OpenUIChatProvider>;
}
function RecoveryConversations({ client }: { client: NanobotClient }) {
  const [selected, setSelected] = useState("recovery-reconnect");
  const [status, setStatus] = useState(client.status);
  useEffect(() => client.onStatus(setStatus), [client]);
  return <><nav aria-label="Recovery fixture">
    <select aria-label="Conversation" value={selected} onChange={(event) => {
      client.attach(event.target.value);
      setSelected(event.target.value);
    }}>
      {["recovery-reconnect", "recovery-switch-a", "recovery-switch-b", "recovery-history"].map((id) => <option key={id}>{id}</option>)}
    </select><output aria-label="Connection status">{status}</output>
  </nav><Thread key={selected} client={client} chatId={selected} recovery /></>;
}
function NewConversation({ client }: { client: NanobotClient }) {
  useReadingTypography();
  const [session, setSession] = useState<ChatSummary | null>(null);
  return <div className="flex flex-col" style={{ height: "100dvh" }}><ThreadShell session={session} title="Nanobot" onToggleSidebar={() => {}}
    onCreateChat={async () => {
      const id = await client.newChat();
      setSession({ key: `websocket:${id}`, channel: "websocket", chatId: id,
        createdAt: null, updatedAt: null, preview: "" });
      return id;
    }} /></div>;
}
async function start() {
  await initializeI18n();
  const bootstrap = await fetchBootstrap();
  const url = new URL(deriveWsUrl(bootstrap.ws_path, bootstrap.token, bootstrap.ws_url));
  const clientId = `openui-browser-acceptance-${crypto.randomUUID()}`;
  url.searchParams.set("client_id", clientId);
  const client = new NanobotClient({ url: url.toString(), reconnect: true, onReauth: async () => {
    const refreshed = await fetchBootstrap();
    const next = new URL(deriveWsUrl(refreshed.ws_path, refreshed.token, refreshed.ws_url));
    next.searchParams.set("client_id", clientId);
    return next.toString();
  } });
  client.attach(chatId);
  client.connect();
  createRoot(document.getElementById("root")!).render(
    <ClientProvider client={client} token={bootstrap.api_token ?? ""} allowUpdateFlow={false}>
      <TooltipProvider>{new URLSearchParams(location.search).has("recovery") ? <RecoveryConversations client={client} />
        : new URLSearchParams(location.search).has("new") ? <NewConversation client={client} /> : <Thread client={client} />}</TooltipProvider>
    </ClientProvider>);
}
void start();
