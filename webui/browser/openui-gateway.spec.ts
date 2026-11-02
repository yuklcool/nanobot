import { expect, test, type Page } from "@playwright/test";
import { uiSnapshotSchema, type UiSnapshot } from "../src/openui/snapshot";

test.skip(!process.env.NANOBOT_OPENUI_GATEWAY_PYTHON, "Requires the disposable native Gateway; run test:openui:gateway.");

test.afterEach(async ({ request }) => {
  for (const tag of ["reconnect", "switch"]) {
    const response = await request.get(`/api/openui-fixture?release=${tag}`);
    expect([200, 409]).toContain(response.status());
  }
});

function observeRecovery(page: Page) {
  const sent: Record<string, unknown>[] = [];
  const snapshots: UiSnapshot[] = [];
  const restored: UiSnapshot[] = [];
  const errors: string[] = [];
  let ready = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload))));
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.event === "ready") ready += 1;
      if (frame.event === "openui.snapshot") snapshots.push(uiSnapshotSchema.parse(frame.snapshot));
      if (frame.event === "webui_response" && Array.isArray(frame.result?.blocks)) {
        restored.push(...frame.result.blocks.map((block: unknown) => uiSnapshotSchema.parse(block)));
      }
    });
  });
  return { sent, snapshots, restored, errors, ready: () => ready };
}

async function recoveryCounters(page: Page) {
  const response = await page.request.get("/api/openui-fixture");
  expect(response.ok()).toBe(true);
  return await response.json() as { agent_calls: number; ui_calls: number; tool_calls: number };
}

