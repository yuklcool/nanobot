import { z } from "zod";

const id = z.string().min(1).max(128);
const bytes = (value: string) => new TextEncoder().encode(value).length;

// Mirrors UiSnapshot's wire shape. Identity must come from the attached host,
// never from whatever session happens to be visible when an event arrives.
export const uiSnapshotSchema = z.object({
  schema_version: z.literal(1),
  chat_id: id,
  session_generation: id,
  turn_id: id,
  block_id: id,
  revision: z.number().int().min(1),
  seq: z.number().int().min(0),
  library_hash: id,
  status: z.enum(["streaming", "complete", "failed", "cancelled", "superseded"]),
  source: z.string().refine((value) => bytes(value) <= 128 * 1024),
  state: z.record(z.string(), z.json()).refine((value) => bytes(JSON.stringify(value)) <= 16 * 1024),
  state_version: z.number().int().min(0),
}).strict();

export type UiSnapshot = z.infer<typeof uiSnapshotSchema>;
export type UiIdentity = Pick<UiSnapshot, "chat_id" | "session_generation" | "block_id" | "library_hash">;

/** Snapshots recover gaps; deltas must be handled separately, in contiguous order. */
export function acceptSnapshot(
  current: UiSnapshot | null, incoming: unknown, identity: UiIdentity,
): UiSnapshot | null {
  const result = uiSnapshotSchema.safeParse(incoming);
  if (!result.success) return current;
  const next = result.data;
  if (next.chat_id !== identity.chat_id || next.session_generation !== identity.session_generation
    || next.block_id !== identity.block_id || next.library_hash !== identity.library_hash) return current;
  if (current) {
    if (next.turn_id !== current.turn_id || next.revision < current.revision) return current;
    if (next.revision === current.revision) {
      if (next.seq < current.seq || next.state_version < current.state_version) return current;
      // State saves may follow completion, but the completed source is immutable.
      if (current.status !== "streaming"
        && (next.source !== current.source || next.status !== current.status || next.seq !== current.seq)) return current;
      if (next.seq === current.seq && (next.source !== current.source || next.status !== current.status)) return current;
      if (next.seq === current.seq && next.state_version === current.state_version) return current;
    }
  }
  return next;
}

const deltaSchema = z.object({
  chat_id: id, session_generation: id, block_id: id, revision: z.number().int().min(1),
  seq: z.number().int().min(1), delta: z.string().min(1),
}).strict();

export function applyDelta(current: UiSnapshot, incoming: unknown): {
  snapshot: UiSnapshot; needsSnapshot: boolean;
} {
  const result = deltaSchema.safeParse(incoming);
  if (!result.success) return { snapshot: current, needsSnapshot: false };
  const next = result.data;
  if (next.chat_id !== current.chat_id || next.session_generation !== current.session_generation
    || next.block_id !== current.block_id || next.revision !== current.revision
    || current.status !== "streaming" || next.seq <= current.seq) {
    return { snapshot: current, needsSnapshot: false };
  }
  if (next.seq !== current.seq + 1) return { snapshot: current, needsSnapshot: true };
  const updated = uiSnapshotSchema.safeParse({ ...current, seq: next.seq, source: current.source + next.delta });
  return updated.success
    ? { snapshot: updated.data, needsSnapshot: false }
    : { snapshot: current, needsSnapshot: true };
}
