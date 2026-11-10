import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { chartPropsSchema, MetricValueView, validChart } from "../../openui/data-views";
import type { DisplayTable } from "../../openui/data-contract";
import { replacesAnswer } from "../../openui/chat-library";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const table: DisplayTable = { data_ref: "energy", title: "Captured energy", columns: { name: "Site", energy: "Energy (kWh)" },
  rows: [{ id: "one", values: { name: "A", energy: 0 } }, { id: "two", values: { name: "B", energy: null } }],
  source_tool: "lookup", source_call_id: "call", captured_at: 1, total_rows: 2 };
const props = { data_ref: "energy", category: "name", series: ["energy"] };

it("uses only existing numeric fields and preserves null gaps without interpreting strings", () => {
  expect(validChart(table, props)).toBe(true);
  expect(validChart(table, { ...props, series: ["missing"] })).toBe(false);
  expect(validChart({ ...table, rows: [{ id: "one", values: { name: "A", energy: "9007199254740993" } }] }, props)).toBe(false);
  const negative = { ...table, rows: [{ id: "one", values: { name: "A", energy: -1 } }] };
  expect(validChart(negative, { ...props, kind: "line" })).toBe(true);
  expect(validChart(negative, { ...props, kind: "pie" })).toBe(false);
  expect(chartPropsSchema.safeParse({ ...props, series: ["energy", "name"], kind: "pie" }).success).toBe(false);
  expect(replacesAnswer('root = Panel([plot], "replace")\nplot = DataChart("energy", "name", ["energy"], "bar")', { energy: table })).toBe(true);
  expect(replacesAnswer('root = Panel([plot], "replace")\nplot = DataChart("energy", "name", ["missing"], "bar")', { energy: table })).toBe(false);
});

it("shows exact single-record metric values, including zero, without selecting or aggregating records", () => {
  const single = { ...table, rows: [table.rows[0]], total_rows: 1 };
  const view = render(<MetricValueView table={single} field="energy" />);
  expect(screen.getByText("0")).toBeVisible();
  expect(screen.getByText("Captured energy · Energy (kWh)")).toBeVisible();
  const truncated = { ...single, total_rows: 2 };
  view.rerender(<MetricValueView table={truncated} field="energy" />);
  expect(screen.getByRole("status")).toHaveTextContent("openui.unavailable");
  expect(replacesAnswer('root = Panel([metric], "replace")\nmetric = MetricValue("energy", "energy")', { energy: truncated })).toBe(false);
  view.rerender(<MetricValueView table={table} field="energy" />);
  expect(screen.getByRole("status")).toHaveTextContent("openui.unavailable");
  view.rerender(<MetricValueView table={{ ...table, rows: [], total_rows: 0 }} field="energy" />);
  expect(screen.getByRole("status")).toHaveTextContent("openui.emptyData");
});
