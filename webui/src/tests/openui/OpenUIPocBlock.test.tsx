import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OpenUIPocBlock } from "../../openui/OpenUIPocBlock";
import { inspectIntent, POC_LIBRARY_ID, pocLibrary } from "../../openui/poc-library";
import { uiSnapshotSchema, type UiSnapshot } from "../../openui/snapshot";
import { NanobotClient } from "../../lib/nanobot-client";
import { ClientProvider } from "../../providers/ClientProvider";
import { useNanobotStream } from "../../hooks/useNanobotStream";

afterEach(cleanup);

const prefix = '$period = "7"\nroot = Panel([heading, period, inspect])\nheading = Text("Task 08 is ready")\n';
const source = `${prefix}period = Period($period)\ninspect = Inspect($period)\n`;
const snapshot: UiSnapshot = {
  schema_version: 1, chat_id: "task", session_generation: "gen-1", turn_id: "turn-1",
  block_id: "block-1", revision: 1, seq: 1, library_hash: POC_LIBRARY_ID,
  status: "streaming", source: prefix, state: {}, state_version: 0,
};

it("renders streamed SDK components and restores reactive state without replaying actions", async () => {
  const onAction = vi.fn();
  const onStateUpdate = vi.fn();
  const props = { fallbackText: "Text fallback", onAction, onStateUpdate };
  const view = render(<OpenUIPocBlock {...props} snapshot={snapshot} />);
  await screen.findByText("Task 08 is ready");
  view.rerender(<OpenUIPocBlock {...props} snapshot={{ ...snapshot, source, seq: 2 }} />);
  const select = await screen.findByRole("combobox", { name: "Period" });
  expect(select).toBeDisabled();
  expect(screen.getByRole("button", { name: "Inspect task" })).toBeDisabled();
  const completed = { ...snapshot, source, seq: 3, status: "complete" as const };
  view.rerender(<OpenUIPocBlock {...props} snapshot={completed} />);
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "30" } });
  await waitFor(() => expect(onStateUpdate).toHaveBeenCalledWith(expect.objectContaining({ $period: "30" })));
  const saved = uiSnapshotSchema.parse({ ...completed, state: onStateUpdate.mock.lastCall![0], state_version: 1 });
  view.unmount();
  render(<OpenUIPocBlock {...props} snapshot={saved} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Period" })).toHaveValue("30"));
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect task" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
  expect(onAction.mock.calls[0][0]).toMatchObject({ type: "continue_conversation", params: { period: "30" } });
  expect(inspectIntent(onAction.mock.calls[0][0])).toBe("Inspect task task_08 for 30 days.");
});

it.each(["failed", "cancelled", "superseded"] as const)("uses fallback for %s without activating controls", (status) => {
  render(<OpenUIPocBlock snapshot={{ ...snapshot, status, source }} fallbackText="Text fallback" onAction={vi.fn()} onStateUpdate={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Text fallback");
  expect(screen.queryByRole("button")).toBeNull();
});

it("falls back on unsupported components and resets on a new revision", async () => {
  const props = { fallbackText: "Text fallback", onAction: vi.fn(), onStateUpdate: vi.fn() };
  const broken = { ...snapshot, source: "root = UnknownComponent()", status: "complete" as const };
  const view = render(<OpenUIPocBlock {...props} snapshot={broken} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Text fallback"));
  view.rerender(<OpenUIPocBlock {...props} snapshot={{ ...broken, revision: 2, source }} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Inspect task" })).toBeEnabled());
});

it("generates model instructions from the actual component library", () => {
  const prompt = pocLibrary.prompt({ examples: [source] });
  expect(prompt).toContain("Panel");
  expect(prompt).toContain("Period");
  expect(prompt).toContain("Inspect");
  expect(prompt).toContain("$period");
});

it("routes a card click through the native stream hook and client to the same chat", async () => {
  const frames: Record<string, unknown>[] = [];
  const socket = {
    readyState: 1, onopen: null as (() => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    send: (raw: string) => frames.push(JSON.parse(raw)), close() {},
  };
  const client = new NanobotClient({ url: "ws://test", reconnect: false, socketFactory: () => socket as unknown as WebSocket });
  client.connect();
  socket.onopen?.();
  function Thread() {
    const { send, messages } = useNanobotStream(snapshot.chat_id);
    return <>
      <OpenUIPocBlock snapshot={{ ...snapshot, source, status: "complete", state: { $period: "30" } }}
        fallbackText="Text fallback" onStateUpdate={() => {}} onAction={(event) => {
          const intent = inspectIntent(event);
          if (intent) send(intent);
        }} />
      <output>{messages.map((message) => message.content).join("\n")}</output>
    </>;
  }
  const view = render(<ClientProvider client={client} token="fixture" allowUpdateFlow={false}><Thread /></ClientProvider>);
  try {
    const button = await screen.findByRole("button", { name: "Inspect task" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(frames.filter((frame) => frame.type === "message")).toHaveLength(0);
    fireEvent.click(button);
    await waitFor(() => expect(frames.filter((frame) => frame.type === "message")).toHaveLength(1));
    expect(frames.find((frame) => frame.type === "message")).toMatchObject({
      chat_id: "task", content: "Inspect task task_08 for 30 days.", turn_id: expect.any(String), webui: true,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Inspect task task_08 for 30 days.");
  } finally {
    view.unmount();
    client.close();
  }
});
