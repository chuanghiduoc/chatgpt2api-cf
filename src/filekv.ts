import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * FileKV stands in for Workers KV when the gateway runs on Node (Docker).
 * It implements only the two calls the gateway makes — get (text or 'json')
 * and put — over a single JSON file. The store holds two small keys (device
 * pool, model catalog), so the whole file is rewritten on every put.
 *
 * Writes go to a temp file and are renamed into place, so a crash never
 * leaves a half-written store; puts are serialized so the newest snapshot
 * always lands last. Single process only: two processes sharing the file
 * would overwrite each other's keys.
 */
export class FileKV {
  private data?: Promise<Record<string, string>>;
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(key: string, type?: 'text' | 'json'): Promise<unknown> {
    const value = (await this.load())[key];
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    const snapshot = JSON.stringify(data);
    // A failed earlier write must not block later ones; each caller still
    // sees the outcome of its own write.
    const write = this.lastWrite.catch(() => {}).then(() => this.persist(snapshot));
    this.lastWrite = write;
    return write;
  }

  private load(): Promise<Record<string, string>> {
    this.data ??= readFile(this.path, 'utf8').then(
      (raw) => JSON.parse(raw) as Record<string, string>,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return {};
        throw err;
      }
    );
    return this.data;
  }

  private async persist(snapshot: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, this.path);
  }
}
