import { z } from "zod";

export const MAX_FORM_OPTIONS = 50;
export const formValueSchema = z.union([z.string().max(400), z.array(z.string().min(1).max(120)).max(MAX_FORM_OPTIONS)]);
export type FormValue = z.infer<typeof formValueSchema>;
export const formFieldSchema = z.object({
  label: z.string().min(1).max(80), placeholder: z.string().max(120).optional(),
  options: z.array(z.string().min(1).max(120)).min(2).max(MAX_FORM_OPTIONS).optional(),
  persist: z.boolean().optional(), required: z.boolean().optional(),
  type: z.enum(["text", "number", "date", "select", "radio", "checkbox"]).optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(),
  initial: formValueSchema.optional(),
  when: z.object({ field: z.number().int().min(0).max(11), value: z.string().min(1).max(120) }).optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;
export const formDefinitionSchema = z.object({
  title: z.string().min(1).max(160), fields: z.array(formFieldSchema).min(1).max(12),
  description: z.string().max(600).optional(), presentation: z.enum(["inline", "questionnaire"]).optional(),
  action: z.object({ type: z.literal("session.rename"), title: z.string().trim().min(1).max(160) }).optional(),
}).superRefine(({ fields, action }, context) => {
  if (action && (fields.length !== 1 || fields[0].options || fields[0].when
    || fields[0].required === false || (fields[0].type && fields[0].type !== "text")))
    context.addIssue({ code: "custom", path: ["action"], message: "Rename needs one required text field" });
  fields.forEach((field, index) => {
    if ((field.type === "text" || field.type === "number" || field.type === "date") && field.options)
      context.addIssue({ code: "custom", path: ["fields", index], message: "Text fields cannot have options" });
    if (((field.min !== undefined || field.max !== undefined) && field.type !== "number")
      || (field.min !== undefined && field.max !== undefined && field.min > field.max))
      context.addIssue({ code: "custom", path: ["fields", index], message: "Invalid numeric bounds" });
    if ((field.type === "radio" || field.type === "checkbox" || field.type === "select") && !field.options)
      context.addIssue({ code: "custom", path: ["fields", index], message: "Choice fields need options" });
    if (field.when && (field.when.field >= index || !fields[field.when.field]?.options?.includes(field.when.value)))
      context.addIssue({ code: "custom", path: ["fields", index], message: "Conditions must refer to an earlier choice" });
    if (field.options && new Set(field.options).size !== field.options.length)
      context.addIssue({ code: "custom", path: ["fields", index], message: "Options must be distinct" });
    if (field.initial !== undefined && (!field.persist
      || !formComplete([{ ...field, required: false, when: undefined }], [field.initial])))
      context.addIssue({ code: "custom", path: ["fields", index, "initial"], message: "Initial answers need persistence consent and valid values" });
  });
});
export const formInputSchema = formDefinitionSchema.safeExtend({
  form_id: z.string().regex(/^form-[0-5]$/), values: z.array(formValueSchema).min(1).max(12), submit: z.boolean(),
});
export type FormInput = z.infer<typeof formInputSchema>;
export const formStateSchema = z.object({
  schema: z.string(), values: z.array(formValueSchema).max(12),
  status: z.enum(["draft", "prepared", "unknown", "submitted"]),
  request_id: z.string().optional(), content_digest: z.string().optional(),
});
export type FormState = z.infer<typeof formStateSchema>;
export const emptyFormValue = (field: FormField): FormValue => field.type === "checkbox" ? [] : "";
export function initialFormValues(fields: FormField[]): FormValue[] {
  return normalizeFormValues(fields, fields.map((field) => field.initial ?? emptyFormValue(field)));
}
export function visibleFields(fields: FormField[], values: FormValue[]): boolean[] {
  const visible: boolean[] = [];
  fields.forEach((field) => {
    const condition = field.when;
    const value = condition ? values[condition.field] : undefined;
    visible.push(!condition || (visible[condition.field] && (Array.isArray(value)
      ? value.includes(condition.value) : value === condition.value)));
  });
  return visible;
}
export function normalizeFormValues(fields: FormField[], values: FormValue[], draft = false): FormValue[] {
  const retained = fields.map((field, index) => draft && !field.persist ? emptyFormValue(field) : values[index] ?? emptyFormValue(field));
  const visible = visibleFields(fields, retained);
  return fields.map((field, index) => {
    if (!visible[index]) return emptyFormValue(field);
    const value = retained[index];
    // Canonical option order makes identical checkbox selections the same action.
    return Array.isArray(value) ? (field.options ?? []).filter((option) => value.includes(option)) : value;
  });
}
export function formComplete(fields: FormField[], values: FormValue[]): boolean {
  const visible = visibleFields(fields, values);
  return fields.every((field, index) => {
    if (!visible[index]) return true;
    const value = values[index] ?? emptyFormValue(field);
    if (field.type === "checkbox") return Array.isArray(value) && new Set(value).size === value.length
      && (field.required === false || value.length > 0) && value.every((option) => field.options?.includes(option));
    return typeof value === "string" && (field.required === false || Boolean(value.trim()))
      && (!value || !field.options || field.options.includes(value)) && fieldScalarValid(field, value);
  });
}
function fieldScalarValid(field: FormField, value: string): boolean {
  if (!value) return true;
  if (field.type === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return false;
    const number = Number(value);
    return Number.isFinite(number) && (field.min === undefined || number >= field.min)
      && (field.max === undefined || number <= field.max);
  }
  if (field.type === "date") return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
    && !value.startsWith("0000") && !Number.isNaN(Date.parse(value + "T00:00:00Z"))
    && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  return true;
}
export function formContent(form: Pick<FormInput, "title" | "fields" | "values">): string {
  const visible = visibleFields(form.fields, form.values);
  return [form.title, ...form.fields.flatMap((field, index) => {
    if (!visible[index]) return [];
    const value = form.values[index] ?? emptyFormValue(field);
    return [`${field.label}: ${Array.isArray(value) ? value.join(", ") : value.trim()}`];
  })].join("\n");
}
