import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { uiSnapshotSchema, type UiSnapshot } from "../src/openui/snapshot";

test.skip(!process.env.NANOBOT_OPENUI_LIVE_CONFIG, "Opt-in live model acceptance; never uses credentials in ordinary CI.");

type Evidence = {
  calls: { duration_ms: number; finish_reason: string; error_status_code: number | null;
    usage: { total_tokens: number } | null }[];
  tools: { name: string; selected_planning: boolean; error: boolean;
    selection_applied: boolean; selected_count: number | null; result_count: number | null }[];
  runs: { error: boolean }[];
};

test("live model searches, selects and reads a saved conversation without refresh replay", async ({ page }) => {
  test.setTimeout(420_000);
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
    // Older turns virtualize offscreen; assertions must target the current reply.
    const latestReply = page.locator("[data-assistant-message]").last();
    await question.fill("Explain what a variable is in one sentence. Use plain text only; do not ask any follow-up question.");
    await ask.click();
    await expect.poll(() => evidence().runs.length, { timeout: 60_000 }).toBe(1);
    await expect(ask).toBeEnabled();
    expect(evidence().calls).toHaveLength(1);
    expect(evidence().tools).toHaveLength(0);
    expect(snapshots.size).toBe(0);
    stages.plain_ms = Date.now() - started;

    const searchStarted = Date.now();
    await question.fill('Search saved conversations for the exact word "planning". Show the matches in a filterable table and let me choose a record first. After I select one, read that conversation, tell me its acceptance code and next step, then ask me to choose between "Summarize notes" and "Review risks". Do not read any record before I select it. Reply in English.');
    await ask.click();
    const table = page.getByRole("table", { name: "Saved conversations" });
    await expect(table).toContainText("Planning notes", { timeout: 90_000 });
    await expect(table).toContainText("Planning archive");
    await expect.poll(() => [...snapshots.values()].filter((item) => item.status === "complete").length,
      { timeout: 60_000 }).toBe(1);
    expect(evidence().tools.length).toBeGreaterThan(0);
    expect(evidence().tools.every((item) => item.name === "search_sessions")).toBe(true);
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
    const reads = evidence().tools.filter((item) => item.name === "read_session");
    expect(reads).toHaveLength(1);
    expect(reads[0].selected_planning).toBe(true);
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

    const presentationCases = [
      {
        name: "no-results", tables: 0, empty: true,
        question: '分别检索历史会话中的“missing-azimuth”和“missing-cobalt”，每个关键词搜索一次，用可筛选表格展示匹配的会话。如果都没有匹配，简短告诉我结果。',
      },
      {
        name: "final-results", tables: 1, empty: true,
        question: '分别检索历史会话中的“missing-azimuth”和“planning”，每个关键词搜索一次。最终展示 planning 结果的可筛选表格。',
      },
      {
        name: "comparison", tables: 2, empty: false,
        question: '分别检索历史会话中的“planning”和“archive”，每个关键词搜索一次。我要比较这两个搜索范围，请分别展示两个可筛选的结果列表。',
      },
    ];
    for (const scenario of presentationCases) {
      await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
      const previousBlocks = new Set(snapshots.keys());
      const previousMessages = messages.length;
      await question.fill(scenario.question);
      await ask.click();
      await expect.poll(() => [...snapshots.values()].filter((item) => !previousBlocks.has(item.block_id)
        && item.status === "complete").length, { timeout: 90_000 }).toBe(1);
      const block = [...snapshots.values()].find((item) => !previousBlocks.has(item.block_id))!;
      const datasets = Object.values(block.tables ?? {});
      expect(datasets.length).toBeGreaterThanOrEqual(2);
      expect(datasets.some((item) => item.rows.length === 0)).toBe(scenario.empty);
      await latestReply.scrollIntoViewIfNeeded();
      await expect.soft(latestReply.getByRole("table")).toHaveCount(scenario.tables);
      if (!scenario.tables) expect.soft(block.source).toMatch(/root\s*=\s*Panel\(\s*\[\s*\](?:\s*,\s*"supplement")?\s*\)/);
      expect(messages).toHaveLength(previousMessages + 1);
      await page.screenshot({ path: test.info().outputPath(`live-${scenario.name}-desktop.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`live-${scenario.name}-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 720 });
      const settled = evidence();
      await page.reload();
      await latestReply.scrollIntoViewIfNeeded();
      await expect.soft(latestReply.getByRole("table")).toHaveCount(scenario.tables);
      await expect(ask).toBeEnabled();
      expect(evidence()).toEqual(settled);
      expect(messages).toHaveLength(previousMessages + 1);
    }
    expect(errors).toEqual([]);
    expect([...snapshots.values()].every((item) => item.status === "complete" && item.error_code === null)).toBe(true);
  } finally {
    const summaryPath = test.info().outputPath("live-summary.json");
    writeFileSync(summaryPath, JSON.stringify({
      elapsed_ms: Date.now() - started, stages, sent_messages: messages.length, page_errors: errors,
      snapshots: [...snapshots.values()].map((item) => ({ status: item.status,
        generation_mode: item.generation_mode, error_code: item.error_code, usage: item.usage,
        source_bytes: Buffer.byteLength(item.source), library_hash: item.library_hash,
        candidate_rows: Object.values(item.tables ?? {}).map((table) => table.rows.length),
        source: item.source, answer: item.fallback_text,
        selected_records: Object.values(item.tables ?? {}).map((table) => table.rows.map((row) => row.id)) })),
    }, null, 2));
    await test.info().attach("live-summary", { contentType: "application/json", path: summaryPath });
    await test.info().attach("live-provider-calls", { path: process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!,
      contentType: "application/json" });
  }
});

