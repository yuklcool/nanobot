import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import manifest from "../../../../nanobot/openui/generated/chat-library.json";
import { NanobotClient } from "../../lib/nanobot-client";
import { ClientProvider } from "../../providers/ClientProvider";
import { useNanobotStream } from "../../hooks/useNanobotStream";
import { OpenUIChatProvider, OpenUIControls, OpenUIMessage } from "../../openui/OpenUIChat";
import type { UiSnapshot } from "../../openui/snapshot";
import type { UIMessage } from "../../lib/types";
import { emptyFormValue, type FormInput } from "../../openui/form-contract";

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

function setup(capability: unknown = { protocol: 1, library_hash: manifest.library_hash }, seed = [message], snapshot = initial,
  chatId: string | null = "chat", disabled = false) {
  const frames: Record<string, unknown>[] = [];
  const failures = { save: false, send: false, query: false, renameConfirm: false };
  let saved = { ...snapshot };
  const socket = { readyState: 1, onopen: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null, close() {},
    send(raw: string) {
      const frame = JSON.parse(raw); frames.push(frame);
      queueMicrotask(() => {
        if (frame.type === "webui_request") {
          if (frame.action === "openui.rename") {
            const entries = (saved.state.$renames ?? {}) as Record<string, Record<string, unknown>>;
            const form = frame.payload.form_id;
            if (frame.payload.operation !== "status") saved = { ...saved, state_version: saved.state_version + 1,
              state: { ...saved.state, $renames: { ...entries, [form]: frame.payload.operation === "prepare"
                ? { operation_id: "a".repeat(32), title: frame.payload.title, previous_title: "Before",
                  expected_revision: "b".repeat(64), status: "prepared" }
                : { ...entries[form], status: "applied" } } } } as UiSnapshot;
            if (frame.payload.operation === "confirm" && failures.renameConfirm) {
              failures.renameConfirm = false;
              socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: false, request_id: frame.request_id,
                status: 503, message: "Receipt unavailable" }) } as MessageEvent);
              return;
            }
            socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: true, request_id: frame.request_id,
              result: { snapshot: saved } }) } as MessageEvent);
            return;
          }
          if (frame.action === "openui.query") {
            if (failures.query) {
              failures.query = false;
              socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: false,
                request_id: frame.request_id, error: { status: 409, message: "UI_QUERY_UNAVAILABLE" } }) } as MessageEvent);
              return;
            }
            if (frame.payload.operation === "refresh") saved = { ...saved, seq: saved.seq + 1,
              tables: Object.fromEntries(Object.entries(saved.tables ?? {}).map(([key, table]) => [key,
                { ...table, captured_at: table.captured_at + 1, rows: [], total_rows: 0 }])) };
            socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: true, request_id: frame.request_id,
              result: frame.payload.operation === "refresh" ? { snapshot: saved }
                : { detail: { title: "Planning notes", messages: [{ role: "user", content: '<img src=x onerror="alert(1)">' }] } },
            }) } as MessageEvent);
            return;
          }
          if (frame.action === "openui.form" && failures.save) {
            failures.save = false;
            socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: false, request_id: frame.request_id,
              status: 409, message: "UI_BUSY" }) } as MessageEvent);
            return;
          }
          if (frame.action === "openui.state") saved = { ...saved, state: { ...saved.state, $question: frame.payload.question }, state_version: saved.state_version + 1 };
          if (frame.action === "openui.form") {
            const form: FormInput = frame.payload.form;
            const forms = (saved.state.$forms ?? {}) as Record<string, Record<string, unknown>>;
            const previous = forms[form.form_id];
            if (!previous?.request_id) saved = { ...saved, state_version: saved.state_version + 1,
              state: { ...saved.state, $forms: { ...forms, [form.form_id]: {
                schema: "test", values: form.values.map((value, index) => form.fields[index].persist ? value : emptyFormValue(form.fields[index])),
                status: form.submit ? "prepared" : "draft", ...(form.submit ? { request_id: "form-request-1" } : {}),
              } } } } as UiSnapshot;
          }
          socket.onmessage?.({ data: JSON.stringify({ event: "webui_response", ok: true, request_id: frame.request_id,
            result: frame.action === "openui.prepare_record" ? { content: "Analyze captured record" }
              : frame.action === "openui.state" || frame.action === "openui.form" ? { snapshot: saved }
              : { capability, session_generation: "generation", blocks: frame.payload.turn_ids?.includes(saved.turn_id) ? [saved] : [] } }) } as MessageEvent);
        }
        if (frame.type === "message") {
          if (failures.send) {
            failures.send = false;
            socket.onmessage?.({ data: JSON.stringify({ event: "error", detail: "UI_BUSY", chat_id: frame.chat_id,
              turn_id: frame.turn_id }) } as MessageEvent);
            return;
          }
          if (frame.ui_action?.form_id) {
            const forms = saved.state.$forms as Record<string, Record<string, unknown>>;
            saved = { ...saved, state_version: saved.state_version + 1, state: { ...saved.state,
              $forms: { ...forms, [frame.ui_action.form_id]: { ...forms[frame.ui_action.form_id], status: "submitted" } },
            } } as UiSnapshot;
            socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat", snapshot: saved }) } as MessageEvent);
          }
          socket.onmessage?.({ data: JSON.stringify({ event: "message_accepted",
            chat_id: frame.chat_id, turn_id: frame.turn_id, starts_turn: true }) } as MessageEvent);
        }
      });
    },
  };
  const client = new NanobotClient({ url: "ws://fixture", reconnect: false, socketFactory: () => socket as unknown as WebSocket });
  client.connect(); socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ event: "ready", chat_id: "chat", client_id: "browser", openui: capability }) } as MessageEvent);
  function Thread() {
    const { send, messages } = useNanobotStream(chatId, seed);
    return <OpenUIChatProvider client={client} chatId={chatId} disabled={disabled} messages={messages} send={send}>
      <OpenUIControls />
      <OpenUIMessage message={message}><p data-testid="native-answer">{message.content}</p></OpenUIMessage>
      <OpenUIMessage message={{ ...message, turnSeq: 6, id: "wrong-anchor" }} />
      <ol aria-label="Conversation">{messages.map((row) => <li key={row.id}>{row.content}</li>)}</ol>
    </OpenUIChatProvider>;
  }
  const mount = () => render(<ClientProvider client={client} token="test" allowUpdateFlow={false}><Thread /></ClientProvider>);
  function receiveSnapshot(next: UiSnapshot) {
    saved = next;
    socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: next.chat_id, snapshot: next }) } as MessageEvent);
  }
  return { client, frames, socket, mount, failures, receiveSnapshot };
}

