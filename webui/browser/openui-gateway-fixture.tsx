import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ClientProvider } from "../src/providers/ClientProvider";
import { NanobotClient } from "../src/lib/nanobot-client";
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
function Thread({ client }: { client: NanobotClient }) {
  useReadingTypography();
  const sidebar = useSidebarState([], false);
  const [question, setQuestion] = useState("Lookup");
  const { messages, send, isStreaming } = useNanobotStream(chatId, undefined, false, undefined, undefined, undefined,
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
  const bootstrap = await (await fetch("/webui/bootstrap")).json();
  const url = new URL(bootstrap.ws_url);
  url.searchParams.set("token", bootstrap.token);
  url.searchParams.set("client_id", "openui-browser-acceptance");
  const client = new NanobotClient({ url: url.toString(), reconnect: true });
  client.attach(chatId);
  client.connect();
  createRoot(document.getElementById("root")!).render(
    <ClientProvider client={client} token={bootstrap.api_token} allowUpdateFlow={false}>
      <TooltipProvider>{new URLSearchParams(location.search).has("new")
        ? <NewConversation client={client} /> : <Thread client={client} />}</TooltipProvider>
    </ClientProvider>);
}
void start();
