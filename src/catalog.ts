import { Env } from './types';
import { UpstreamClient } from './client';

export const MODEL_CATALOG_KEY = 'chatgpt_model_catalog_v1';
export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const FALLBACK_CATALOG = [DEFAULT_MODEL];

/**
 * Extended model catalog - all models verified to work on ChatGPT Android API.
 * These are merged with upstream catalog to ensure full coverage.
 */
export const EXTENDED_MODELS = [
  // GPT-6 series (newest first)
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol',
  'gpt-6', 'gpt-6-mini',
  // GPT-5.x series
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4',
  'gpt-5', 'gpt-5-5', 'gpt-5-6', 'gpt-5-mini',
  'gpt-5-3-mini', 'gpt-5-5-mini', 'gpt-5-6-mini',
  // GPT-4 series
  'gpt-4', 'gpt-4o', 'gpt-4o-mini',
  // O-series (reasoning)
  'o1', 'o1-preview', 'o1-mini',
  'o3', 'o3-mini', 'o4-mini',
  // Other
  'auto',
];

interface CachedCatalog {
  models: string[];
  fetchedAt: number; // ms epoch
}

let memCache: CachedCatalog | null = null;

export function clearCatalogCache(): void {
  memCache = null;
}

/**
 * Returns the anonymous upstream model catalog.
 * Priority: fresh upstream GET /backend-anon/models (KV + memory cached),
 * fallback: ["auto"] when upstream is unreachable.
 * No name mapping is performed; slugs are returned verbatim.
 */
/**
 * Merge upstream models with extended catalog, dedupe, keep extended order.
 */
function mergeModels(upstream: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  // Add extended models first (preferred order)
  for (const m of EXTENDED_MODELS) {
    if (!seen.has(m)) {
      seen.add(m);
      result.push(m);
    }
  }

  // Add any upstream models not in extended list
  for (const m of upstream) {
    if (!seen.has(m)) {
      seen.add(m);
      result.push(m);
    }
  }

  return result;
}

export async function getModelCatalog(env: Env, client: UpstreamClient): Promise<string[]> {
  const now = Date.now();

  if (memCache && now - memCache.fetchedAt < DEFAULT_CATALOG_TTL_MS) {
    return mergeModels(memCache.models);
  }

  if (env.CHATGPT_KV) {
    try {
      const raw = await env.CHATGPT_KV.get(MODEL_CATALOG_KEY, 'json');
      if (
        raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as any).models) &&
        (raw as any).models.length > 0 &&
        now - ((raw as any).fetchedAt || 0) < DEFAULT_CATALOG_TTL_MS
      ) {
        memCache = raw as CachedCatalog;
        return mergeModels(memCache.models);
      }
    } catch {
      // KV read failure: continue to live fetch
    }
  }

  try {
    const slugs = await client.models(crypto.randomUUID());
    if (slugs.length > 0) {
      const catalog: CachedCatalog = { models: slugs, fetchedAt: now };
      memCache = catalog;
      if (env.CHATGPT_KV) {
        try {
          await env.CHATGPT_KV.put(MODEL_CATALOG_KEY, JSON.stringify(catalog));
        } catch {
          // KV write failure: catalog still served from memory
        }
      }
      return mergeModels(slugs);
    }
  } catch {
    // upstream unreachable: fall through to fallback
  }

  return [...EXTENDED_MODELS];
}