it("reviews and confirms a title edit, restores its receipt, and never sends an Agent message", async () => {
  const snapshot = { ...initial, state: {}, source: 'root = Panel([rename])\nrename = Form("Rename conversation", [{label:"New title",type:"text"}], "", "inline", {type:"session.rename",title:"Project plan"})\n' };
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, session_rename: true }, [message], snapshot);
  let view = fixture.mount();
  const input = await screen.findByRole("textbox", { name: "New title" });
  await waitFor(() => expect(screen.getByRole("button", { name: "openui.renameReview" })).toBeEnabled());
  expect(input).toHaveValue("Project plan");
  expect(fixture.frames.filter((frame) => frame.action === "openui.rename")).toHaveLength(0);
  fireEvent.change(input, { target: { value: "Revised plan" } });
  fireEvent.click(screen.getByRole("button", { name: "openui.renameReview" }));
  const confirm = await screen.findByRole("button", { name: "openui.renameConfirm" });
  expect(fixture.frames.find((frame) => frame.action === "openui.rename")).toMatchObject({
    payload: { operation: "prepare", title: "Revised plan", form_id: "form-0", chat_id: "chat" },
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await screen.findByText("openui.renameApplied");
  expect(fixture.frames.filter((frame) => frame.action === "openui.rename" && (frame.payload as Record<string, unknown>).operation === "confirm")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "openui.renameStatus" }));
  await waitFor(() => expect(fixture.frames.filter((frame) => frame.action === "openui.rename")).toHaveLength(3));
  view.unmount();
  view = fixture.mount();
  await screen.findByText("openui.renameApplied");
  expect(screen.getByRole("textbox", { name: "New title" })).toHaveValue("Revised plan");
  expect(fixture.frames.filter((frame) => frame.action === "openui.rename")).toHaveLength(3);
  expect(fixture.frames.filter((frame) => frame.type === "message" || frame.action === "openui.form")).toHaveLength(0);
  view.unmount();

  const old = setup({ protocol: 1, library_hash: manifest.library_hash }, [message], snapshot);
  old.mount();
  await screen.findByText("openui.renameUnavailable");
  expect(screen.getByRole("button", { name: "openui.renameReview" })).toBeDisabled();
  expect(old.frames.filter((frame) => frame.action === "openui.rename")).toHaveLength(0);
});

