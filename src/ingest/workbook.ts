import ExcelJS from "exceljs";

export type RowEnvelope = {
  sourceFileId: string;
  sheetName: string;
  sourceRowNumber: number;
  values: Record<string, string | number | boolean | Date | null>;
};

export async function* rowsFromWorkbook(path: string, sourceFileId: string): AsyncGenerator<RowEnvelope> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: "emit", sharedStrings: "cache", hyperlinks: "ignore", styles: "ignore"
  });
  for await (const worksheet of reader) {
    const metadata = worksheet as unknown as { name?: string; id?: number };
    const sheetName = metadata.name ?? String(metadata.id ?? "unknown");
    let headers: string[] | null = null;
    for await (const row of worksheet) {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      if (!headers) { headers = uniqueHeaders(values); continue; }
      const record: RowEnvelope["values"] = {};
      headers.forEach((header, index) => { record[header] = scalar(values[index]); });
      yield { sourceFileId, sheetName, sourceRowNumber: row.number, values: record };
    }
  }
}

function uniqueHeaders(values: ExcelJS.CellValue[]): string[] {
  const counts = new Map<string, number>();
  return values.map((value, index) => {
    const base = String(value ?? "").trim() || `column_${index + 1}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function scalar(value: ExcelJS.CellValue | undefined): string | number | boolean | Date | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("result" in value) return scalar(value.result);
  return String(value);
}
