import { createQueryManager } from "@openuidev/lang-core";
import { expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

it("locked SDK supports snapshot Query and explicit Mutation, with an application-owned tool gate", async () => {
  const read = vi.fn(async () => ({ rows: [{ id: "task_08", energy: 5412.5 }] }));
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "read_snapshot" && args.data_ref === "data_1") return read();
    // Compatibility fixture only. Production Renderer still receives no toolProvider.
    throw new Error("ACTION_NOT_ALLOWED");
  });
  const manager = createQueryManager({ callTool });
  manager.activate();
  try {
    manager.evaluateQueries([{ statementId: "data", toolName: "read_snapshot", args: { data_ref: "data_1" },
      defaults: { rows: [] }, deps: null, complete: true }]);
    await waitFor(() => expect(manager.getResult("data")).toEqual({ rows: [{ id: "task_08", energy: 5412.5 }] }));
    expect(read).toHaveBeenCalledTimes(1);
    manager.registerMutations([{ statementId: "write", toolName: "business_write" }]);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(await manager.fireMutation("write", { id: "task_08" })).toBe(false);
    expect(manager.getMutationResult("write")?.status).toBe("error");
    expect(callTool).toHaveBeenLastCalledWith("business_write", { id: "task_08" });
  } finally { manager.dispose(); }
});
