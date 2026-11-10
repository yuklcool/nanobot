import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import type { DisplayTable } from "./data-contract";

const field = z.string().min(1).max(256);
export const chartPropsSchema = z.object({
  data_ref: z.string().min(1).max(128), category: field,
  series: z.array(field).min(1).max(3).refine((keys) => new Set(keys).size === keys.length),
  kind: z.enum(["bar", "line", "pie"]).optional(),
}).refine((props) => !props.series.includes(props.category) && (props.kind !== "pie" || props.series.length === 1));
export const metricPropsSchema = z.object({ data_ref: z.string().min(1).max(128), field });
export type ChartProps = z.infer<typeof chartPropsSchema>;

export function validChart(table: DisplayTable, props: ChartProps): boolean {
  return Object.hasOwn(table.columns, props.category) && props.series.every((key) => Object.hasOwn(table.columns, key))
    && table.rows.every((row) => (typeof row.values[props.category] === "string" || typeof row.values[props.category] === "number")
      && props.series.every((key) => row.values[key] === null
        || (typeof row.values[key] === "number" && Number.isFinite(row.values[key])
          && (props.kind !== "pie" || row.values[key] >= 0))));
}

const colors = ["hsl(var(--primary))", "#d97706", "#0d9488"];
export function DataChartView({ table, props }: { table?: DisplayTable; props: ChartProps }) {
  const { t } = useTranslation();
  if (!table || !validChart(table, props)) return <p role="status">{t("openui.unavailable")}</p>;
  const points = table.rows.map((row) => ({ category: String(row.values[props.category]),
    ...Object.fromEntries(props.series.map((key, index) => [`value${index}`, row.values[key]])) }));
  const hasValues = table.rows.some((row) => props.series.some((key) => typeof row.values[key] === "number"
    && (props.kind !== "pie" || row.values[key] > 0)));
  if (!hasValues) return <p role="status">{t("openui.emptyData")}</p>;
  const tooltip = <Tooltip contentStyle={{ background: "hsl(var(--background))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }} />;
  const axes = <>
    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
    <XAxis dataKey="category" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
    <YAxis width={65} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
    {tooltip}<Legend />
  </>;
  return <figure className="min-w-0" aria-label={table.title}>
    <figcaption className="mb-3 text-reading-small font-medium">{table.title}</figcaption>
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 256 }}>
        {props.kind === "pie" ? <PieChart accessibilityLayer>
          <Pie data={points} dataKey="value0" nameKey="category" name={table.columns[props.series[0]]}
            innerRadius="35%" outerRadius="75%" isAnimationActive={false}>
            {points.map((_, index) => <Cell key={index} fill={colors[index % colors.length]} />)}
          </Pie>{tooltip}
        </PieChart> : props.kind === "line" ? <LineChart data={points} accessibilityLayer margin={{ left: 8, right: 16, top: 8 }}>
          {axes}{props.series.map((key, index) => <Line key={key} dataKey={`value${index}`} name={table.columns[key]}
            stroke={colors[index]} strokeWidth={2} isAnimationActive={false} connectNulls={false} />)}
        </LineChart> : <BarChart data={points} accessibilityLayer margin={{ left: 8, right: 16, top: 8 }}>
          {axes}{props.series.map((key, index) => <Bar key={key} dataKey={`value${index}`} name={table.columns[key]}
            fill={colors[index]} isAnimationActive={false} />)}
        </BarChart>}
      </ResponsiveContainer>
    </div>
    {props.kind === "pie" && <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption">
      {table.rows.map((row, index) => <li className="min-w-0 [overflow-wrap:anywhere]" key={row.id}>
        <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colors[index % colors.length] }} aria-hidden />
        {String(row.values[props.category])}: {String(row.values[props.series[0]] ?? "—")}
      </li>)}
    </ul>}
    <p className="mt-2 text-caption text-muted-foreground">{table.columns[props.category]} · {props.series.map((key) => table.columns[key]).join(" / ")}</p>
    <time className="text-caption text-muted-foreground" dateTime={new Date(table.captured_at * 1000).toISOString()}>
      {t("openui.snapshotTime", { time: new Date(table.captured_at * 1000).toLocaleString() })}
    </time>
    <p className="text-caption text-muted-foreground">{t("openui.showingRows", { shown: points.length, total: table.total_rows ?? points.length })}</p>
  </figure>;
}

export function MetricValueView({ table, field: key }: { table?: DisplayTable; field: string }) {
  const { t } = useTranslation();
  if (!table || !Object.hasOwn(table.columns, key) || table.rows.length > 1) return <p role="status">{t("openui.unavailable")}</p>;
  if (!table.rows.length || table.rows[0].values[key] === null) return <p role="status">{t("openui.emptyData")}</p>;
  const value = table.rows[0].values[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return <p role="status">{t("openui.unavailable")}</p>;
  return <figure className="rounded-control border border-border/70 p-4" aria-label={table.title}>
    <figcaption className="text-reading-small text-muted-foreground">{table.title} · {table.columns[key]}</figcaption>
    <p className="my-2 text-title font-semibold tabular-nums">{String(value)}</p>
    <time className="text-caption text-muted-foreground" dateTime={new Date(table.captured_at * 1000).toISOString()}>
      {t("openui.snapshotTime", { time: new Date(table.captured_at * 1000).toLocaleString() })}
    </time>
  </figure>;
}
