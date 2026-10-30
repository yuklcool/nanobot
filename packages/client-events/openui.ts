/** Optional OpenUI capability and action metadata. No UI/runtime dependencies. */
export type OpenUIMode = "markdown" | "openui" | "auto";
export interface OpenUICapability { protocol: 1; library_hash: string; modes?: OpenUIMode[]; form_recovery?: boolean }
export interface OpenUIAction {
  session_generation: string;
  block_id: string;
  revision: number;
  request_id: string;
  action_id: "conversation.followup" | "record.analyze";
  data_ref?: string;
  record_id?: string;
  form_id?: string;
}
export function openUICapability(value: unknown): OpenUICapability | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  return data.protocol === 1 && typeof data.library_hash === "string" && /^[a-f0-9]{64}$/.test(data.library_hash)
    ? { protocol: 1, library_hash: data.library_hash,
      ...(data.form_recovery === true ? { form_recovery: true } : {}),
      ...(Array.isArray(data.modes) && data.modes.length <= 8 && data.modes.every((mode) => typeof mode === "string")
        ? { modes: data.modes.filter((mode): mode is OpenUIMode => mode === "markdown" || mode === "openui" || mode === "auto") } : {}),
    } : null;
}