test("live model qualifies mixed content while preserving literal browsing", async ({ page }) => {
  test.setTimeout(240_000);
  const evidence = () => JSON.parse(readFileSync(process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!, "utf8")) as Evidence;
  const snapshots = new Map<string, UiSnapshot>();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.event === "openui.snapshot") {
      const snapshot = uiSnapshotSchema.parse(frame.snapshot);
      snapshots.set(snapshot.block_id, snapshot);
    }
  }));
  try {
    await page.goto("/browser/openui-gateway.html");
    const question = page.getByRole("textbox", { name: "Question", exact: true });
    const ask = page.getByRole("button", { name: "Ask", exact: true });
    const latestReply = page.locator("[data-assistant-message]").last();
    const relevanceCases = [
      { name: "lookup-only", question: "查找之前关于 aurora 项目规划的会话，用可筛选表格展示。",
        selected: [], tables: 0 },
      { name: "mixed-content", question: "查找之前关于 meridian 项目已经确定的规划与下一步，用可筛选表格展示。",
        selected: ["websocket:meridian-decisions"], tables: 1 },
      { name: "literal-browsing", question: "浏览所有标题或消息中匹配 aurora 的会话记录，包括之前没有找到方案的查询记录。用可筛选表格展示这些关键词匹配记录，不需要核实是否包含实际规划。",
        selected: ["websocket:aurora-lookup"], tables: 1 },
    ];
    for (const scenario of relevanceCases) {
      await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
      const previousBlocks = new Set(snapshots.keys());
      const previousTools = evidence().tools.length;
      await question.fill(scenario.question);
      await ask.click();
      await expect.poll(() => [...snapshots.values()].filter((item) => !previousBlocks.has(item.block_id)
        && item.status === "complete").length, { timeout: 120_000 }).toBe(1);
      await expect(ask).toBeEnabled();
      const block = [...snapshots.values()].find((item) => !previousBlocks.has(item.block_id))!;
      const datasets = Object.values(block.tables ?? {});
      if (scenario.tables) {
        expect(datasets).toHaveLength(1);
        expect(datasets[0].rows.map((row) => row.id)).toEqual(scenario.selected);
      }
      if (scenario.name !== "literal-browsing") {
        expect(evidence().tools.slice(previousTools).some((tool) => tool.name === "search_sessions"
          && !tool.selection_applied && (tool.result_count ?? 0) >= (scenario.name === "mixed-content" ? 2 : 1))).toBe(true);
      }
      if (scenario.name === "mixed-content") {
        expect(datasets[0].session_query?.session_keys).toEqual(scenario.selected);
        expect(evidence().tools.slice(previousTools).some((tool) => tool.selection_applied
          && tool.selected_count === 1)).toBe(true);
        expect(block.fallback_text).toContain("LANTERN-681");
        await expect(latestReply.locator("p").filter({ hasText: "权限审查" })).toBeVisible();
        await expect(latestReply.getByRole("table")).toContainText("Meridian approved roadmap");
        await expect(latestReply.getByRole("table")).not.toContainText("Meridian lookup request");
      }
      await latestReply.scrollIntoViewIfNeeded();
      await expect.soft(latestReply.getByRole("table")).toHaveCount(scenario.tables);
      await page.screenshot({ path: test.info().outputPath(`live-${scenario.name}-desktop.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`live-${scenario.name}-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 720 });
      const settled = evidence();
      await page.reload();
      await latestReply.scrollIntoViewIfNeeded();
      await expect.soft(latestReply.getByRole("table")).toHaveCount(scenario.tables);
      await expect(ask).toBeEnabled();
      expect(evidence()).toEqual(settled);
    }
    expect(errors).toEqual([]);
    expect([...snapshots.values()].every((item) => item.status === "complete" && item.error_code === null)).toBe(true);
  } finally {
    const summaryPath = test.info().outputPath("live-summary.json");
    writeFileSync(summaryPath, JSON.stringify({ page_errors: errors,
      snapshots: [...snapshots.values()].map((item) => ({ status: item.status, error_code: item.error_code,
        source: item.source, answer: item.fallback_text, usage: item.usage,
        selected_records: Object.values(item.tables ?? {}).map((table) => table.rows.map((row) => row.id)) })),
    }, null, 2));
    await test.info().attach("live-summary", { contentType: "application/json", path: summaryPath });
    await test.info().attach("live-provider-calls", { path: process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!,
      contentType: "application/json" });
  }
});

