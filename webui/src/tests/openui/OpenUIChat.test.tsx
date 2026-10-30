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

function setup(capability: unknown = { protocol: 1, library_hash: manifest.library_hash }, seed = [message], snapshot = initial) {
  const frames: Record<string, unknown>[] = [];
  let saved = { ...snapshot };
  const socket = { readyState: 1, onopen: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null, close() {},
    send(raw: string) {
      const frame = JSON.parse(raw); frames.push(frame);
      queueMicrotask(() => {
        if (frame.type === "webui_request") {
          if (frame.action === "openui.state") saved = { ...saved, state: { $question: frame.payload.question }, state_version: saved.state_version + 1 };
          socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: true, request_id: frame.request_id,
            result: frame.action === "openui.prepare_record" ? { content: "Analyze captured record" }
              : frame.action === "openui.state" ? { snapshot: saved }
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
    fireEvent.change(screen.getByRole("combobox", { name: "openui.enable" }), { target: { value: "openui" } });
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
  expect(screen.queryByRole("combobox", { name: "openui.enable" })).toBeNull();
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

it("negotiates auto mode and clears it when reconnecting to a host without it", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, modes: ["markdown", "openui", "auto"] });
  const view = fixture.mount();
  try {
    const select = await screen.findByRole("combobox", { name: "openui.enable" });
    await screen.findByRole("option", { name: "openui.modeAuto" });
    expect(select).toHaveValue("markdown");
    fireEvent.change(select, { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: "openui.submit" }));
    await screen.findByText("openui.submitted");
    expect(fixture.frames.find((frame) => frame.type === "message")).toMatchObject({ ui_mode: "auto" });
    act(() => fixture.socket.onclose?.());
    act(() => {
      fixture.client.connect();
      fixture.socket.onopen?.();
      fixture.socket.onmessage?.({ data: JSON.stringify({ event: "ready", chat_id: "chat", client_id: "browser",
        openui: { protocol: 1, library_hash: manifest.library_hash } }) } as MessageEvent);
    });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "openui.enable" })).toHaveValue("markdown"));
    expect(screen.queryByRole("option", { name: "openui.modeAuto" })).toBeNull();
    expect(() => fixture.client.setOpenUIMode("chat", "auto")).toThrow("UI_MODE_UNSUPPORTED");
  } finally { view.unmount(); fixture.client.close(); }
});

it("sends a contextual choice as one same-session reply, without sending on restore", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash }, [message], {
    ...initial, source: 'root = Panel([next])\nnext = Choices("How should we continue?", [{label: "Review the plan", question: "Review the proposed plan"}, {label: "Adjust the scope", question: "I want to adjust the scope first"}])\n',
  });
  const view = fixture.mount();
  try {
    const choice = await screen.findByRole("button", { name: "Review the plan" });
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    fireEvent.click(choice); fireEvent.click(choice);
    await screen.findByText("openui.submitted");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toEqual([
      expect.objectContaining({ chat_id: "chat", content: "Review the proposed plan", ui_action: expect.objectContaining({
        block_id: "block", action_id: "conversation.followup", session_generation: "generation",
      }) }),
    ]);
    expect(screen.getByRole("list", { name: "Conversation" })).toHaveTextContent("Review the proposed plan");
  } finally { view.unmount(); fixture.client.close(); }
});

it("collects the requested details before sending a form through the existing conversation", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash }, [message], {
    ...initial, source: 'root = Panel([details])\ndetails = Form("Prepare the project", [{label: "Project name", placeholder: "Enter a name"}, {label: "Priority", options: ["Normal", "High"]}])\n',
  });
  const view = fixture.mount();
  try {
    const name = await screen.findByRole("textbox", { name: "Project name" });
    const submit = screen.getByRole("button", { name: "openui.submit" });
    expect(submit).toBeDisabled();
    fireEvent.change(name, { target: { value: "  Nanobot  " } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "High" } });
    expect(submit).toBeEnabled();
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    fireEvent.submit(screen.getByRole("form", { name: "Prepare the project" }));
    await screen.findByText("openui.submitted");
    expect(fixture.frames.find((frame) => frame.type === "message")).toMatchObject({
      chat_id: "chat", content: "Prepare the project\nProject name: Nanobot\nPriority: High",
      ui_action: { action_id: "conversation.followup", block_id: "block" },
    });
  } finally { view.unmount(); fixture.client.close(); }
});

