import { z } from "zod";
const cell = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
export const displayTableSchema = z.object({
  data_ref: z.string().min(1).max(128), title: z.string().min(1).max(320),
  columns: z.record(z.string().max(256), z.string().max(320)).refine((value) => Object.keys(value).length <= 8),
  rows: z.array(z.object({ id: z.string().min(1).max(256), values: z.record(z.string(), cell) }).strict()).max(50),
  source_tool: z.string(), source_call_id: z.string(), captured_at: z.number().finite(), total_rows: z.number().int().nonnegative().optional(),
  session_query: z.object({ query: z.string().min(1).max(500), exclude_session_key: z.string().min(1).max(512) }).strict().nullable().optional(),
}).strict();
export const sessionDetailSchema = z.object({
  title: z.string().max(160),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8004) }).strict()).max(8),
}).strict();
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export interface DataQuery { data_ref: string; operation: "refresh" | "detail"; record_id?: string }
export type DisplayTable = z.infer<typeof displayTableSchema>;
export const displayTablesSchema = z.record(z.string(), displayTableSchema).refine((value) =>
  Object.keys(value).length <= 4 && Object.entries(value).every(([key, table]) => key === table.data_ref)
    && new TextEncoder().encode(JSON.stringify(value)).length <= 68 * 1024);
