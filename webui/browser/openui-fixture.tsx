import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenUIPocBlock } from "../src/openui/OpenUIPocBlock";
import { inspectIntent, POC_LIBRARY_ID } from "../src/openui/poc-library";
import { acceptSnapshot, applyDelta, uiSnapshotSchema, type UiSnapshot } from "../src/openui/snapshot";
import { useNanobotStream } from "../src/hooks/useNanobotStream";
import { ClientProvider } from "../src/providers/ClientProvider";
import { NanobotClient } from "../src/lib/nanobot-client";

// Test-only storage/transport adapters. Production needs authenticated snapshot
// APIs, capability negotiation and structured action admission before wiring.
const storageKey = "openui-poc-snapshot";
const initial: UiSnapshot = {
  schema_version: 1, chat_id: "openui-poc", session_generation: "fixture-generation",
  turn_id: "fixture-turn", block_id: "fixture-block", revision: 1, seq: 0,
  library_hash: POC_LIBRARY_ID, status: "streaming", source: "", state: {}, state_version: 0,
};
const chunks = [
  '$period = "7"\nroot = Panel([heading, period, inspect])\nheading = Text("Task 08 is ready")\n',
  'period = Period($period)\ninspect = Inspect($period)\n',
];
const client = new NanobotClient({ url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/openui-poc-socket`, reconnect: false });

function Fixture() {
  const [snapshot, setSnapshot] = useState<UiSnapshot>(() => {
    const saved = localStorage.getItem(storageKey);
    return saved ? acceptSnapshot(null, JSON.parse(saved), initial) ?? initial : initial;
  });
  const { send, messages } = useNanobotStream(initial.chat_id);
  useEffect(() => { client.connect(); return () => client.close(); }, []);

  function save(next: UiSnapshot) {
    localStorage.setItem(storageKey, JSON.stringify(next));
    setSnapshot(next);
  }
  function advance() {
    if (snapshot.seq < chunks.length) {
      save(applyDelta(snapshot, {
        chat_id: snapshot.chat_id, session_generation: snapshot.session_generation,
        block_id: snapshot.block_id, revision: snapshot.revision, seq: snapshot.seq + 1,
        delta: chunks[snapshot.seq],
      }).snapshot);
    } else {
      save({ ...snapshot, seq: snapshot.seq + 1, status: "complete" });
    }
  }

  return <main>
    <h1>OpenUI P0 fixture</h1>
    <p>SDK rendering with a test-only snapshot adapter; actions use the existing chat sender.</p>
    <button onClick={advance} disabled={snapshot.status !== "streaming"}>Advance stream</button>
    <button onClick={() => save({ ...initial, revision: snapshot.revision + 1, seq: 1, source: "root = UnknownComponent()", status: "complete" })}>Invalid source</button>
    <output aria-label="Block status">{snapshot.status}</output>
    <OpenUIPocBlock snapshot={snapshot} fallbackText="Task 08 is ready (text fallback)."
      onAction={(event) => {
        const intent = inspectIntent(event);
        if (intent) void send(intent);
      }}
      onStateUpdate={(state) => {
        const next = uiSnapshotSchema.safeParse({ ...snapshot, state, state_version: snapshot.state_version + 1 });
        if (next.success && JSON.stringify(next.data.state) !== JSON.stringify(snapshot.state)) save(next.data);
      }} />
    <ol aria-label="Conversation">{messages.map((message) => <li key={message.id}>{message.content}</li>)}</ol>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <ClientProvider client={client} token="fixture" allowUpdateFlow={false}><Fixture /></ClientProvider>,
);
