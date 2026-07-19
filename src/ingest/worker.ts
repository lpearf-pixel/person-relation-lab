import type { DiscoveredFile } from "./discovery.js";
import { discoverFiles } from "./discovery.js";
import { FileInventory, hashFile } from "./inventory.js";

export type SourceRegistration = { id: string; state: "ready" | "complete" };
export type SourceRegistry = {
  register(root: string, file: DiscoveredFile, sha256: string): Promise<SourceRegistration>;
  markComplete(sourceFileId: string, importedRows: number): Promise<void>;
  markFailed(sourceFileId: string, reason: string): Promise<void>;
};
type Importer = (path: string, sourceFileId: string) => Promise<{ importedRows: number; lastSourceRow: number }>;
type Options = { settleMs: number; now?: () => number; hash?: (path: string) => Promise<string> };

export class AutoImportWorker {
  private readonly inventory: FileInventory;
  private readonly completed = new Set<string>();
  private readonly now: () => number;
  private readonly hash: (path: string) => Promise<string>;

  constructor(private readonly roots: string[], private readonly registry: SourceRegistry, private readonly importer: Importer, options: Options) {
    this.inventory = new FileInventory(options.settleMs);
    this.now = options.now ?? Date.now;
    this.hash = options.hash ?? hashFile;
  }

  async scan(): Promise<void> { await this.scanFiles(discoverFiles); }

  async scanFiles(scanner: (root: string) => Promise<DiscoveredFile[]>): Promise<void> {
    const lookup = new Map<string, { root: string; file: DiscoveredFile }>();
    for (const root of this.roots) {
      let files: DiscoveredFile[];
      try { files = await scanner(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const file of files) {
        if (this.completed.has(file.path)) continue;
        lookup.set(file.path, { root, file });
        this.inventory.observe(file.path, { size: file.size, mtimeMs: file.mtimeMs, observedAtMs: this.now() });
      }
    }
    for (const path of this.inventory.drainReady()) {
      const entry = lookup.get(path);
      if (!entry) continue;
      const registration = await this.registry.register(entry.root, entry.file, await this.hash(path));
      if (registration.state === "complete") { this.completed.add(path); continue; }
      try {
        const result = await this.importer(path, registration.id);
        await this.registry.markComplete(registration.id, result.importedRows);
        this.completed.add(path);
      } catch (error) {
        await this.registry.markFailed(registration.id, error instanceof Error ? error.message : String(error));
      }
    }
  }
}
