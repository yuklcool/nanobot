import { expect, it } from "vitest";
import { formComplete, formDefinitionSchema, normalizeFormValues, type FormField } from "../../openui/form-contract";

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
