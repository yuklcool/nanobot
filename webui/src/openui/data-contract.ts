import { z } from "zod";
const cell = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
export const displayTableSchema = z.object({
  data_ref: z.string().min(1).max(128), title: z.string().min(1).max(320),
  columns: z.record(z.string().max(256), z.string().max(320)).refine((value) => Object.keys(value).length <= 8),
  rows: z.array(z.object({ id: z.string().min(1).max(256), values: z.record(z.string(), cell) }).strict()).max(50),
  source_tool: z.string(), source_call_id: z.string(), captured_at: z.number().finite(), total_rows: z.number().int().nonnegative().optional(),
}).strict();
export type DisplayTable = z.infer<typeof displayTableSchema>;
export const displayTablesSchema = z.record(z.string(), displayTableSchema).refine((value) =>
  Object.keys(value).length <= 4 && Object.entries(value).every(([key, table]) => key === table.data_ref)
    && new TextEncoder().encode(JSON.stringify(value)).length <= 68 * 1024);