it("keeps streamed choices disabled until the view is complete", async () => {
  const snapshot = { ...initial, status: "streaming" as const,
    source: 'root = Panel([next])\nnext = Choices("Continue?", [{label: "Confirm", question: "Confirm the plan"}, {label: "Revise", question: "Revise the plan"}])\n' };
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash }, [message], snapshot);
  const view = fixture.mount();
  try {
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    act(() => fixture.socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat",
      snapshot: { ...snapshot, seq: snapshot.seq + 1, status: "complete" } }) } as MessageEvent));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await screen.findByText("openui.submitted");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(1);
  } finally { view.unmount(); fixture.client.close(); }
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

it("filters locally and distinguishes scoped record actions even when summaries match", async () => {
  const table = { data_ref: "data_1", title: "Captured tasks", columns: { name: "Task", energy: "Energy", status: "Status" },
    rows: [{ id: "task_08", values: { name: "Task 08", energy: 5412.5, status: "ready" } },
      { id: "task_09", values: { name: "Task 09", energy: 0, status: "pending" } }],
    source_tool: "lookup", source_call_id: "call_1", captured_at: 1700000000, total_rows: 2 };
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash }, [message], {
    ...initial, tables: { data_1: table }, source: initial.source.replace("[heading, followup]", "[heading, dataTable, followup]")
      + 'dataTable = DataTable("data_1")\n',
  });
  const view = fixture.mount();
  try {
    expect(await screen.findByRole("table")).toHaveTextContent("5412.5");
    fireEvent.change(screen.getByRole("textbox", { name: "openui.filterRecords" }), { target: { value: "pending" } });
    expect(screen.getByRole("table")).not.toHaveTextContent("Task 08");
    expect(screen.getByRole("table")).toHaveTextContent("Task 09");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    expect(fixture.frames.filter((frame) => frame.action === "openui.prepare_record")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "openui.analyzeRecord" }));
    await screen.findByText("openui.submitted");
    expect(fixture.frames.find((frame) => frame.type === "message")).toMatchObject({
      content: "Analyze captured record", chat_id: "chat", ui_action: {
        action_id: "record.analyze", data_ref: "data_1", record_id: "task_09", block_id: "block",
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "openui.filterRecords" }), { target: { value: "ready" } });
    fireEvent.click(screen.getByRole("button", { name: "openui.analyzeRecord" }));
    await screen.findByText("openui.submitted");
    const sent = fixture.frames.filter((frame) => frame.type === "message");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ content: sent[0].content, ui_action: { record_id: "task_08" } });
    expect(sent[1].turn_id).not.toBe(sent[0].turn_id);
    fireEvent.click(screen.getByRole("button", { name: "openui.analyzeRecord" }));
    await screen.findByText("openui.submitted");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(2);
  } finally { view.unmount(); fixture.client.close(); }
});


it("drops cached views on disconnect and requires fresh host capability before restoring", async () => {
  const fixture = setup(); const view = fixture.mount();
  try {
    await screen.findByRole("textbox");
    const before = fixture.frames.filter((frame) => frame.action === "openui.subscribe").length;
    act(() => fixture.socket.onclose?.());
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    act(() => {
      fixture.client.connect();
      fixture.socket.onopen?.();
      fixture.socket.onmessage?.({ data: JSON.stringify({ event: "ready", chat_id: "chat", client_id: "browser" }) } as MessageEvent);
      fixture.socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat", snapshot: initial }) } as MessageEvent);
    });
    await act(async () => {});
    expect(screen.queryByRole("combobox", { name: "openui.enable" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fixture.frames.filter((frame) => frame.action === "openui.subscribe")).toHaveLength(before);
    expect(screen.getByRole("list", { name: "Conversation" })).toHaveTextContent("Lookup result 1");
  } finally { view.unmount(); fixture.client.close(); }
});

it("isolates views when two hosts share the same chat and generation identifiers", async () => {
  const first = setup();
  const second = setup({ protocol: 1, library_hash: manifest.library_hash }, [message], {
    ...initial, state: { $question: "Second host draft" },
  });
  function Host({ client }: { client: NanobotClient }) {
    return <OpenUIChatProvider client={client} chatId="chat" messages={[message]} send={() => null}>
      <OpenUIControls /><OpenUIMessage message={message} />
    </OpenUIChatProvider>;
  }
  const view = render(<Host client={first.client} />);
  try {
    expect(await screen.findByRole("textbox")).toHaveValue("Look up again");
    view.rerender(<Host client={second.client} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Second host draft"));
    act(() => first.socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat",
      snapshot: { ...initial, state_version: 2, state: { $question: "Late first host" } } }) } as MessageEvent));
    expect(screen.getByRole("textbox")).toHaveValue("Second host draft");
  } finally { view.unmount(); first.client.close(); second.client.close(); }
});
