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
    <main className="mx-auto max-w-3xl p-6">
      <h1>OpenUI Gateway acceptance</h1>
      <OpenUIControls />
      <form onSubmit={(event) => { event.preventDefault(); send(question); }}>
        <input aria-label="Question" value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button disabled={isStreaming}>Ask</button>
      </form>
      <ol aria-label="Conversation">{messages.map((message) => <li key={message.id}>
        <MessageBubble message={message} />
      </li>)}</ol>
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
