import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ClientProvider } from "../src/providers/ClientProvider";
import { NanobotClient } from "../src/lib/nanobot-client";
import { useNanobotStream } from "../src/hooks/useNanobotStream";
import { MessageBubble } from "../src/components/MessageBubble";
import { OpenUIChatProvider, OpenUIControls } from "../src/openui/OpenUIChat";
import { initializeI18n } from "../src/i18n";
import "../src/globals.css";

const chatId = "gateway-poc";
function Thread({ client }: { client: NanobotClient }) {
  const [question, setQuestion] = useState("Lookup");
  const { messages, send, isStreaming } = useNanobotStream(chatId, undefined, false, undefined, undefined, undefined,
    { key: `websocket:${chatId}` });
  return <OpenUIChatProvider client={client} chatId={chatId} messages={messages} send={send}>
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-5">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
      <h1 className="text-title font-medium">Nanobot</h1>
      <OpenUIControls />
      <button type="button" className="text-caption text-muted-foreground hover:text-foreground" onClick={async () => {
        await client.requestMutation("session.delete", { key: `websocket:${chatId}` });
        location.reload();
      }}>Delete conversation</button></header>
      <ol className="flex flex-1 flex-col gap-8" aria-label="Conversation">{messages.map((message) => <li key={message.id}>
        <MessageBubble message={message} />
      </li>)}</ol>
      <form className="sticky bottom-0 flex items-center gap-2 bg-background py-4" onSubmit={(event) => { event.preventDefault(); send(question); }}>
        <input className="h-12 min-w-0 flex-1 rounded-control border border-input bg-background px-4 text-reading-small" aria-label="Question" value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button className="h-10 rounded-control bg-primary px-4 text-reading-small text-primary-foreground disabled:opacity-50" disabled={isStreaming}>Ask</button>
      </form>
    </main>
  </OpenUIChatProvider>;
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
      <Thread client={client} />
    </ClientProvider>);
}
void start();