test("SDK clear removes an open form from both pages and a fresh session starts without its draft", async ({ page, browser, baseURL }) => {
  const observed = observeRecovery(page);
  const otherContext = await browser.newContext({ baseURL });
  const other = await otherContext.newPage();
  try {
    await page.goto("/browser/openui-gateway.html?recovery");
    await page.getByRole("combobox", { name: "Conversation", exact: true }).selectOption("recovery-reset");
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("openui");
    await page.getByRole("textbox", { name: "Question", exact: true }).fill("I want to define a new project.");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    const form = page.getByRole("form", { name: "Project details", exact: true });
    await expect(form.getByRole("textbox", { name: "Project name", exact: true })).toBeEnabled();
    await form.getByRole("textbox", { name: "Project name", exact: true }).fill("Retired project");
    await expect(form.getByRole("status")).toHaveText("Draft saved");
    const retired = observed.snapshots.at(-1)!;
    await other.goto("/browser/openui-gateway.html?recovery");
    await other.getByRole("combobox", { name: "Conversation", exact: true }).selectOption("recovery-reset");
    await expect(other.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue("Retired project");
    const before = await recoveryCounters(page);
    expect((await page.request.get("/api/openui-fixture?clear=recovery-reset")).ok()).toBe(true);
    await expect(form).toHaveCount(0);
    await expect(other.getByRole("form", { name: "Project details", exact: true })).toHaveCount(0);
    expect(await recoveryCounters(page)).toEqual(before);
    for (const tab of [page, other]) {
      await tab.reload();
      await tab.getByRole("combobox", { name: "Conversation", exact: true }).selectOption("recovery-reset");
      await expect(tab.getByRole("combobox", { name: "Interactive replies" })).toBeVisible();
      await expect(tab.getByRole("form", { name: "Project details", exact: true })).toHaveCount(0);
      await expect(tab.getByText("Retired project", { exact: false })).toHaveCount(0);
    }
    expect(await recoveryCounters(page)).toEqual(before);
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("openui");
    await page.getByRole("textbox", { name: "Question", exact: true }).fill("I want to define a new project.");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(form.getByRole("textbox", { name: "Project name", exact: true })).toBeEnabled();
    await expect(form.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue("");
    expect(observed.snapshots.at(-1)!.session_generation).not.toBe(retired.session_generation);
    expect(await recoveryCounters(page)).toEqual({ agent_calls: before.agent_calls + 1,
      ui_calls: before.ui_calls + 1, tool_calls: before.tool_calls });
    expect(observed.errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("reset-fresh-questionnaire.png"), fullPage: true });
  } finally {
    await otherContext.close();
  }
});

test("a disconnected generating view resumes its snapshot and saved form without replay", async ({ page }) => {
  const observed = observeRecovery(page);
  await page.goto("/browser/openui-gateway.html?recovery");
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("openui");
  const before = await recoveryCounters(page);
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Recovery reconnect");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const heading = page.getByText("Recovery reconnect streaming", { exact: true });
  await expect(heading).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel view", exact: true })).toBeVisible();
  const original = observed.snapshots.at(-1)!;
  expect(original.status).toBe("streaming");
  const generated = await recoveryCounters(page);
  expect(generated).toEqual({ agent_calls: before.agent_calls + 2, ui_calls: before.ui_calls + 1, tool_calls: before.tool_calls + 1 });
  expect((await page.request.get("/api/openui-fixture?disconnect=recovery-reconnect")).ok()).toBe(true);
  await expect.poll(observed.ready).toBe(2);
  await expect(heading).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Interactive replies" })).toHaveValue("openui");
  expect(await recoveryCounters(page)).toEqual(generated);
  expect((await page.request.get("/api/openui-fixture?release=reconnect")).ok()).toBe(true);
  const form = page.getByRole("form", { name: "Recovery reconnect form", exact: true });
  const name = form.getByRole("textbox", { name: "Project name", exact: true });
  await expect(name).toBeEnabled();
  await expect(heading).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Cancel view", exact: true })).toHaveCount(0);
  await name.fill("Recovered project");
  await expect(form.getByRole("status")).toHaveText("Draft saved");
  await page.reload();
  await expect(name).toHaveValue("Recovered project");
  await expect(heading).toHaveCount(1);
  expect(await recoveryCounters(page)).toEqual(generated);
  expect(observed.sent.filter((frame) => frame.type === "message")).toHaveLength(1);
  expect(observed.snapshots.every((snapshot) => snapshot.block_id === original.block_id && snapshot.turn_id === original.turn_id)).toBe(true);
  expect(observed.restored.some((snapshot) => snapshot.block_id === original.block_id && snapshot.status === "streaming")).toBe(true);
  expect(observed.restored.some((snapshot) => snapshot.block_id === original.block_id && snapshot.status === "complete")).toBe(true);
  expect(observed.errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("reconnected-view-draft.png"), fullPage: true });
});

