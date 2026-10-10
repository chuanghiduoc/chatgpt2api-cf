// Node entry point (Docker / VPS). The Cloudflare Workers entry stays
// src/index.ts; this file only supplies the bindings Workers would inject.
import { serve } from '@hono/node-server';
import { createApp } from './index';
import { UpstreamClient } from './client';
import { FileKV } from './filekv';
import { createProxyFetch } from './proxy';
import { ProxyPool } from './proxy-pool';
import type { Env } from './types';

const DEFAULT_PORT = 8787;
const DEFAULT_KV_FILE = '/data/kv.json';

const port = Number(process.env.PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const env: Env = {
  // FileKV implements the get/put subset of KVNamespace the gateway uses;
  // the cast narrows nothing else — no other KV method is ever called.
  CHATGPT_KV: new FileKV(process.env.KV_FILE ?? DEFAULT_KV_FILE) as unknown as KVNamespace,
  API_KEYS: process.env.API_KEYS ?? '',
  DEVICE_POOL_SIZE: process.env.DEVICE_POOL_SIZE ?? '3',
};

if (!env.API_KEYS) {
  console.warn('API_KEYS is empty: the gateway accepts requests from anyone who can reach it.');
}

// Proxy configuration:
// - PROXY_URLS (comma-separated): Multi-proxy pool with rotation and auto-cooldown on 429
// - PROXY_URL (single): Single proxy, no rotation
// Example: PROXY_URLS=socks5://warp1:1080,socks5://warp2:1080,socks5://warp3:1080
let client: UpstreamClient | undefined;
let proxyPool: ProxyPool | undefined;

const proxyUrls = process.env.PROXY_URLS?.split(',').map((u) => u.trim()).filter(Boolean);
const proxyUrl = process.env.PROXY_URL;

if (proxyUrls && proxyUrls.length > 0) {
  // Multi-proxy pool mode
  proxyPool = new ProxyPool(proxyUrls);
  client = new UpstreamClient(undefined, proxyPool.createFetch());
  console.log(`Proxy pool mode: ${proxyUrls.length} proxies with auto-rotation`);
} else if (proxyUrl) {
  // Single proxy mode
  console.log(`Single proxy mode: ${proxyUrl}`);
  client = new UpstreamClient(undefined, createProxyFetch(proxyUrl));
}

const app = createApp({ client });

const server = serve({
  fetch: (req) => {
    // Expose proxy pool status at /proxy-status (only in pool mode)
    if (proxyPool) {
      const url = new URL(req.url);
      if (url.pathname === '/proxy-status') {
        return new Response(JSON.stringify(proxyPool.getStatus(), null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return app.fetch(req, env);
  },
  port,
  hostname: '0.0.0.0',
}, (info) => {
  console.log(`chatgpt2api-cf listening on http://${info.address}:${info.port}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, closing server`);
  server.close((err) => {
    if (err) {
      console.error('Error while closing server:', err);
      process.exit(1);
    }
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
