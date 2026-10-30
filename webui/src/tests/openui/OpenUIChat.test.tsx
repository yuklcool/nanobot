import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import manifest from "../../../../nanobot/openui/generated/chat-library.json";
import { NanobotClient } from "../../lib/nanobot-client";
import { ClientProvider } from "../../providers/ClientProvider";
import { useNanobotStream } from "../../hooks/useNanobotStream";
import { OpenUIChatProvider, OpenUIControls, OpenUIMessage } from "../../openui/OpenUIChat";
import type { UiSnapshot } from "../../openui/snapshot";
import type { UIMessage } from "../../lib/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const message: UIMessage = { id: "answer", role: "assistant", content: "Lookup result 1", createdAt: 1,
  turnId: "turn-1", turnSeq: 7, turnPhase: "answer" };
const initial: UiSnapshot = {
  schema_version: 1, chat_id: "chat", session_generation: "generation", turn_id: "turn-1", anchor_seq: 7,
  block_id: "block", revision: 1, seq: 3, status: "complete", library_hash: manifest.library_hash,
  source: '$question = ""\nroot = Panel([heading, followup])\nheading = Text("Lookup result 1")\nfollowup = Followup($question)\n',
  state: { $question: "Look up again" }, state_version: 1,
};

function setup(capability: unknown = { protocol: 1, library_hash: manifest.library_hash }, seed = [message]) {
  const frames: Record<string, unknown>[] = [];
  let saved = { ...initial };
  const socket = { readyState: 1, onopen: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null, close() {},
    send(raw: string) {
      const frame = JSON.parse(raw); frames.push(frame);
      queueMicrotask(() => {
        if (frame.type === "webui_request") {
          if (frame.action === "openui.state") saved = { ...saved, state: { $question: frame.payload.question }, state_version: saved.state_version + 1 };
          socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: true, request_id: frame.request_id,
            result: frame.action === "openui.state" ? { snapshot: saved }
              : { capability, session_generation: "generation", blocks: frame.payload.turn_ids?.includes(saved.turn_id) ? [saved] : [] } }) } as MessageEvent);
        }
        if (frame.type === "message") socket.onmessage?.({ data: JSON.stringify({ event: "message_accepted",
          chat_id: frame.chat_id, turn_id: frame.turn_id, starts_turn: true }) } as MessageEvent);
      });
    },
  };
  const client = new NanobotClient({ url: "ws://fixture", reconnect: false, socketFactory: () => socket as unknown as WebSocket });
  client.connect(); socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ event: "ready", chat_id: "chat", client_id: "browser", openui: capability }) } as MessageEvent);
  function Thread() {
    const { send, messages } = useNanobotStream("chat", seed);
    return <OpenUIChatProvider client={client} chatId="chat" messages={messages} send={send}>
      <OpenUIControls />
      <OpenUIMessage message={message} />
      <OpenUIMessage message={{ ...message, turnSeq: 6, id: "wrong-anchor" }} />
      <ol aria-label="Conversation">{messages.map((row) => <li key={row.id}>{row.content}</li>)}</ol>
    </OpenUIChatProvider>;
  }
  const mount = () => render(<ClientProvider client={client} token="test" allowUpdateFlow={false}><Thread /></ClientProvider>);
  return { client, frames, socket, mount };
}

it("restores only the canonical anchor, saves drafts explicitly and sends one structured same-session turn", async () => {
  const fixture = setup();
  const view = fixture.mount();
  try {
    const input = await screen.findByRole("textbox", { name: "openui.followup" });
    expect(input).toHaveValue("Look up again");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "Inspect updated result" } });
    expect(fixture.frames.filter((frame) => frame.action === "openui.state")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "openui.saveDraft" }));
    await screen.findByText("openui.saved");
    expect(fixture.frames.find((frame) => frame.action === "openui.state")).toMatchObject({ payload: {
      chat_id: "chat", question: "Inspect updated result", expected_state_version: 1,
    } });
    fireEvent.click(screen.getByRole("checkbox"));
    const submit = screen.getByRole("button", { name: "openui.submit" });
    fireEvent.click(submit); fireEvent.click(submit);
    await screen.findByText("openui.submitted");
    const sent = fixture.frames.filter((frame) => frame.type === "message");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: "chat", content: "Inspect updated result", ui_mode: "openui", ui_action: {
      block_id: "block", action_id: "conversation.followup", session_generation: "generation", request_id: sent[0].turn_id,
    } });
    expect(screen.getByRole("list", { name: "Conversation" })).toHaveTextContent("Inspect updated result");
    view.unmount();
    fixture.mount();
    expect(await screen.findByRole("textbox")).toHaveValue("Inspect updated result");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(1);
  } finally { cleanup(); fixture.client.close(); }
});

it("does not request OpenUI from an older host and rejects another generation", async () => {
  const old = setup(null); const view = old.mount();
  await act(async () => {});
  expect(old.frames.filter((frame) => frame.action === "openui.subscribe")).toHaveLength(0);
  expect(screen.queryByRole("checkbox")).toBeNull();
  view.unmount(); old.client.close();
  const current = setup(); current.mount();
  try {
    await screen.findByRole("textbox");
    act(() => current.socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat",
      snapshot: { ...initial, session_generation: "foreign", seq: 10, source: 'root = Text("foreign")' } }) } as MessageEvent));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Look up again"));
    expect(screen.queryByText("foreign")).toBeNull();
  } finally { cleanup(); current.client.close(); }
});

it("restores loaded history in bounded batches including turns older than the latest hundred", async () => {
  const seed: UIMessage[] = [message, ...Array.from({ length: 101 }, (_, index): UIMessage => ({
    id: `history-${index}`, turnId: `history-turn-${index}`, role: "user", content: "History", createdAt: index + 2,
  }))];
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash }, seed);
  const view = fixture.mount();
  try {
    await screen.findByRole("textbox");
    await waitFor(() => expect(fixture.frames.filter((frame) => frame.action === "openui.subscribe")).toHaveLength(2));
    const requests = fixture.frames.filter((frame) => frame.action === "openui.subscribe");
    expect(requests.map((frame) => (frame.payload as { turn_ids: string[] }).turn_ids.length)).toEqual([100, 2]);
    expect(screen.getByRole("textbox")).toHaveValue("Look up again");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
  } finally { view.unmount(); fixture.client.close(); }
});