it("queries a lost rename receipt instead of submitting the write again", async () => {
  const snapshot = { ...initial, state: {}, source: 'root = Panel([rename])\nrename = Form("Rename conversation", [{label:"New title"}], "", "inline", {type:"session.rename",title:"Plan"})\n' };
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, session_rename: true }, [message], snapshot);
  fixture.failures.renameConfirm = true;
  fixture.mount();
  await waitFor(() => expect(screen.getByRole("button", { name: "openui.renameReview" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "openui.renameReview" }));
  fireEvent.click(await screen.findByRole("button", { name: "openui.renameConfirm" }));
  await screen.findByText("openui.renameUncertain");
  expect(screen.getByRole("textbox", { name: "New title" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "openui.renameConfirm" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "openui.renameStatus" }));
  await screen.findByText("openui.renameApplied");
  expect(fixture.frames.filter((frame) => frame.action === "openui.rename" && (frame.payload as Record<string, unknown>).operation === "confirm")).toHaveLength(1);
});

it("shows modes on the blank new-chat page without creating a session and hides them for private chats", async () => {
  const capability = { protocol: 1, library_hash: manifest.library_hash, modes: ["markdown", "openui", "auto"] };
  const draft = setup(capability, [], initial, null);
  const view = draft.mount();
  try {
    const mode = await screen.findByRole("combobox", { name: "openui.enable" });
    expect(mode).toHaveValue("markdown");
    fireEvent.change(mode, { target: { value: "auto" } });
    expect(draft.client.getOpenUIMode(null)).toBe("auto");
    expect(draft.frames).toHaveLength(0);
  } finally { view.unmount(); draft.client.close(); }
  expect(draft.client.getOpenUIMode(null)).toBe("markdown");
  const privateChat = setup(capability, [], initial, null, true);
  const hidden = privateChat.mount();
  try {
    await act(async () => {});
    expect(screen.queryByRole("combobox", { name: "openui.enable" })).toBeNull();
    expect(privateChat.frames).toHaveLength(0);
  } finally { hidden.unmount(); privateChat.client.close(); }
});

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

const querySnapshot: UiSnapshot = { ...initial, source: 'root = Panel([data])\ndata = DataTable("data-1")\n',
    tables: { "data-1": { data_ref: "data-1", title: "Sessions", columns: { title: "Title" },
      rows: [{ id: "websocket:planning", values: { title: "Planning notes" } }], captured_at: 1,
      source_tool: "search_sessions", source_call_id: "search-1", session_query: { query: "planning", exclude_session_key: "websocket:chat" } } } };

const replacingQuery: UiSnapshot = { ...querySnapshot,
  source: 'root = Panel([note, data], "replace")\nnote = Text("Only visible saved conversations are included.")\ndata = DataTable("data-1")\n',
};
it("replaces a result presentation only after completion and retains the original through an empty refresh", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, readonly_query: true }, [message], replacingQuery);
  const view = fixture.mount();
  try {
    await screen.findByRole("table");
    expect(screen.getByTestId("native-answer").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Only visible saved conversations are included.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "openui.refreshData" }));
    await screen.findByText("openui.emptyData");
    expect(screen.getByTestId("native-answer").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByRole("table")).toBeNull();
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
  } finally { view.unmount(); fixture.client.close(); }
});

