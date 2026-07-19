import { createReadStream } from "node:fs";
import { basename, extname } from "node:path";
import type { RowEnvelope } from "./workbook.js";

export async function* rowsFromCsv(path: string, sourceFileId: string): AsyncGenerator<RowEnvelope> {
  const sheetName = basename(path, extname(path));
  let headers: string[] | undefined;
  let rowNumber = 0;
  for await (const cells of parseCsv(createReadStream(path))) {
    rowNumber += 1;
    if (!headers) { headers = cells.map((cell, index) => cell.replace(/^\uFEFF/, "").trim() || `column_${index + 1}`); continue; }
    const values: Record<string, string | null> = {};
    headers.forEach((header, index) => { values[header] = cells[index] ?? null; });
    yield { sourceFileId, sheetName, sourceRowNumber: rowNumber, values };
  }
}

async function* parseCsv(stream: NodeJS.ReadableStream): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  for await (const chunk of stream) {
    const text = decoder.decode(chunk as Uint8Array, { stream: true });
    for (const char of text) {
      if (quoted) {
        if (pendingQuote) {
          if (char === '"') { field += '"'; pendingQuote = false; continue; }
          quoted = false; pendingQuote = false;
        } else if (char === '"') { pendingQuote = true; continue; }
        else { field += char; continue; }
      }
      if (char === '"' && field.length === 0) quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") { row.push(field.replace(/\r$/, "")); field = ""; yield row; row = []; }
      else field += char;
    }
  }
  field += decoder.decode();
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); yield row; }
}
