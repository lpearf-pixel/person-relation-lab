import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileSnapshot } from "./discovery.js";
import { isStable } from "./discovery.js";

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

export class FileInventory {
  private readonly baselines = new Map<string, FileSnapshot>();
  private readonly ready = new Set<string>();

  constructor(private readonly settleMs: number) {
    if (settleMs < 0) throw new Error("settleMs must be non-negative");
  }

  observe(path: string, current: FileSnapshot): "settling" | "ready" {
    const baseline = this.baselines.get(path);
    if (!baseline || baseline.size !== current.size || baseline.mtimeMs !== current.mtimeMs) {
      this.baselines.set(path, current);
      this.ready.delete(path);
      return "settling";
    }
    if (isStable(baseline, current, this.settleMs)) {
      this.ready.add(path);
      return "ready";
    }
    return "settling";
  }

  drainReady(): string[] {
    const paths = [...this.ready].sort();
    this.ready.clear();
    return paths;
  }
}
