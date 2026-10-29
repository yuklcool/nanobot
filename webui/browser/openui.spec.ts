import { expect, test } from "@playwright/test";

test("streams real SDK components, restores state, and sends a same-chat intent without replay", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.routeWebSocket("**/openui-poc-socket", (socket) => {
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "attach") socket.send(JSON.stringify({ event: "attached", chat_id: frame.chat_id }));
      if (frame.type === "message") sent.push(frame);
    });
  });
  await page.goto("/browser/openui.html");
  await page.getByRole("button", { name: "Advance stream" }).click();
  await expect(page.getByText("Task 08 is ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Advance stream" }).click();
  const select = page.getByRole("combobox", { name: "Period" });
  const inspect = page.getByRole("button", { name: "Inspect task", exact: true });
  await expect(select).toBeDisabled();
  await expect(inspect).toBeDisabled();
  expect(sent).toHaveLength(0);
  await page.getByRole("button", { name: "Advance stream" }).click();
  await expect(select).toBeEnabled();
  await select.selectOption("30");
  await expect(select).toHaveValue("30");
  await page.reload();
  await expect(select).toHaveValue("30");
  expect(sent).toHaveLength(0);
  await inspect.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ chat_id: "openui-poc", content: "Inspect task task_08 for 30 days." });
  expect(sent[0].turn_id).toEqual(expect.any(String));
  await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Inspect task task_08 for 30 days.");
  await page.reload();
  await expect(select).toHaveValue("30");
  expect(sent).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("unsupported component degrades to original text", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.routeWebSocket("**/openui-poc-socket", () => {});
  await page.goto("/browser/openui.html");
  await page.getByRole("button", { name: "Invalid source" }).click();
  await expect(page.getByRole("status").filter({ hasText: "text fallback" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect task", exact: true })).toHaveCount(0);
});