test("switching conversations during generation keeps each view and action in its own session", async ({ page }) => {
  const observed = observeRecovery(page);
  await page.goto("/browser/openui-gateway.html?recovery");
  const conversation = page.getByRole("combobox", { name: "Conversation", exact: true });
  await conversation.selectOption("recovery-switch-a");
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("openui");
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Recovery switch");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Recovery switch streaming", { exact: true })).toBeVisible();
  await conversation.selectOption("recovery-switch-b");
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Plan a small project");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("button", { name: "Define the project", exact: true })).toBeVisible();
  const generated = await recoveryCounters(page);
  expect((await page.request.get("/api/openui-fixture?release=switch")).ok()).toBe(true);
  await expect.poll(() => observed.snapshots.some((snapshot) => snapshot.chat_id === "recovery-switch-a" && snapshot.status === "complete")).toBe(true);
  await expect(page.getByText("Recovery switch streaming", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Recovery switch form", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Define the project", exact: true })).toHaveCount(1);
  await conversation.selectOption("recovery-switch-a");
  const form = page.getByRole("form", { name: "Recovery switch form", exact: true });
  await expect(form.getByRole("textbox", { name: "Project name", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Define the project", exact: true })).toHaveCount(0);
  expect(await recoveryCounters(page)).toEqual(generated);
  await form.getByRole("textbox", { name: "Project name", exact: true }).fill("Session A only");
  await form.getByRole("button", { name: "Send", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("Submitted");
  await expect(page.getByText(/^Lookup result \d+$/, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeEnabled();
  expect(observed.sent.filter((frame) => frame.type === "message").map((frame) => frame.chat_id))
    .toEqual(["recovery-switch-a", "recovery-switch-b", "recovery-switch-a"]);
  const afterSubmit = await recoveryCounters(page);
  await conversation.selectOption("recovery-switch-b");
  await expect(page.getByRole("button", { name: "Define the project", exact: true })).toHaveCount(1);
  await expect(page.getByText("Session A only", { exact: false })).toHaveCount(0);
  expect(await recoveryCounters(page)).toEqual(afterSubmit);
  expect(observed.errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("switched-session-isolation.png"), fullPage: true });
});

test("native history pages restore more than one subscription batch at the original answer anchors", async ({ page }) => {
  test.setTimeout(60_000);
  const observed = observeRecovery(page);
  await page.goto("/browser/openui-gateway.html?recovery");
  await page.getByRole("combobox", { name: "Conversation", exact: true }).selectOption("recovery-history");
  await expect(page.getByText("History card 244", { exact: true })).toBeVisible();
  const before = await recoveryCounters(page);
  const older = page.getByRole("button", { name: "Load older messages", exact: true });
  const reads: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/webui-thread") && request.url().includes("before=")) reads.push(request.url()); });
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const response = page.waitForResponse((value) => value.url().includes("/webui-thread") && value.url().includes("before="));
    await older.click();
    const body = await (await response).json();
    if (!body.page.has_more_before) break;
    await expect(older).toBeEnabled();
  }
  await expect(older).toBeDisabled();
  expect(reads.length).toBeGreaterThanOrEqual(2);
  const rows = page.locator("[data-thread-display-unit]");
  await expect(rows).toHaveCount(490);
  for (const index of [0, 124, 244]) {
    const row = rows.nth(index * 2 + 1);
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByText(`History answer ${index}`, { exact: true })).toHaveCount(1);
    await expect(row.getByText(`History card ${index}`, { exact: true })).toHaveCount(1);
  }
  await rows.nth(1).scrollIntoViewIfNeeded();
  await expect(page.getByRole("textbox", { name: "Follow-up question", exact: true })).toHaveValue("Saved historical draft");
  const subscriptions = observed.sent.filter((frame) => frame.action === "openui.subscribe" && (frame.payload as { chat_id: string }).chat_id === "recovery-history");
  expect(subscriptions.length).toBeGreaterThanOrEqual(3);
  expect(subscriptions.every((frame) => (frame.payload as { turn_ids: string[] }).turn_ids.length <= 100)).toBe(true);
  expect(new Set(observed.restored.filter((snapshot) => snapshot.chat_id === "recovery-history").map((snapshot) => snapshot.block_id)).size).toBe(245);
  expect(await recoveryCounters(page)).toEqual(before);
  expect(observed.sent.filter((frame) => frame.type === "message" || frame.action === "openui.form" || frame.action === "openui.query")).toHaveLength(0);
  expect(observed.errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("history-anchor-draft.png") });
});

test("two tabs resolve a form draft conflict without automatic overwrite or an Agent turn", async ({ page, browser, baseURL }) => {
  const otherContext = await browser.newContext({ baseURL });
  const other = await otherContext.newPage();
  const frames: Record<string, unknown>[] = [];
  const otherFrames: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const tab of [page, other]) tab.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => frames.push(JSON.parse(String(payload)))));
  other.on("websocket", (socket) => socket.on("framesent", ({ payload }) => otherFrames.push(JSON.parse(String(payload)))));
  try {
    await page.goto("/browser/openui-gateway.html");
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
    await page.getByRole("textbox", { name: "Question", exact: true }).fill("Plan a small project");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.getByRole("button", { name: "Define the project", exact: true }).click();
    const form = page.getByRole("form", { name: "Project details", exact: true });
    await form.getByRole("textbox", { name: "Project name" }).fill("Original project");
    await form.getByRole("combobox", { name: "Priority" }).selectOption("Normal");
    await expect(form.getByRole("status")).toHaveText("Draft saved");
    await other.goto("/browser/openui-gateway.html");
    const otherForm = other.getByRole("form", { name: "Project details", exact: true });
    const otherName = otherForm.getByRole("textbox", { name: "Project name" });
    await expect(otherName).toHaveValue("Original project");
    await other.clock.install({ time: new Date("2026-10-31T10:00:00Z") });
    await other.clock.pauseAt(new Date("2026-10-31T10:00:01Z"));
    await otherName.fill("My unsaved project");
    await form.getByRole("textbox", { name: "Project name" }).fill("Shared project");
    await expect(otherForm.getByRole("alert")).toContainText("The draft changed in another tab.");
    await expect(otherName).toHaveValue("My unsaved project");
    await expect(otherForm.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await other.clock.runFor(1000);
    expect(otherFrames.filter((frame) => frame.action === "openui.form")).toHaveLength(0);
    await other.setViewportSize({ width: 390, height: 844 });
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await other.screenshot({ path: test.info().outputPath("draft-conflict-mobile.png"), fullPage: true });
    await otherForm.getByRole("button", { name: "Load latest draft", exact: true }).click();
    await expect(otherName).toHaveValue("Shared project");
    await otherName.fill("Keep this project");
    await form.getByRole("textbox", { name: "Project name" }).fill("Newer shared project");
    await expect(otherForm.getByRole("alert")).toContainText("The draft changed in another tab.");
    await otherForm.getByRole("button", { name: "Save this tab’s draft", exact: true }).click();
    await expect(otherForm.getByRole("alert")).toHaveCount(0);
    await expect(form.getByRole("textbox", { name: "Project name" })).toHaveValue("Keep this project");
    expect(otherFrames.filter((frame) => frame.action === "openui.form")).toHaveLength(1);
    expect(otherFrames.filter((frame) => frame.type === "message")).toHaveLength(0);
    await page.reload();
    await expect(form.getByRole("textbox", { name: "Project name" })).toHaveValue("Keep this project");
    expect(frames.filter((frame) => frame.type === "message")).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally { await otherContext.close(); }
});

