export interface ApiKeyData {
  key: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
  totalRequests: number;
  totalTokens: number;
  rateLimit?: number; // requests per minute, 0 = unlimited
  disabled?: boolean;
}

const KEY_PREFIX = 'apikey:';
const KEY_LIST = 'apikey_list';

/**
 * Generate a new API key in OpenAI format: sk-{project}-{random}
 * Uses Web Crypto API for Workers compatibility
 */
export function generateApiKey(project: string = 'proj'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Base64url encode without padding
  const random = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `sk-${project}-${random}`;
}

/**
 * API Key Manager - stores keys in KV with usage tracking
 */
export class ApiKeyManager {
  constructor(private readonly kv: KVNamespace) {}

  /**
   * Create a new API key
   */
  async createKey(name: string, project: string = 'proj', rateLimit?: number): Promise<ApiKeyData> {
    const key = generateApiKey(project);
    const data: ApiKeyData = {
      key,
      name,
      createdAt: Date.now(),
      totalRequests: 0,
      totalTokens: 0,
      rateLimit,
    };

    await this.kv.put(KEY_PREFIX + key, JSON.stringify(data));

    // Add to key list
    const list = await this.listKeys();
    list.push(key);
    await this.kv.put(KEY_LIST, JSON.stringify(list));

    return data;
  }

  /**
   * Get key data (returns null if not found or disabled)
   */
  async getKey(key: string): Promise<ApiKeyData | null> {
    const raw = await this.kv.get(KEY_PREFIX + key);
    if (!raw) return null;
    const data = JSON.parse(raw) as ApiKeyData;
    if (data.disabled) return null;
    return data;
  }

  /**
   * Validate a key exists and is active
   */
  async validateKey(key: string): Promise<boolean> {
    const data = await this.getKey(key);
    return data !== null;
  }

  /**
   * Record usage for a key
   */
  async recordUsage(key: string, tokens: number = 0): Promise<void> {
    const data = await this.getKey(key);
    if (!data) return;

    data.lastUsedAt = Date.now();
    data.totalRequests++;
    data.totalTokens += tokens;

    await this.kv.put(KEY_PREFIX + key, JSON.stringify(data));
  }

  /**
   * List all keys (just the key strings)
   */
  async listKeys(): Promise<string[]> {
    const raw = await this.kv.get(KEY_LIST);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  }

  /**
   * List all keys with full data
   */
  async listKeysWithData(): Promise<ApiKeyData[]> {
    const keys = await this.listKeys();
    const results: ApiKeyData[] = [];

    for (const key of keys) {
      const raw = await this.kv.get(KEY_PREFIX + key);
      if (raw) {
        results.push(JSON.parse(raw) as ApiKeyData);
      }
    }

    return results;
  }

  /**
   * Disable a key (soft delete)
   */
  async disableKey(key: string): Promise<boolean> {
    const raw = await this.kv.get(KEY_PREFIX + key);
    if (!raw) return false;

    const data = JSON.parse(raw) as ApiKeyData;
    data.disabled = true;
    await this.kv.put(KEY_PREFIX + key, JSON.stringify(data));
    return true;
  }

  /**
   * Delete a key permanently
   */
  async deleteKey(key: string): Promise<boolean> {
    const exists = await this.kv.get(KEY_PREFIX + key);
    if (!exists) return false;

    await this.kv.delete(KEY_PREFIX + key);

    // Remove from list
    const list = await this.listKeys();
    const newList = list.filter(k => k !== key);
    await this.kv.put(KEY_LIST, JSON.stringify(newList));

    return true;
  }
}

/**
 * Mask a key for display (show first 7 and last 4 chars)
 */
export function maskKey(key: string): string {
  if (key.length <= 11) return key;
  return key.slice(0, 7) + '...' + key.slice(-4);
}
