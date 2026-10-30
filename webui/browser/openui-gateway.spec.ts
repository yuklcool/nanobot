import { expect, test } from "@playwright/test";

test.skip(!process.env.NANOBOT_OPENUI_GATEWAY_PYTHON, "Requires the disposable native Gateway; run test:openui:gateway.");
test("native model adapter, captured data, record actions and refresh recovery", async ({ page }) => {
  const errors: string[] = [];
  const messages: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "message") messages.push(frame);
  }));
  await page.goto("/browser/openui-gateway.html");
  await page.getByText("Interactive replies", { exact: true }).click();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const followup = page.getByRole("textbox", { name: "Follow-up question" });
  await expect(followup).toBeVisible();
  await expect(followup).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Lookup result 1");
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
  await page.getByText("Interactive replies", { exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Lookup result 2");
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ chat_id: "gateway-poc", content: "Look up again", ui_action: {
    action_id: "conversation.followup", request_id: messages[1].turn_id,
  } });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(2);
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Lookup result 2");
  expect(messages).toHaveLength(2);
  await page.getByRole("button", { name: "Analyze snapshot", exact: true }).first().click();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Lookup result 3");
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ chat_id: "gateway-poc", ui_action: {
    action_id: "record.analyze", record_id: "task_08", request_id: messages[2].turn_id,
  } });
  expect(String(messages[2].content)).toContain('"energy":5412.5');
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Interactive replies" })).toBeAttached();
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Conversation" })).not.toContainText("Lookup result 1");
  await page.getByText("Interactive replies", { exact: true }).click();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Lookup result 4");
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
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await page.getByText("Interactive replies", { exact: true }).click();
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("Plan a small project");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("group", { name: "Where should we start?" })).toBeVisible();
  await expect(page.getByText("We can define a new project or review an existing draft.", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(0);
  expect(messages).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("inline-choices-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Define the project", exact: true }).click();
  const form = page.getByRole("form", { name: "Project details" });
  await expect(form).toBeVisible();
  const submit = form.getByRole("button", { name: "Send", exact: true });
  await expect(submit).toBeDisabled();
  await form.getByRole("textbox", { name: "Project name" }).fill("Nanobot interaction");
  await form.getByRole("combobox", { name: "Priority" }).selectOption("High");
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("inline-form-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("inline-form-mobile.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.classList.add("dark"); });
  await page.screenshot({ path: test.info().outputPath("inline-form-mobile-dark.png"), fullPage: true });
  await submit.click();
  await expect(page.getByRole("button", { name: "Confirm plan", exact: true })).toBeVisible();
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ content: "Project details\nProject name: Nanobot interaction\nPriority: High",
    ui_action: { action_id: "conversation.followup", request_id: messages[2].turn_id } });
  await page.getByRole("button", { name: "Confirm plan", exact: true }).click();
  await expect(page.getByText("Confirmed. We can now prepare the plan in this conversation.", { exact: true })).toBeVisible();
  expect(messages).toHaveLength(4);
  expect(messages[3]).toMatchObject({ content: "Confirm the proposed project plan.", ui_action: {
    action_id: "conversation.followup", request_id: messages[3].turn_id,
  } });
  await page.reload();
  await expect(page.getByText("Confirmed. We can now prepare the plan in this conversation.", { exact: true })).toBeVisible();
  expect(messages).toHaveLength(4);
  expect(errors).toEqual([]);
});
