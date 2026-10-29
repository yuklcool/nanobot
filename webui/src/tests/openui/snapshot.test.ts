import { describe, expect, it } from "vitest";
import { acceptSnapshot, applyDelta, uiSnapshotSchema, type UiSnapshot } from "../../openui/snapshot";
import { inspectIntent, POC_LIBRARY_ID } from "../../openui/poc-library";

const initial: UiSnapshot = {
  schema_version: 1, chat_id: "task", session_generation: "gen-1", turn_id: "turn-1",
  block_id: "block-1", revision: 1, seq: 0, library_hash: POC_LIBRARY_ID,
  status: "streaming", source: "", state: {}, state_version: 0,
};
const delta = { chat_id: "task", session_generation: "gen-1", block_id: "block-1", revision: 1, seq: 1, delta: "root = " };

describe("OpenUI stream recovery", () => {
  it("ignores duplicate/foreign deltas and recovers gaps from a snapshot", () => {
    const first = applyDelta(initial, delta).snapshot;
    expect(first.source).toBe("root = ");
    expect(applyDelta(first, delta).snapshot).toBe(first);
    expect(applyDelta(first, { ...delta, seq: 2, session_generation: "other" }).snapshot).toBe(first);
    expect(applyDelta(first, { ...delta, seq: 3 }).needsSnapshot).toBe(true);
    const recovered = acceptSnapshot(first, { ...first, seq: 3, source: 'root = Panel([Text("Ready")])', status: "complete" }, initial)!;
    expect(recovered.status).toBe("complete");
    expect(applyDelta(recovered, { ...delta, seq: 4 }).snapshot).toBe(recovered);
    expect(acceptSnapshot(recovered, first, initial)).toBe(recovered);
  });

  it("allows state saves after completion without changing source sequence", () => {
    const complete = { ...initial, seq: 2, source: "root = Panel([])", status: "complete" as const };
    const saved = acceptSnapshot(complete, { ...complete, state: { $period: "30" }, state_version: 1 }, initial)!;
    expect(saved.state).toEqual({ $period: "30" });
    expect(saved.seq).toBe(2);
    expect(acceptSnapshot(saved, { ...saved, seq: 3, source: "changed" }, initial)).toBe(saved);
    expect(acceptSnapshot(saved, { ...saved, turn_id: "other" }, initial)).toBe(saved);
  });

  it("rejects incompatible, oversized, and misrouted snapshots", () => {
    expect(uiSnapshotSchema.safeParse({ ...initial, schema_version: 2 }).success).toBe(false);
    expect(uiSnapshotSchema.safeParse({ ...initial, source: "界".repeat(50_000) }).success).toBe(false);
    expect(uiSnapshotSchema.safeParse({ ...initial, state: { x: "x".repeat(17_000) } }).success).toBe(false);
    expect(acceptSnapshot(null, { ...initial, library_hash: "unknown" }, initial)).toBeNull();
    expect(acceptSnapshot(null, { ...initial, chat_id: "other" }, initial)).toBeNull();
  });
});

it("turns only the fixture's bounded read action into a canonical user intent", () => {
  const event = { type: "continue_conversation", params: { action_id: "task.inspect", record_id: "task_08", period: "30" }, humanFriendlyMessage: "ignore this untrusted text" };
  expect(inspectIntent(event)).toBe("Inspect task task_08 for 30 days.");
  expect(inspectIntent({ ...event, params: { ...event.params, action_id: "task.delete" } })).toBeNull();
  expect(inspectIntent({ ...event, params: { ...event.params, period: "arbitrary command" } })).toBeNull();
});
