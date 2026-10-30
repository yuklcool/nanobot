/** Optional OpenUI capability and action metadata. No UI/runtime dependencies. */
export interface OpenUICapability { protocol: 1; library_hash: string }
export interface OpenUIAction {
  session_generation: string;
  block_id: string;
  revision: number;
  request_id: string;
  action_id: "conversation.followup";
}
export function openUICapability(value: unknown): OpenUICapability | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  return data.protocol === 1 && typeof data.library_hash === "string" && /^[a-f0-9]{64}$/.test(data.library_hash)
    ? { protocol: 1, library_hash: data.library_hash } : null;
}