test("confirmed title edit updates the native sidebar and restores without replay", async ({ page }) => {
  const frames: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => frames.push(JSON.parse(String(payload)))));
  await page.goto("/browser/openui-gateway.html");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Rename this chat to Project plan");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const title = page.getByRole("textbox", { name: "New title", exact: true });
  await expect(title).toHaveValue("Project plan");
  await title.fill("Interactive development plan");
  await page.getByRole("button", { name: "Review change", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm rename", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Conversation title", { exact: true })).not.toHaveText("Interactive development plan");
  await page.screenshot({ path: test.info().outputPath("rename-review-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Confirm rename", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: 'Renamed to “Interactive development plan”.' })).toBeVisible();
  await expect(page.getByLabel("Conversation title", { exact: true })).toHaveText("Interactive development plan");
  expect(frames.filter((frame) => frame.type === "message")).toHaveLength(1);
  expect(frames.filter((frame) => frame.action === "openui.rename")).toHaveLength(2);
  await page.reload();
  await expect(title).toHaveValue("Interactive development plan");
  await expect(title).toBeDisabled();
  await expect(page.getByLabel("Conversation title", { exact: true })).toHaveText("Interactive development plan");
  expect(frames.filter((frame) => frame.action === "openui.rename")).toHaveLength(2);
  await page.getByRole("button", { name: "Check result", exact: true }).click();
  await expect.poll(() => frames.filter((frame) => frame.action === "openui.rename").length).toBe(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("rename-applied-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
});