it.each([
  { ...replacingQuery, status: "streaming" as const },
  { ...replacingQuery, status: "failed" as const },
  { ...replacingQuery, source: replacingQuery.source.replace('DataTable("data-1")', 'DataTable("unknown-data")') },
  { ...initial, status: "streaming" as const, source: 'root = Panel([Text("No relevant content.")], "replace")' },
  { ...initial, status: "failed" as const, source: 'root = Panel([Text("No relevant content.")], "replace")' },
  { ...initial, source: 'root = Panel([Text("   ")], "replace")' },
])("preserves the visible original when a replacement is unfinished, failed, empty or unauthorized: $status", async (snapshot) => {
  const fixture = setup(undefined, [message], snapshot);
  const view = fixture.mount();
  try {
    await screen.findByRole("combobox", { name: "openui.enable" });
    expect(screen.getByTestId("native-answer").closest("details")).toBeNull();
    expect(screen.getByTestId("native-answer")).toBeVisible();
  } finally { view.unmount(); fixture.client.close(); }
});

it("replaces an irrelevant candidate list with its explanation while retaining the complete original", async () => {
  const snapshot = { ...initial, source: 'root = Panel([note], "replace")\nnote = Text("The matched conversation only contains a lookup request, with no substantive plan.")' };
  const fixture = setup(undefined, [message], snapshot);
  const view = fixture.mount();
  try {
    expect(await screen.findByText("The matched conversation only contains a lookup request, with no substantive plan.")).toBeVisible();
    expect(screen.getByTestId("native-answer").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("openui.originalAnswer"));
    expect(screen.getByTestId("native-answer").closest("details")).toHaveAttribute("open");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
  } finally { view.unmount(); fixture.client.close(); }
});

it("renders an empty captured dataset as a compact status without unusable table controls", async () => {
  const fixture = setup(undefined, [message], { ...querySnapshot, tables: { "data-1": {
    ...querySnapshot.tables!["data-1"], rows: [], total_rows: 0, source_tool: "lookup", session_query: null,
  } } });
  const view = fixture.mount();
  try {
    await screen.findByText("openui.emptyData");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("openui.showingRows")).toBeNull();
    expect(fixture.frames.filter((frame) => frame.type === "message" || frame.action === "openui.query")).toHaveLength(0);
  } finally { view.unmount(); fixture.client.close(); }
});

it("queries only on clicks, retries a failed detail read, renders text safely and refreshes in place", async () => {
  const capability = { protocol: 1, library_hash: manifest.library_hash, readonly_query: true };
  const fixture = setup(capability, [message], querySnapshot);
  const view = fixture.mount();
  try {
    const details = await screen.findByRole("button", { name: "openui.viewDetails" });
    expect(fixture.frames.filter((frame) => frame.action === "openui.query")).toHaveLength(0);
    fixture.failures.query = true;
    fireEvent.click(details); fireEvent.click(details);
    await screen.findByRole("alert");
    expect(fixture.frames.filter((frame) => frame.action === "openui.query")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "openui.retryData" }));
    const detail = await screen.findByRole("region", { name: "openui.recordDetails" });
    expect(detail).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(detail.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "openui.refreshData" }));
    await screen.findByText("openui.emptyData");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "openui.filterRecords" })).toBeNull();
    expect(screen.getByRole("button", { name: "openui.refreshData" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "openui.recordDetails" })).toBeNull();
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    view.unmount(); fixture.mount();
    await screen.findByText("openui.emptyData");
    expect(screen.getByRole("button", { name: "openui.refreshData" })).toBeEnabled();
    expect(fixture.frames.filter((frame) => frame.action === "openui.query")).toHaveLength(3);
  } finally { cleanup(); fixture.client.close(); }
  const old = setup({ ...capability, readonly_query: false }, [message], querySnapshot);
  const oldView = old.mount();
  try {
    await screen.findByRole("table", { name: "Sessions" });
    expect(screen.queryByRole("button", { name: "openui.refreshData" })).toBeNull();
    expect(screen.getByRole("button", { name: "openui.analyzeRecord" })).toBeEnabled();
    expect(old.frames.filter((frame) => frame.action === "openui.query")).toHaveLength(0);
  } finally { oldView.unmount(); old.client.close(); }
});

