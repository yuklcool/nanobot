import { Component, useCallback, useState, type ReactNode } from "react";
import { Renderer, type OpenUIError } from "@openuidev/react-lang";
import { POC_LIBRARY_ID, pocLibrary, UiInteractionContext } from "./poc-library";
import type { UiSnapshot } from "./snapshot";

class RenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

interface Props {
  snapshot: UiSnapshot;
  fallbackText: string;
  onAction: (event: unknown) => void;
  onStateUpdate: (state: Record<string, unknown>) => void;
}

function Content({ snapshot, fallbackText, onAction, onStateUpdate }: Props) {
  const [parseFailed, setParseFailed] = useState(false);
  const onError = useCallback((errors: OpenUIError[]) => {
    setParseFailed(errors.some((error) => error.severity !== "warning"));
  }, []);
  const fallback = <p role="status">{fallbackText}</p>;
  if (snapshot.library_hash !== POC_LIBRARY_ID
    || (snapshot.status !== "streaming" && snapshot.status !== "complete")) return fallback;
  const editable = snapshot.status === "complete" && !parseFailed;
  return <RenderBoundary fallback={fallback}>
    <UiInteractionContext.Provider value={editable}>
      {parseFailed && snapshot.status === "complete" && fallback}
      <div hidden={parseFailed && snapshot.status === "complete"} aria-busy={snapshot.status === "streaming"}>
        <Renderer library={pocLibrary} response={snapshot.source}
          isStreaming={snapshot.status === "streaming"} initialState={snapshot.state}
          onAction={(event) => { if (editable) onAction(event); }}
          onStateUpdate={(state) => { if (editable) onStateUpdate(state); }}
          onError={onError} publishObservability={false} />
      </div>
    </UiInteractionContext.Provider>
  </RenderBoundary>;
}

export function OpenUIPocBlock(props: Props) {
  const { snapshot } = props;
  // Changing the block/revision resets SDK form state and error boundaries;
  // appending tokens to the same revision preserves mounted controls.
  return <Content key={`${snapshot.chat_id}:${snapshot.session_generation}:${snapshot.block_id}:${snapshot.revision}`}
    {...props} />;
}