test("empty search attempts keep the final answer and can still ask for a useful clarification", async ({ page }) => {
  const completed = new Map<string, { tables: Record<string, { rows: unknown[] }> }>();
  const messages: unknown[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "message") messages.push(frame);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.event === "openui.snapshot" && frame.snapshot.status === "complete") completed.set(frame.snapshot.block_id, frame.snapshot);
    });
  });
  await page.goto("/browser/openui-gateway.html");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
  completed.clear();
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Search missing conversations");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect.poll(() => completed.size).toBe(1);
  expect(Object.values([...completed.values()][0].tables).map((table) => table.rows.length)).toEqual([0, 0]);
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("No saved conversations matched either keyword.");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Filter records" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("no-result-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("no-result-mobile.png"), fullPage: true });
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Search missing conversations and collect a project keyword");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect.poll(() => completed.size).toBe(2);
  await expect(page.getByRole("textbox", { name: "Project keyword" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(messages).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Project keyword" })).toBeVisible();
  expect(messages).toHaveLength(2);
  expect(errors).toEqual([]);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
});

test("new conversation selects a mode before its first message through the production thread shell", async ({ page }) => {
  const frames: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => frames.push(JSON.parse(String(payload)))));
  await page.goto("/browser/openui-gateway.html?new");
  const mode = page.getByRole("combobox", { name: "Interactive replies" });
  await expect(mode).toHaveValue("markdown");
  await mode.selectOption("auto");
  await expect(page.getByTestId("thread-header").getByRole("combobox", { name: "Interactive replies" })).toHaveValue("auto");
  await page.setViewportSize({ width: 390, height: 844 });
  const modeBounds = await mode.boundingBox();
  expect(modeBounds!.x).toBeGreaterThanOrEqual(0);
  expect(modeBounds!.x + modeBounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("new-conversation-mode-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(frames.filter((frame) => frame.type === "new_chat" || frame.type === "message")).toHaveLength(0);
  await page.getByRole("textbox", { name: "Message input", exact: true }).fill("Plan a small project");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Define the project", exact: true })).toBeVisible();
  await expect(mode).toHaveValue("auto");
  const messages = frames.filter((frame) => frame.type === "message");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ content: "Plan a small project", ui_mode: "auto" });
  expect(frames.findIndex((frame) => frame.action === "openui.subscribe")).toBeLessThan(frames.indexOf(messages[0]));
  await page.screenshot({ path: test.info().outputPath("new-conversation-auto-first-message.png"), fullPage: true });
  expect(errors).toEqual([]);
});
test("native model adapter, captured data, record actions and refresh recovery", async ({ page }) => {
  const errors: string[] = [];
  const messages: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "message") messages.push(frame);
  }));
  await page.goto("/browser/openui-gateway.html");
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("openui");
  const before = (await recoveryCounters(page)).tool_calls;
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const followup = page.getByRole("textbox", { name: "Follow-up question" });
  await expect(followup).toBeVisible();
  await expect(followup).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText(`Lookup result ${before + 1}`);
  const table = page.getByRole("table");
  await expect(table).toContainText("5412.5");
  await expect(table).toContainText("Zero energy");
  await expect(table.getByRole("cell", { name: "0", exact: true })).toBeVisible();
  await expect(page.getByText("not-for-display")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Filter records" }).fill("pending");
  await expect(table).not.toContainText("Zero energy");
  expect(messages).toHaveLength(1);
  await page.getByRole("textbox", { name: "Filter records" }).fill("");
  await followup.fill("Look up again");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await page.reload();
  await expect(followup).toHaveValue("Look up again");
  expect(messages).toHaveLength(1);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("openui");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText(`Lookup result ${before + 2}`);
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ chat_id: "gateway-poc", content: "Look up again", ui_action: {
    action_id: "conversation.followup", request_id: messages[1].turn_id,
  } });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(2);
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText(`Lookup result ${before + 2}`);
  expect(messages).toHaveLength(2);
  await page.getByRole("button", { name: "Analyze snapshot", exact: true }).first().click();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText(`Lookup result ${before + 3}`);
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ chat_id: "gateway-poc", ui_action: {
    action_id: "record.analyze", record_id: "task_08", request_id: messages[2].turn_id,
  } });
  expect(messages[2].content).toBe("Analyze Tasks: Energy review");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
  await expect(page.getByRole("combobox", { name: "Interactive replies" })).toBeAttached();
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Conversation" })).not.toContainText(`Lookup result ${before + 1}`);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("openui");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText(`Lookup result ${before + 4}`);
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(1);
  expect(messages).toHaveLength(4);
  expect(errors).toEqual([]);
});