it("allows a new explicit analysis after another tab refreshes the same record", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, readonly_query: true }, [message], querySnapshot);
  const view = fixture.mount();
  try {
    const analyze = await screen.findByRole("button", { name: "openui.analyzeRecord" });
    fireEvent.click(analyze);
    await waitFor(() => expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(1));
    await waitFor(() => expect(analyze).toBeEnabled());
    const table = querySnapshot.tables!["data-1"];
    act(() => fixture.socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat",
      snapshot: { ...querySnapshot, seq: querySnapshot.seq + 1, tables: { "data-1": {
        ...table, captured_at: 2, rows: [{ id: "websocket:planning", values: { title: "Updated planning notes" } }],
      } } },
    }) } as MessageEvent));
    await screen.findByText("Updated planning notes");
    fireEvent.click(analyze);
    await waitFor(() => expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(2));
    await waitFor(() => expect(analyze).toBeEnabled());
    fireEvent.click(analyze);
    await screen.findByText("openui.submitted");
    const sent = fixture.frames.filter((frame) => frame.type === "message");
    expect(sent).toHaveLength(2);
    expect(sent[0].turn_id).not.toBe(sent[1].turn_id);
  } finally { view.unmount(); fixture.client.close(); }
});

const recoverableForm: UiSnapshot = { ...initial,
  source: 'root = Panel([details])\ndetails = Form("Project details", [{label: "Project name", persist: true}, {label: "Priority", options: ["Normal", "High"], persist: true}, {label: "Ephemeral note"}])\n',
};
const savedProjectForm: UiSnapshot = { ...recoverableForm, state_version: 2,
  state: { $forms: { "form-0": { schema: "test", status: "draft", values: ["Original", "Normal", ""] } } },
};
function projectDraft(title: string, stateVersion: number): UiSnapshot {
  return { ...savedProjectForm, state_version: stateVersion,
    state: { $forms: { "form-0": { schema: "test", status: "draft", values: [title, "High", ""] } } } };
}

it("loads another tab's saved fields without writing them back or clearing memory-only input", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], savedProjectForm);
  const view = fixture.mount();
  try {
    expect(await screen.findByRole("textbox", { name: "Project name" })).toHaveValue("Original");
    fireEvent.change(screen.getByRole("textbox", { name: "Ephemeral note" }), { target: { value: "Only this tab" } });
    act(() => fixture.receiveSnapshot(projectDraft("Shared project", 3)));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Shared project"));
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("High");
    expect(screen.getByRole("textbox", { name: "Ephemeral note" })).toHaveValue("Only this tab");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)); });
    expect(fixture.frames.filter((frame) => frame.action === "openui.form")).toHaveLength(0);
  } finally { view.unmount(); fixture.client.close(); }
});

it("preserves conflicting edits until the user loads the latest draft or explicitly saves this tab", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], savedProjectForm);
  const view = fixture.mount();
  try {
    const name = await screen.findByRole("textbox", { name: "Project name" });
    fireEvent.change(screen.getByRole("textbox", { name: "Ephemeral note" }), { target: { value: "Memory only" } });
    fireEvent.change(name, { target: { value: "My unsaved project" } });
    act(() => fixture.receiveSnapshot(projectDraft("Shared project", 3)));
    await screen.findByText("openui.draftConflict");
    expect(name).toHaveValue("My unsaved project");
    expect(screen.getByRole("button", { name: "openui.submit" })).toBeDisabled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)); });
    expect(fixture.frames.filter((frame) => frame.action === "openui.form")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "openui.reloadDraft" }));
    expect(name).toHaveValue("Shared project");
    expect(screen.getByRole("textbox", { name: "Ephemeral note" })).toHaveValue("Memory only");
    fireEvent.change(name, { target: { value: "Keep this project" } });
    act(() => fixture.receiveSnapshot(projectDraft("Newer shared project", 4)));
    await screen.findByText("openui.draftConflict");
    fireEvent.click(screen.getByRole("button", { name: "openui.keepDraft" }));
    await screen.findByText("openui.saved");
    expect(screen.queryByText("openui.draftConflict")).toBeNull();
    expect(fixture.frames.filter((frame) => frame.action === "openui.form")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ expected_state_version: 4,
        form: expect.objectContaining({ submit: false, values: ["Keep this project", "High", ""] }) }) }),
    ]);
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
  } finally { view.unmount(); fixture.client.close(); }
});

