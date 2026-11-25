import { createContext } from "react";

export interface MarkdownRowAction {
  label: string;
  disabled: boolean;
  run: () => void;
}

export const MarkdownTableActions = createContext<((headers: string[], rows: string[][]) =>
  (MarkdownRowAction | undefined)[]) | null>(null);
