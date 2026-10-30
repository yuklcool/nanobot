import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { uiSnapshotSchema, type UiSnapshot } from "../src/openui/snapshot";

test.skip(!process.env.NANOBOT_OPENUI_LIVE_CONFIG, "Opt-in live model acceptance; never uses credentials in ordinary CI.");

type Evidence = {
  calls: { duration_ms: number; finish_reason: string; error_status_code: number | null;
    usage: { total_tokens: number } | null }[];
  tools: { name: string; selected_planning: boolean; error: boolean }[];
  runs: { error: boolean }[];
};

test("live model searches, selects and reads a saved conversation without refresh replay", async ({ page }) => {
  test.setTimeout(240_000);
  const evidence = () => JSON.parse(readFileSync(process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!, "utf8")) as Evidence;
  const snapshots = new Map<string, UiSnapshot>();
  const messages: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const stages: Record<string, number> = {};
  const started = Date.now();
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "message") messages.push(frame);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.event === "openui.snapshot") {
        const snapshot = uiSnapshotSchema.parse(frame.snapshot);
        snapshots.set(snapshot.block_id, snapshot);
      }
    });
  });
  try {
    await page.goto("/browser/openui-gateway.html");
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
    const question = page.getByRole("textbox", { name: "Question", exact: true });
    const ask = page.getByRole("button", { name: "Ask", exact: true });
    await question.fill("Explain what a variable is in one sentence. Use plain text only; do not ask any follow-up question.");
    await ask.click();
    await expect.poll(() => evidence().runs.length, { timeout: 60_000 }).toBe(1);
    await expect(ask).toBeEnabled();
    expect(evidence().calls).toHaveLength(1);
    expect(evidence().tools).toHaveLength(0);
    expect(snapshots.size).toBe(0);
    stages.plain_ms = Date.now() - started;

    const searchStarted = Date.now();
    await question.fill('Search saved conversations for the exact word "planning". List the matches and let me choose a record first. After I select one, read that conversation, tell me its acceptance code and next step, then ask me to choose between "Summarize notes" and "Review risks". Do not read any record before I select it. Reply in English.');
    await ask.click();
    const table = page.getByRole("table", { name: "Saved conversations" });
    await expect(table).toContainText("Planning notes", { timeout: 90_000 });
    await expect(table).toContainText("Planning archive");
    await expect.poll(() => [...snapshots.values()].filter((item) => item.status === "complete").length,
      { timeout: 60_000 }).toBe(1);
    expect(evidence().tools.map((item) => item.name)).toEqual(["search_sessions"]);
    await expect(table).not.toContainText("ORBIT-742");
    await expect(table).not.toContainText("COMET-319");
    const searched = evidence();
    await page.getByRole("textbox", { name: "Filter records" }).fill("Planning notes");
    await expect(table).not.toContainText("Planning archive");
    expect(evidence()).toEqual(searched);
    expect(messages).toHaveLength(2);
    stages.search_ms = Date.now() - searchStarted;
    await page.screenshot({ path: test.info().outputPath("live-search.png"), fullPage: true });

    const readStarted = Date.now();
    await table.getByRole("row").filter({ hasText: "Planning notes" })
      .getByRole("button", { name: "Analyze snapshot", exact: true }).click();
    const next = page.getByRole("button", { name: "Summarize notes", exact: true });
    await expect(next).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("list", { name: "Conversation" })).toContainText("ORBIT-742");
    await expect.poll(() => [...snapshots.values()].filter((item) => item.status === "complete").length,
      { timeout: 60_000 }).toBe(2);
    expect(evidence().tools.map((item) => item.name)).toEqual(["search_sessions", "read_session"]);
    expect(evidence().tools[1].selected_planning).toBe(true);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ chat_id: "gateway-poc", ui_mode: "auto", ui_action: {
      action_id: "record.analyze", record_id: "websocket:saved-planning",
    } });
    stages.read_ms = Date.now() - readStarted;
    await page.screenshot({ path: test.info().outputPath("live-selected-detail.png"), fullPage: true });

    const beforeRefresh = evidence();
    await page.reload();
    await expect(next).toBeVisible();
    await expect(page.getByRole("list", { name: "Conversation" })).toContainText("ORBIT-742");
    // Observe a bounded quiet period after hydration, including delayed message sends.
    await page.waitForTimeout(1_000);
    expect(evidence()).toEqual(beforeRefresh);
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.chat_id === "gateway-poc" && message.ui_mode === "auto")).toBe(true);
    expect([...snapshots.values()].every((item) => item.status === "complete"
      && item.generation_mode === "model" && item.error_code === null)).toBe(true);
    expect(evidence().calls.every((call) => call.finish_reason !== "error" && call.error_status_code === null)).toBe(true);
    expect(evidence().calls.every((call) => call.usage && call.usage.total_tokens > 0)).toBe(true);
    expect(evidence().tools.every((tool) => !tool.error)).toBe(true);
    expect(evidence().runs.every((run) => !run.error)).toBe(true);
    await expect(page.getByText("Interactive view is unavailable.", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("live-restored.png"), fullPage: true });
  } finally {
    const summaryPath = test.info().outputPath("live-summary.json");
    writeFileSync(summaryPath, JSON.stringify({
      elapsed_ms: Date.now() - started, stages, sent_messages: messages.length, page_errors: errors,
      snapshots: [...snapshots.values()].map((item) => ({ status: item.status,
        generation_mode: item.generation_mode, error_code: item.error_code, usage: item.usage,
        source_bytes: Buffer.byteLength(item.source), library_hash: item.library_hash })),
    }, null, 2));
    await test.info().attach("live-summary", { contentType: "application/json", path: summaryPath });
    await test.info().attach("live-provider-calls", { path: process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!,
      contentType: "application/json" });
  }
});
