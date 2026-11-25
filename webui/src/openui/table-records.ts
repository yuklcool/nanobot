import type { DisplayTable } from "./data-contract";

export function matchTableRecords(headers: string[], rows: string[][], tables: DisplayTable[]) {
  const matches = rows.map(() => new Array<{ data_ref: string; record_id: string }>());
  const labels = headers.map((name) => name.trim());
  for (const table of tables) {
    const shared = Object.entries(table.columns).flatMap(([key, label]) => {
      const positions = labels.flatMap((header, index) => header === key || header === label ? [index] : []);
      return positions.length === 1 ? [{ key, index: positions[0] }] : [];
    });
    if (!shared.length || new Set(shared.map(({ index }) => index)).size !== shared.length) continue;
    const signature = (row: string[]) => JSON.stringify(shared.map(({ index }) => row[index]?.trim() ?? ""));
    const signatures = rows.map(signature);
    for (const record of table.rows) {
      const values = shared.map(({ key }) => String(record.values[key] ?? "").trim());
      if (values.every((value) => !value)) continue;
      const id = JSON.stringify(values);
      const index = signatures.indexOf(id);
      if (index !== -1 && index === signatures.lastIndexOf(id)) {
        matches[index].push({ data_ref: table.data_ref, record_id: record.id });
      }
    }
  }
  return matches.map((candidates) => candidates.length === 1 ? candidates[0] : undefined);
}