it("keeps a newer remote draft when an earlier save receipt arrives late", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], savedProjectForm);
  const view = fixture.mount();
  try {
    const name = await screen.findByRole("textbox", { name: "Project name" });
    const receive = fixture.socket.onmessage!;
    let release: (() => void) | undefined;
    fixture.socket.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.event === "webui_response" && fixture.frames.some((request) =>
        request.action === "openui.form" && request.request_id === frame.request_id)) {
        release = () => receive(event);
      } else receive(event);
    };
    fireEvent.change(name, { target: { value: "My pending draft" } });
    await waitFor(() => expect(release).toBeTypeOf("function"));
    act(() => fixture.receiveSnapshot(projectDraft("Newer shared project", 4)));
    await screen.findByText("openui.draftConflict");
    act(() => release!());
    await screen.findByText("openui.draftFailed");
    expect(name).toHaveValue("My pending draft");
    expect(screen.getByText("openui.draftConflict")).toBeVisible();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)); });
    expect(fixture.frames.filter((frame) => frame.action === "openui.form")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "openui.reloadDraft" }));
    expect(name).toHaveValue("Newer shared project");
  } finally { view.unmount(); fixture.client.close(); }
});

it("rejects a queued draft changed by another tab while allowing an unrelated form's save receipt", async () => {
  const snapshot: UiSnapshot = { ...savedProjectForm,
    source: 'root = Panel([first, second])\nfirst = Form("First", [{label: "First name", persist: true}])\nsecond = Form("Second", [{label: "Second name", persist: true}])\n',
    state: { $forms: {
      "form-0": { schema: "test", status: "draft", values: ["Original first"] },
      "form-1": { schema: "test", status: "draft", values: ["Original second"] },
    } },
  };
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], snapshot);
  const view = fixture.mount();
  try {
    const first = await screen.findByRole("textbox", { name: "First name" });
    const second = screen.getByRole("textbox", { name: "Second name" });
    const receive = fixture.socket.onmessage!;
    let release: (() => void) | undefined;
    fixture.socket.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.event === "webui_response" && fixture.frames.some((request) =>
        request.action === "openui.form" && request.request_id === frame.request_id)) release = () => receive(event);
      else receive(event);
    };
    fireEvent.change(first, { target: { value: "Saved first" } });
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.change(second, { target: { value: "My queued second" } });
    await screen.findByText("openui.savingDraft");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)); });
    act(() => fixture.receiveSnapshot({ ...snapshot, state_version: 4, state: { $forms: {
      "form-0": { schema: "test", status: "draft", values: ["Saved first"] },
      "form-1": { schema: "test", status: "draft", values: ["Shared second"] },
    } } }));
    await screen.findByText("openui.draftConflict");
    act(() => release!());
    await screen.findByText("openui.saved");
    await screen.findByText("openui.draftFailed");
    expect(second).toHaveValue("My queued second");
    expect(fixture.frames.filter((frame) => frame.action === "openui.form")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "openui.reloadDraft" }));
    expect(second).toHaveValue("Shared second");
  } finally { view.unmount(); fixture.client.close(); }
});

