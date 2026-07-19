import ExcelJS from "exceljs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { rowsFromWorkbook } from "../ingest/workbook.js";

const mode = process.argv[2];
const path = resolve(process.argv[3] ?? "data/benchmark/people.xlsx");
if (mode === "generate") await generate(path, Number(process.env.BENCHMARK_ROWS ?? 2_000_000));
else if (mode === "read") await readBenchmark(path);
else throw new Error("usage: node dist/benchmark/xlsx.js <generate|read> [path]");

async function generate(output: string, rows: number): Promise<void> {
  if (!Number.isSafeInteger(rows) || rows <= 0) throw new Error("BENCHMARK_ROWS must be a positive integer");
  await mkdir(dirname(output), { recursive: true });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: output, useSharedStrings: false, useStyles: false });
  const sheet = workbook.addWorksheet("人员");
  sheet.addRow(["CardNo","Descriot","CtfTp","CtfId","Gender","Birthday","Address","Mobile","Company"]).commit();
  for (let index = 0; index < rows; index += 1) {
    sheet.addRow([
      `C${String(index).padStart(10, "0")}`, `测试人员${index}`, "ID", null, index % 2 ? "F" : "M", "19900101",
      index % 7 ? `测试省测试市测试区${index % 100_000}号` : null,
      index % 13 ? `1${String(3000000000 + (index % 999999999)).padStart(10, "0")}` : null,
      `测试单位${index % 20_000}`
    ]).commit();
    if (index > 0 && index % 100_000 === 0) console.log(`generated_rows=${index}`);
  }
  sheet.commit();
  await workbook.commit();
  console.log(JSON.stringify({ path: output, rows, sizeBytes: (await stat(output)).size }));
}

async function readBenchmark(input: string): Promise<void> {
  const started = performance.now();
  let rows = 0;
  let peakRss = process.memoryUsage().rss;
  for await (const row of rowsFromWorkbook(input, "benchmark")) {
    void row;
    rows += 1;
    if (rows % 10_000 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const seconds = (performance.now() - started) / 1_000;
  console.log(JSON.stringify({ path: input, rows, seconds, rowsPerSecond: Math.round(rows / seconds), peakRssBytes: peakRss }));
}
