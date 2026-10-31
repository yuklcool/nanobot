import { expect, it } from "vitest";
import { formComplete, formDefinitionSchema, normalizeFormValues, type FormField } from "../../openui/form-contract";

it("limits the registered rename action to one required title field", () => {
  const form = { title: "Rename", fields: [{ label: "New title", type: "text" }],
    action: { type: "session.rename", title: "Project plan" } };
  expect(formDefinitionSchema.safeParse(form).success).toBe(true);
  expect(formDefinitionSchema.safeParse({ ...form, action: { ...form.action, title: " " } }).success).toBe(false);
  expect(formDefinitionSchema.safeParse({ ...form, fields: [{ label: "Pick", options: ["A", "B"] }] }).success).toBe(false);
  expect(formDefinitionSchema.safeParse({ ...form, fields: [...form.fields, ...form.fields] }).success).toBe(false);
});

it("persists only authorized draft values whose conditions survive privacy filtering", () => {
  const fields: FormField[] = [
    { label: "Personal choice", type: "radio", options: ["Yes", "No"] },
    { label: "Dependent note", persist: true, when: { field: 0, value: "Yes" } },
    { label: "Project scope", type: "checkbox", options: ["API", "UI"], persist: true },
    { label: "Optional comment", required: false },
  ];
  expect(normalizeFormValues(fields, ["Yes", "Private context", ["UI", "API"], ""], true)).toEqual(["", "", ["API", "UI"], ""]);
  expect(formComplete(fields, ["No", "", ["UI"], ""])).toBe(true);
  expect(formComplete(fields, ["Yes", "", ["UI"], ""])).toBe(false);
});

it("validates choice definitions and dependencies before replacing the original questionnaire", () => {
  const fields = [
    { label: "Choice", type: "radio", options: ["Yes", "No"] },
    { label: "Reason", when: { field: 0, value: "Yes" } },
  ];
  expect(formDefinitionSchema.safeParse({ title: "Survey", fields }).success).toBe(true);
  expect(formDefinitionSchema.safeParse({ title: "Survey", fields: [fields[0], { ...fields[1], when: { field: 1, value: "Yes" } }] }).success).toBe(false);
  expect(formDefinitionSchema.safeParse({ title: "Survey", fields: [{ ...fields[0], options: ["Yes", "Yes"] }] }).success).toBe(false);
});

it("accepts retained initial answers and rejects unconsented or invalid choice values", () => {
  const definition = (field: object) => formDefinitionSchema.safeParse({ title: "Revise", fields: [field] }).success;
  expect(definition({ label: "Project", persist: true, initial: "Existing" })).toBe(true);
  expect(definition({ label: "Scope", persist: true, type: "checkbox", options: ["API", "UI"], initial: ["UI"] })).toBe(true);
  expect(definition({ label: "Private detail", initial: "Do not retain" })).toBe(false);
  expect(definition({ label: "Project", persist: true, initial: ["Wrong type"] })).toBe(false);
  expect(definition({ label: "Scope", persist: true, type: "checkbox", options: ["API", "UI"], initial: ["Other"] })).toBe(false);
  expect(definition({ label: "Scope", persist: true, type: "checkbox", options: ["API", "UI"], initial: ["UI", "UI"] })).toBe(false);
});