test("live model offers a title form and confirms its saved result without another model call", async ({ page }) => {
  test.setTimeout(180_000);
  const evidence = () => JSON.parse(readFileSync(process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!, "utf8")) as Evidence;
  const frames: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => frames.push(JSON.parse(String(payload)))));
  await page.goto("/browser/openui-gateway.html");
  await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
  const before = evidence();
  await page.getByRole("textbox", { name: "Question", exact: true }).fill(
    "把这条会话改名为“交互开发计划”，先给我一个可以编辑标题的表单，预览并确认后再保存。请用中文回答。",
  );
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const form = page.locator("[data-assistant-message]").last().getByRole("form");
  const input = form.getByRole("textbox");
  await expect(input).toHaveValue("交互开发计划", { timeout: 90_000 });
  await expect(form.getByRole("button", { name: "Review change", exact: true })).toBeEnabled();
  const generated = evidence();
  expect(generated.calls.length).toBeGreaterThan(before.calls.length);
  expect(generated.tools).toEqual(before.tools);
  await input.fill("交互开发验收计划");
  await form.getByRole("button", { name: "Review change", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm rename", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Conversation title", { exact: true })).not.toHaveText("交互开发验收计划");
  await page.screenshot({ path: test.info().outputPath("live-rename-review.png"), fullPage: true });
  await form.getByRole("button", { name: "Confirm rename", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText('Renamed to “交互开发验收计划”.');
  await expect(page.getByLabel("Conversation title", { exact: true })).toHaveText("交互开发验收计划");
  await form.getByRole("button", { name: "Check result", exact: true }).click();
  await expect.poll(() => frames.filter((frame) => frame.action === "openui.rename").length).toBe(3);
  expect(evidence()).toEqual(generated);
  expect(frames.filter((frame) => frame.type === "message")).toHaveLength(1);
  await page.reload();
  await expect(input).toHaveValue("交互开发验收计划");
  await expect(input).toBeDisabled();
  await expect(page.getByLabel("Conversation title", { exact: true })).toHaveText("交互开发验收计划");
  expect(evidence()).toEqual(generated);
  expect(frames.filter((frame) => frame.action === "openui.rename")).toHaveLength(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("live-rename-restored-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("live model creates, revises and confirms a conditional questionnaire without replay", async ({ page }) => {
  test.setTimeout(360_000);
  const evidence = () => JSON.parse(readFileSync(process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!, "utf8")) as Evidence;
  const snapshots = new Map<string, UiSnapshot>();
  const messages: Record<string, unknown>[] = [];
  const errors: string[] = [];
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
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Delete conversation", exact: true }).click()]);
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
    snapshots.clear();
    const before = evidence();
    const ask = page.getByRole("button", { name: "Ask", exact: true });
    const latestReply = page.locator("[data-assistant-message]").last();
    await page.getByRole("textbox", { name: "Question", exact: true }).fill(
      "请生成一份可直接填写的“项目需求调查表”，只包含以下字段，标签和选项保持原文："
      + "项目代号（文本）；交付形式（单选：演示、文档、其他）；其他交付说明（仅选其他时显示）；"
      + "重点关注（多选：易用性、可靠性、其他）；补充说明（仅重点关注选其他时显示）。"
      + "所有可见字段必填。这些都是虚构的公开项目资料，允许保存所有字段的草稿以便刷新后继续填写，不要预填答案。"
      + "提交后请复述我的答案，再让我选择“修改需求”或“确认需求”。确认后只总结此项目的代号和下一步，不执行任何业务操作。请全程用中文回答，不调用工具。",
    );
    await ask.click();
    const survey = page.getByRole("form", { name: "项目需求调查表", exact: true }).first();
    const submit = survey.getByRole("button", { name: "Submit answers", exact: true });
    const code = survey.getByRole("textbox", { name: "项目代号", exact: true });
    const delivery = survey.getByRole("group", { name: "交付形式", exact: true });
    const focus = survey.getByRole("group", { name: "重点关注", exact: true });
    const detail = survey.getByRole("textbox", { name: "补充说明", exact: true });
    await expect(survey).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => [...snapshots.values()].filter((item) => item.status === "complete").length,
      { timeout: 60_000 }).toBe(1);
    await expect(latestReply.getByRole("form")).toHaveCount(1);
    await expect(code).toHaveValue("");
    await expect(submit).toBeDisabled();
    const original = latestReply.locator("details");
    await expect(original).toHaveCount(1);
    await expect(original).not.toHaveAttribute("open");
    await expect(survey.getByRole("textbox", { name: "其他交付说明", exact: true })).toHaveCount(0);
    await expect(detail).toHaveCount(0);
    const generated = evidence();

    await code.fill("LANTERN-2026");
    await delivery.getByRole("radio", { name: "其他", exact: true }).check();
    await survey.getByRole("textbox", { name: "其他交付说明", exact: true }).fill("WITHDRAWN-702");
    await delivery.getByRole("radio", { name: "文档", exact: true }).check();
    await expect(survey.getByRole("textbox", { name: "其他交付说明", exact: true })).toHaveCount(0);
    await focus.getByRole("checkbox", { name: "易用性", exact: true }).check();
    await focus.getByRole("checkbox", { name: "可靠性", exact: true }).check();
    await focus.getByRole("checkbox", { name: "其他", exact: true }).check();
    await detail.fill("WITHDRAWN-913");
    await focus.getByRole("checkbox", { name: "其他", exact: true }).uncheck();
    await expect(detail).toHaveCount(0);
    await focus.getByRole("checkbox", { name: "其他", exact: true }).check();
    await expect(detail).toHaveValue("");
    await expect(submit).toBeDisabled();
    await detail.fill("支持键盘操作");
    await expect(submit).toBeEnabled();
    await expect.poll(() => [...snapshots.values()][0]?.state.$forms).toMatchObject({ "form-0": {
      status: "draft", values: expect.arrayContaining(["LANTERN-2026", "文档", ["易用性", "可靠性", "其他"], "支持键盘操作"]),
    } });
    expect(JSON.stringify([...snapshots.values()][0].state.$forms)).not.toContain("WITHDRAWN");
    expect(evidence()).toEqual(generated);
    expect(messages).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath("live-questionnaire-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("live-questionnaire-mobile.png"), fullPage: true });
    await page.reload();
    await expect(code).toHaveValue("LANTERN-2026");
    await expect(delivery.getByRole("radio", { name: "文档", exact: true })).toBeChecked();
    for (const option of ["易用性", "可靠性", "其他"]) await expect(focus.getByRole("checkbox", { name: option, exact: true })).toBeChecked();
    await expect(detail).toHaveValue("支持键盘操作");
    await expect(survey.getByRole("textbox", { name: "其他交付说明", exact: true })).toHaveCount(0);
    await expect(ask).toBeEnabled();
    await page.waitForTimeout(1_000);
    expect(evidence()).toEqual(generated);
    expect(messages).toHaveLength(1);
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");

    await submit.dblclick();
    const confirm = page.getByRole("button", { name: "确认需求", exact: true }).last();
    await expect(confirm).toBeVisible({ timeout: 90_000 });
    await expect(latestReply.getByRole("button", { name: "修改需求", exact: true })).toBeVisible();
    await expect(latestReply).toContainText("LANTERN-2026");
    await expect(latestReply).toContainText("文档");
    await expect(latestReply).toContainText("支持键盘操作");
    await expect(survey.getByRole("status")).toHaveText("Submitted");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ chat_id: "gateway-poc", ui_mode: "auto", ui_action: {
      action_id: "conversation.followup", form_id: "form-0", request_id: messages[1].turn_id,
    } });
    const content = String(messages[1].content);
    for (const value of ["项目代号: LANTERN-2026", "交付形式: 文档", "重点关注: 易用性, 可靠性, 其他", "补充说明: 支持键盘操作"]) expect(content).toContain(value);
    expect(content).not.toContain("其他交付说明");
    expect(content).not.toContain("WITHDRAWN");
    const submitted = evidence();
    await page.reload();
    await expect(confirm).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(survey.getByRole("status")).toHaveText("Submitted");
    await expect(ask).toBeEnabled();
    await page.waitForTimeout(1_000);
    expect(evidence()).toEqual(submitted);
    expect(messages).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath("live-questionnaire-submitted-mobile.png"), fullPage: true });
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");

    const originalBlock = [...snapshots.values()][0];
    const previousBlocks = new Set(snapshots.keys());
    await page.getByRole("button", { name: "修改需求", exact: true }).last().click();
    const revised = page.locator("[data-assistant-message]").getByRole("form").last();
    const revisedCode = revised.getByRole("textbox", { name: "项目代号", exact: true });
    const revisedDelivery = revised.getByRole("group", { name: "交付形式", exact: true });
    const revisedFocus = revised.getByRole("group", { name: "重点关注", exact: true });
    const revisedDetail = revised.getByRole("textbox", { name: "补充说明", exact: true });
    const revisedSubmit = revised.getByRole("button", { name: "Submit answers", exact: true });
    await expect(revisedCode).toHaveValue("LANTERN-2026", { timeout: 90_000 });
    await expect.poll(() => [...snapshots.values()].filter((item) => !previousBlocks.has(item.block_id)
      && item.status === "complete").length, { timeout: 60_000 }).toBe(1);
    await expect(latestReply.getByRole("form")).toHaveCount(1);
    await expect(revisedSubmit).toBeEnabled();
    await expect(revisedDelivery.getByRole("radio", { name: "文档", exact: true })).toBeChecked();
    for (const option of ["易用性", "可靠性", "其他"]) await expect(revisedFocus.getByRole("checkbox", { name: option, exact: true })).toBeChecked();
    await expect(revisedDetail).toHaveValue("支持键盘操作");
    const revisedBlock = [...snapshots.values()].find((item) => !previousBlocks.has(item.block_id))!;
    expect(messages).toHaveLength(3);
    const editing = evidence();
    await expect(submit).toBeDisabled();

    await revisedDelivery.getByRole("radio", { name: "其他", exact: true }).check();
    await expect(revised.getByRole("textbox", { name: "其他交付说明", exact: true })).toHaveValue("");
    await revised.getByRole("textbox", { name: "其他交付说明", exact: true }).fill("WITHDRAWN-REVISION");
    await revisedDelivery.getByRole("radio", { name: "演示", exact: true }).check();
    await revisedFocus.getByRole("checkbox", { name: "其他", exact: true }).uncheck();
    await expect(revisedDetail).toHaveCount(0);
    await revisedFocus.getByRole("checkbox", { name: "其他", exact: true }).check();
    await expect(revisedDetail).toHaveValue("");
    await expect(revisedSubmit).toBeDisabled();
    await revisedFocus.getByRole("checkbox", { name: "其他", exact: true }).uncheck();
    await revisedFocus.getByRole("checkbox", { name: "易用性", exact: true }).uncheck();
    await revisedCode.fill("LANTERN-2026-R2");
    await expect.poll(() => snapshots.get(revisedBlock.block_id)?.state.$forms).toMatchObject({ "form-0": {
      status: "draft", values: expect.arrayContaining(["LANTERN-2026-R2", "演示", ["可靠性"]]),
    } });
    await page.screenshot({ path: test.info().outputPath("live-questionnaire-revision-mobile.png"), fullPage: true });
    await page.reload();
    await expect(revisedCode).toHaveValue("LANTERN-2026-R2");
    await expect(revisedDelivery.getByRole("radio", { name: "演示", exact: true })).toBeChecked();
    await expect(revisedFocus.getByRole("checkbox", { name: "可靠性", exact: true })).toBeChecked();
    await expect(revisedFocus.getByRole("checkbox", { name: "其他", exact: true })).not.toBeChecked();
    await expect(revisedDetail).toHaveCount(0);
    await expect(ask).toBeEnabled();
    expect(evidence()).toEqual(editing);
    expect(messages).toHaveLength(3);
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
    await revisedSubmit.dblclick();
    await expect(latestReply.getByRole("button", { name: "确认需求", exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(latestReply).toContainText("LANTERN-2026-R2");
    await expect(latestReply).toContainText("演示");
    await expect(revised.getByRole("status")).toHaveText("Submitted");
    expect(messages).toHaveLength(4);
    expect(messages[3]).toMatchObject({ ui_action: { block_id: revisedBlock.block_id, form_id: "form-0",
      request_id: messages[3].turn_id } });
    expect(messages[3].turn_id).not.toBe(messages[1].turn_id);
    const revisionContent = String(messages[3].content);
    for (const value of ["项目代号: LANTERN-2026-R2", "交付形式: 演示", "重点关注: 可靠性"]) expect(revisionContent).toContain(value);
    for (const value of ["补充说明", "其他交付说明", "支持键盘操作", "WITHDRAWN"]) expect(revisionContent).not.toContain(value);
    expect(snapshots.get(originalBlock.block_id)).toEqual(originalBlock);
    const revisedSubmission = evidence();
    await page.reload();
    await expect(confirm).toBeVisible();
    await expect(revisedSubmit).toBeDisabled();
    await expect(ask).toBeEnabled();
    await page.waitForTimeout(1_000);
    expect(evidence()).toEqual(revisedSubmission);
    expect(messages).toHaveLength(4);
    await page.screenshot({ path: test.info().outputPath("live-questionnaire-revised-submitted-mobile.png"), fullPage: true });
    await page.getByRole("combobox", { name: "Interactive replies" }).selectOption("auto");
    await confirm.click();
    await expect.poll(() => evidence().runs.length, { timeout: 90_000 }).toBe(before.runs.length + 5);
    await expect(ask).toBeEnabled();
    await expect(latestReply).toContainText("LANTERN-2026-R2");
    await expect.poll(() => [...snapshots.values()].every((item) => item.status === "complete"), { timeout: 60_000 }).toBe(true);
    expect(messages).toHaveLength(5);
    expect(messages.every((message) => message.chat_id === "gateway-poc" && message.ui_mode === "auto")).toBe(true);
    expect(evidence().tools).toEqual(before.tools);
    expect(evidence().runs.slice(before.runs.length).every((run) => !run.error)).toBe(true);
    expect(evidence().calls.slice(before.calls.length).every((call) => call.finish_reason !== "error" && call.error_status_code === null)).toBe(true);
    expect([...snapshots.values()].every((item) => item.status === "complete" && item.error_code === null)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    const summaryPath = test.info().outputPath("live-questionnaire-summary.json");
    writeFileSync(summaryPath, JSON.stringify({ page_errors: errors, sent_messages: messages,
      snapshots: [...snapshots.values()].map((item) => ({ status: item.status, error_code: item.error_code,
        source: item.source, answer: item.fallback_text, usage: item.usage, state: item.state })),
    }, null, 2));
    await test.info().attach("live-questionnaire-summary", { contentType: "application/json", path: summaryPath });
    await test.info().attach("live-provider-calls", { path: process.env.NANOBOT_OPENUI_LIVE_EVIDENCE!, contentType: "application/json" });
  }
});

