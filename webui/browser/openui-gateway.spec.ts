import { expect, test } from "@playwright/test";

test.skip(!process.env.NANOBOT_OPENUI_GATEWAY_PYTHON, "Requires the disposable native Gateway; run test:openui:gateway.");
test("native tools, structured follow-up and server-side refresh recovery", async ({ page }) => {
  const errors: string[] = [];
  const messages: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "message") messages.push(frame);
  }));
  await page.goto("/browser/openui-gateway.html");
  await page.getByRole("checkbox", { name: "Interactive view (preview)" }).check();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const followup = page.getByRole("textbox", { name: "Follow-up question" });
  await expect(followup).toBeVisible();
  await expect(followup).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Lookup result 1");
  await followup.fill("Look up again");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await page.reload();
  await expect(followup).toHaveValue("Look up again");
  expect(messages).toHaveLength(1);
  await page.getByRole("checkbox", { name: "Interactive view (preview)" }).check();
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
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Interactive view (preview)" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Conversation" })).not.toContainText("Lookup result 1");
  await page.getByRole("checkbox", { name: "Interactive view (preview)" }).check();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Lookup result 3");
  await expect(page.getByRole("textbox", { name: "Follow-up question" })).toHaveCount(1);
  expect(messages).toHaveLength(3);
  expect(errors).toEqual([]);
});