test("inline choices, short forms and confirmations continue the native conversation", async ({ page }) => {
  const errors: string[] = [];
  const messages: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "message") messages.push(frame);
  }));
  await page.goto("/browser/openui-gateway.html");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Plan a small project");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("group", { name: "Where should we start?" })).toBeVisible();
  await expect(page.getByText("Please choose whether to define a new project or review an existing draft.", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(0);
  expect(messages).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("inline-choices-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Define the project", exact: true }).click();
  const form = page.getByRole("form", { name: "Project details" }).first();
  await expect(form).toBeVisible();
  const submit = form.getByRole("button", { name: "Send", exact: true });
  await expect(submit).toBeDisabled();
  await form.getByRole("textbox", { name: "Project name" }).fill("Nanobot interaction");
  await form.getByRole("combobox", { name: "Priority" }).selectOption("High");
  await expect(submit).toBeEnabled();
  await expect(form.getByRole("status")).toHaveText("Draft saved");
  await page.reload();
  await expect(form.getByRole("textbox", { name: "Project name" })).toHaveValue("Nanobot interaction");
  await expect(form.getByRole("combobox", { name: "Priority" })).toHaveValue("High");
  expect(messages).toHaveLength(2);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.screenshot({ path: test.info().outputPath("inline-form-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const formBounds = await form.boundingBox();
  const composerBounds = await page.getByRole("textbox", { name: "Question", exact: true }).boundingBox();
  expect(formBounds!.y + formBounds!.height).toBeLessThanOrEqual(composerBounds!.y);
  await page.screenshot({ path: test.info().outputPath("inline-form-mobile.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.classList.add("dark"); });
  await page.screenshot({ path: test.info().outputPath("inline-form-mobile-dark.png"), fullPage: true });
  await submit.click();
  await expect(page.getByRole("button", { name: "Confirm plan", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("inline-confirmation-mobile-dark.png"), fullPage: true });
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ content: "Project details\nProject name: Nanobot interaction\nPriority: High",
    ui_action: { action_id: "conversation.followup", request_id: messages[2].turn_id, form_id: "form-0" } });
  await page.reload();
  await expect(form.getByRole("status")).toHaveText("Submitted");
  await expect(submit).toBeDisabled();
  expect(messages).toHaveLength(3);
  await page.screenshot({ path: test.info().outputPath("form-submitted-after-refresh.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.getByRole("button", { name: "Change details", exact: true }).click();
  const revised = page.getByRole("form", { name: "Project details", exact: true }).last();
  await expect(revised.getByRole("textbox", { name: "Project name" })).toHaveValue("Nanobot interaction");
  await expect(revised.getByRole("combobox", { name: "Priority" })).toHaveValue("High");
  await expect(submit).toBeDisabled();
  await revised.getByRole("textbox", { name: "Project name" }).fill("Nanobot revision");
  await revised.getByRole("combobox", { name: "Priority" }).selectOption("Normal");
  await expect(revised.getByRole("status")).toHaveText("Draft saved");
  await page.reload();
  await expect(revised.getByRole("textbox", { name: "Project name" })).toHaveValue("Nanobot revision");
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await revised.getByRole("button", { name: "Send", exact: true }).dblclick();
  await expect(revised.getByRole("status")).toHaveText("Submitted");
  expect(messages).toHaveLength(5);
  expect(messages[4].content).toBe("Project details\nProject name: Nanobot revision\nPriority: Normal");
  expect(messages[4].turn_id).not.toBe(messages[2].turn_id);
  await expect(form.first().getByRole("textbox", { name: "Project name" })).toHaveValue("Nanobot interaction");
  await page.getByRole("button", { name: "Confirm plan", exact: true }).last().click();
  await expect(page.getByText("Confirmed. We can now prepare the plan in this conversation.", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(messages).toHaveLength(6);
  expect(messages[5]).toMatchObject({ content: "Confirm the proposed project plan.", ui_action: {
    action_id: "conversation.followup", request_id: messages[5].turn_id,
  } });
  expect(messages.every((message) => message.ui_mode === "auto")).toBe(true);
  await page.reload();
  await expect(page.getByText("Confirmed. We can now prepare the plan in this conversation.", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(messages).toHaveLength(6);
  expect(errors).toEqual([]);
});

test("auto mode uses real session search and read tools without replaying history actions", async ({ page }) => {
  const errors: string[] = [];
  const messages: Record<string, unknown>[] = [];
  const queryFrames: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "message") messages.push(frame);
    if (frame.action === "openui.query") queryFrames.push(frame);
  }));
  await page.goto("/browser/openui-gateway.html");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Explain variables");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("A variable stores a value.", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Find saved planning conversations");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const table = page.getByRole("table", { name: "Saved conversations" });
  await expect(table).toContainText("Planning notes");
  await expect(page.getByRole("table")).toHaveCount(1);
  await expect(page.getByText("Only visible saved conversations are included.", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await page.getByText("View original text", { exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(2);
  await page.getByText("View original text", { exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(1);
  await expect(table).not.toContainText("Planning detail");
  await page.getByRole("textbox", { name: "Filter records" }).fill("not a matching title");
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "No matching records." })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("filtered-empty-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("filtered-empty-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(messages).toHaveLength(2);
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await expect(table).toContainText("Planning notes");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Loading data…", { exact: true })).toHaveCount(0);
  await expect(table).toContainText("Planning notes");
  await table.getByRole("button", { name: "View details", exact: true }).click();
  const details = page.getByRole("region", { name: "Conversation details" });
  await expect(details).toContainText("Planning detail: Ship the read-only workflow.");
  expect(queryFrames).toHaveLength(2);
  expect(messages).toHaveLength(2);
  await page.screenshot({ path: test.info().outputPath("readonly-session-details-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("readonly-session-details-mobile.png"), fullPage: true });
  await page.reload();
  await expect(table).toContainText("Planning notes");
  await expect(details).toHaveCount(0);
  expect(queryFrames).toHaveLength(2);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await table.getByRole("button", { name: "Analyze snapshot" }).click();
  await expect(page.getByRole("button", { name: "Summarize notes" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Planning detail: Ship the read-only workflow.");
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ chat_id: "gateway-poc", ui_mode: "auto", ui_action: {
    action_id: "record.analyze", record_id: "websocket:saved-planning",
  } });
  await expect(page.locator("[data-user-text-bubble] > p").last()).toHaveText("Analyze Saved conversations: Planning notes");
  await page.screenshot({ path: test.info().outputPath("auto-native-session-tools.png"), fullPage: true });
  await page.reload();
  await expect(page.getByRole("button", { name: "Summarize notes" })).toBeVisible();
  await expect(page.locator("[data-user-text-bubble] > p").last()).toHaveText("Analyze Saved conversations: Planning notes");
  expect(messages).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("a complete employee questionnaire replaces static text and submits visible answers once", async ({ page }) => {
  const errors: string[] = [];
  const frames: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => frames.push(JSON.parse(String(payload)))));
  await page.goto("/browser/openui-gateway.html");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Create an employee survey");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const survey = page.getByRole("form", { name: "公司员工就业情况调查表" });
  await expect(survey).toBeVisible();
  const submit = survey.getByRole("button", { name: "Submit answers", exact: true });
  await expect(submit).toBeDisabled();
  await expect(page.getByRole("heading", { name: "公司员工就业情况调查表" })).toHaveCount(0);
  await page.getByText("View original text", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "公司员工就业情况调查表" })).toBeVisible();
  await page.getByText("View original text", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "公司员工就业情况调查表" })).toHaveCount(0);
  await survey.getByRole("radio", { name: "在职", exact: true }).check();
  await survey.getByRole("radio", { name: "差不多", exact: true }).check();
  await survey.getByRole("radio", { name: "不便透露", exact: true }).check();
  await survey.getByRole("radio", { name: "是", exact: true }).check();
  const reasons = survey.getByRole("group", { name: "主要原因（多选）", exact: true });
  await reasons.getByRole("checkbox", { name: "薪酬", exact: true }).check();
  await reasons.getByRole("checkbox", { name: "其他", exact: true }).check();
  await survey.getByRole("textbox", { name: "其他离职原因", exact: true }).fill("已撤回的个人原因");
  await survey.getByRole("radio", { name: "否", exact: true }).check();
  await expect(reasons).toHaveCount(0);
  await survey.getByRole("radio", { name: "是", exact: true }).check();
  await expect(reasons.getByRole("checkbox", { name: "薪酬", exact: true })).not.toBeChecked();
  await reasons.getByRole("checkbox", { name: "其他", exact: true }).check();
  await expect(survey.getByRole("textbox", { name: "其他离职原因", exact: true })).toHaveValue("");
  await expect(submit).toBeDisabled();
  await reasons.getByRole("checkbox", { name: "其他", exact: true }).uncheck();
  await reasons.getByRole("checkbox", { name: "薪酬", exact: true }).check();
  await reasons.getByRole("checkbox", { name: "发展机会", exact: true }).check();
  await survey.getByRole("radio", { name: "一般", exact: true }).check();
  await survey.getByRole("checkbox", { name: "培训发展", exact: true }).check();
  const supports = survey.getByRole("group", { name: "6. 您希望公司提供哪些支持？（多选）", exact: true });
  await supports.getByRole("checkbox", { name: "其他", exact: true }).check();
  await survey.getByRole("textbox", { name: "其他支持", exact: true }).fill("弹性工作时间");
  await expect(submit).toBeEnabled();
  expect(frames.filter((frame) => frame.type === "message")).toHaveLength(1);
  expect(frames.filter((frame) => frame.action === "openui.form")).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath("employee-questionnaire-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("employee-questionnaire-mobile.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.classList.add("dark"); });
  await page.screenshot({ path: test.info().outputPath("employee-questionnaire-mobile-dark.png"), fullPage: true });
  await submit.click();
  await expect(page.getByText("已收到本次填写的答案。", { exact: true }).filter({ visible: true })).toBeVisible();
  const sent = frames.filter((frame) => frame.type === "message");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ chat_id: "gateway-poc", ui_mode: "auto", ui_action: {
    action_id: "conversation.followup", form_id: "form-0", request_id: sent[1].turn_id,
  } });
  expect(sent[1].content).toBe("公司员工就业情况调查表\n1. 您目前的工作状态是？: 在职\n2. 与去年相比，您的工作稳定性如何？: 差不多\n3. 今年您的收入与去年相比如何？: 不便透露\n4. 您今年是否考虑过离职或寻找新工作？: 是\n主要原因（多选）: 薪酬, 发展机会\n5. 您对目前岗位的满意度如何？: 一般\n6. 您希望公司提供哪些支持？（多选）: 培训发展, 其他\n其他支持: 弹性工作时间");
  await page.reload();
  await expect(survey.getByRole("status")).toHaveText("Submitted");
  await expect(submit).toBeDisabled();
  await expect(survey.getByRole("radio", { name: "在职", exact: true })).not.toBeChecked();
  expect(frames.filter((frame) => frame.type === "message")).toHaveLength(2);
  expect(errors).toEqual([]);
});