it("restores only opted-in form drafts and retains submitted receipts without sending again", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], recoverableForm);
  let view = fixture.mount();
  try {
    fireEvent.change(await screen.findByRole("textbox", { name: "Project name" }), { target: { value: "Nanobot" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "High" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Ephemeral note" }), { target: { value: "Memory only" } });
    await screen.findByText("openui.saved");
    const draft = fixture.frames.find((frame) => frame.action === "openui.form");
    expect(draft).toMatchObject({ payload: { form: { values: ["Nanobot", "High", ""], submit: false } } });
    expect(JSON.stringify(draft)).not.toContain("Memory only");
    view.unmount(); view = fixture.mount();
    expect(await screen.findByRole("textbox", { name: "Project name" })).toHaveValue("Nanobot");
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("High");
    expect(screen.getByRole("textbox", { name: "Ephemeral note" })).toHaveValue("");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox", { name: "Ephemeral note" }), { target: { value: "Send explicitly" } });
    const submit = screen.getByRole("button", { name: "openui.submit" });
    fireEvent.click(submit); fireEvent.click(submit);
    await screen.findByText("openui.submitted");
    expect(submit).toBeDisabled();
    const messages = fixture.frames.filter((frame) => frame.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: "Project details\nProject name: Nanobot\nPriority: High\nEphemeral note: Send explicitly",
      ui_action: { form_id: "form-0", request_id: "form-request-1" } });
    view.unmount(); view = fixture.mount();
    await screen.findByText("openui.submitted");
    expect(screen.getByRole("button", { name: "openui.submit" })).toBeDisabled();
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(1);
  } finally { view.unmount(); fixture.client.close(); }
});

it("retains failed drafts and retries delivery with the original server submission identity", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], recoverableForm);
  fixture.failures.save = true;
  const view = fixture.mount();
  try {
    fireEvent.change(await screen.findByRole("textbox", { name: "Project name" }), { target: { value: "Nanobot" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "High" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Ephemeral note" }), { target: { value: "Memory only" } });
    await screen.findByText("openui.draftFailed");
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Nanobot");
    fireEvent.click(screen.getByRole("button", { name: "openui.saveDraft" }));
    await screen.findByText("openui.saved");
    fixture.failures.send = true;
    fireEvent.click(screen.getByRole("button", { name: "openui.submit" }));
    await screen.findByText("openui.submitFailed");
    expect(screen.getByRole("textbox", { name: "Ephemeral note" })).toHaveValue("Memory only");
    fireEvent.click(screen.getByRole("button", { name: "openui.submit" }));
    await screen.findByText("openui.submitted");
    const sent = fixture.frames.filter((frame) => frame.type === "message");
    expect(sent).toHaveLength(2);
    expect(sent[0].turn_id).toBe(sent[1].turn_id);
    expect(sent[0].content).toBe(sent[1].content);
  } finally { view.unmount(); fixture.client.close(); }
});

it("restores an uncertain admission as locked instead of resending it", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], {
    ...recoverableForm, state: { $forms: { "form-0": { schema: "test", values: ["Nanobot", "High", ""], status: "unknown", request_id: "existing" } } },
  });
  const view = fixture.mount();
  try {
    await screen.findByText("openui.submissionUnknown");
    expect(screen.getByRole("button", { name: "openui.submit" })).toBeDisabled();
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
  } finally { view.unmount(); fixture.client.close(); }
});

it("recovers saved form fields after reconnect and ignores a foreign session generation", async () => {
  const capability = { protocol: 1, library_hash: manifest.library_hash, form_recovery: true };
  const fixture = setup(capability, [message], recoverableForm);
  const view = fixture.mount();
  try {
    fireEvent.change(await screen.findByRole("textbox", { name: "Project name" }), { target: { value: "Reconnect draft" } });
    await screen.findByText("openui.saved");
    act(() => fixture.socket.onclose?.());
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull());
    act(() => {
      fixture.client.connect(); fixture.socket.onopen?.();
      fixture.socket.onmessage?.({ data: JSON.stringify({ event: "ready", chat_id: "chat", client_id: "browser", openui: capability }) } as MessageEvent);
    });
    expect(await screen.findByRole("textbox", { name: "Project name" })).toHaveValue("Reconnect draft");
    act(() => fixture.socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat", snapshot: {
      ...recoverableForm, session_generation: "foreign", state_version: 99,
      state: { $forms: { "form-0": { schema: "test", values: ["Foreign", "High", ""], status: "submitted" } } },
    } }) } as MessageEvent));
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Reconnect draft");
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
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
    fireEvent.change(screen.getByRole("textbox", { name: "openui.filterRecords" }), { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("openui.noRecords");
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "openui.clearFilter" }));
    expect(screen.getByRole("table")).toHaveTextContent("Task 08");
    expect(screen.getByRole("table")).toHaveTextContent("Task 09");
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
      <OpenUIControls /><OpenUIMessage message={message}><p data-testid="native-answer">{message.content}</p></OpenUIMessage>
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

