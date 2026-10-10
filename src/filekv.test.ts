import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKV } from './filekv';

describe('FileKV', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filekv-'));
    file = join(dir, 'nested', 'kv.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for a missing key when the file does not exist yet', async () => {
    const kv = new FileKV(file);
    expect(await kv.get('missing')).toBeNull();
    expect(await kv.get('missing', 'json')).toBeNull();
  });

  it('round-trips text and json values and creates parent directories', async () => {
    const kv = new FileKV(file);
    await kv.put('pool', JSON.stringify({ devices: [{ id: 'a' }] }));
    expect(await kv.get('pool', 'json')).toEqual({ devices: [{ id: 'a' }] });
    expect(await kv.get('pool')).toBe('{"devices":[{"id":"a"}]}');
  });

  it('persists across instances (container restart)', async () => {
    await new FileKV(file).put('k', 'v');
    expect(await new FileKV(file).get('k')).toBe('v');
  });

  it('keeps every key when puts run concurrently', async () => {
    const kv = new FileKV(file);
    await Promise.all([kv.put('a', '1'), kv.put('b', '2'), kv.put('c', '3')]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('fails loudly on a corrupt store instead of silently resetting it', async () => {
    await new FileKV(file).put('k', 'v');
    await writeFile(file, '{not json');
    await expect(new FileKV(file).get('k')).rejects.toThrow(SyntaxError);
  });
});
