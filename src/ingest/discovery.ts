import { readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type FileSnapshot = { size: number; mtimeMs: number; observedAtMs: number };
export type DiscoveredFile = { path: string; relativePath: string; size: number; mtimeMs: number };

const SUPPORTED = new Set([".xlsx", ".csv"]);

export function isStable(previous: FileSnapshot, current: FileSnapshot, settleMs: number): boolean {
  if (settleMs < 0) throw new Error("settleMs must be non-negative");
  return previous.size === current.size
    && previous.mtimeMs === current.mtimeMs
    && current.observedAtMs - previous.observedAtMs >= settleMs;
}

export async function discoverFiles(rootInput: string): Promise<DiscoveredFile[]> {
  const root = resolve(rootInput);
  if (!(await stat(root)).isDirectory()) throw new Error(`approved root is not a directory: ${root}`);
  const files: DiscoveredFile[] = [];
  await walk(root, root, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walk(root: string, directory: string, output: DiscoveredFile[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
    const path = resolve(directory, entry.name);
    assertWithinRoot(root, path);
    if (entry.isDirectory()) {
      await walk(root, path, output);
      continue;
    }
    if (!entry.isFile() || !SUPPORTED.has(extension(entry.name))) continue;
    const info = await stat(path);
    output.push({
      path,
      relativePath: relative(root, path).split(sep).join("/"),
      size: info.size,
      mtimeMs: info.mtimeMs
    });
  }
}

export function assertWithinRoot(rootInput: string, candidateInput: string): void {
  const root = resolve(rootInput);
  const candidate = resolve(candidateInput);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`path is outside approved root: ${candidate}`);
  }
}

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}