const surveySource = 'root = Panel([survey])\nsurvey = Form("Employee survey", [{label: "New job?", type: "radio", options: ["Yes", "No"]}, {label: "Reasons", type: "checkbox", options: ["Pay", "Other"], when: {field: 0, value: "Yes"}}, {label: "Other reason", when: {field: 1, value: "Other"}}, {label: "Comment", required: false}], "Fill in the questions below.", "questionnaire")\n';
it("renders a whole questionnaire with conditional fields and sends one canonical reply", async () => {
  const fixture = setup({ protocol: 1, library_hash: manifest.library_hash, form_recovery: true }, [message], {
    ...initial, source: surveySource,
  });
  const view = fixture.mount();
  try {
    const form = within(await screen.findByRole("form", { name: "Employee survey" }));
    const submit = form.getByRole("button", { name: "openui.submitForm" });
    const original = screen.getByTestId("native-answer").closest("details")!;
    expect(original).not.toHaveAttribute("open");
    expect(submit).toBeDisabled();
    fireEvent.click(form.getByRole("radio", { name: "Yes" }));
    fireEvent.click(form.getByRole("checkbox", { name: "Other" }));
    fireEvent.change(form.getByRole("textbox", { name: "Other reason" }), { target: { value: "Remove this answer" } });
    fireEvent.click(form.getByRole("radio", { name: "No" }));
    expect(form.queryByRole("group", { name: "Reasons" })).toBeNull();
    expect(submit).toBeEnabled();
    fireEvent.click(form.getByRole("radio", { name: "Yes" }));
    expect(form.getByRole("checkbox", { name: "Other" })).not.toBeChecked();
    fireEvent.click(form.getByRole("checkbox", { name: "Pay" }));
    expect(submit).toBeEnabled();
    expect(fixture.frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    fireEvent.click(submit); fireEvent.click(submit);
    await screen.findByText("openui.submitted");
    const sent = fixture.frames.filter((frame) => frame.type === "message");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ content: "Employee survey\nNew job?: Yes\nReasons: Pay\nComment: ",
      ui_action: { form_id: "form-0", request_id: "form-request-1" } });
    expect(fixture.frames.find((frame) => frame.action === "openui.form")).toMatchObject({
      payload: { form: { values: ["Yes", ["Pay"], "", ""], submit: true } },
    });
  } finally { view.unmount(); fixture.client.close(); }
});

it("keeps the original answer visible when a questionnaire is incomplete or invalid", async () => {
  const fixture = setup(undefined, [message], { ...initial, status: "streaming", source: surveySource });
  const view = fixture.mount();
  try {
    await screen.findByRole("form", { name: "Employee survey" });
    expect(screen.getByTestId("native-answer").closest("details")).toBeNull();
    act(() => fixture.socket.onmessage?.({ data: JSON.stringify({ event: "openui.snapshot", chat_id: "chat", snapshot: {
      ...initial, seq: initial.seq + 1, source: surveySource.replace('field: 0, value: "Yes"', 'field: 9, value: "Yes"'),
    } }) } as MessageEvent));
    await waitFor(() => expect(screen.queryByRole("button", { name: "openui.cancelView" })).toBeNull());
    expect(screen.getByTestId("native-answer").closest("details")).toBeNull();
  } finally { view.unmount(); fixture.client.close(); }
});
