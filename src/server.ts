// Node entry point (Docker / VPS). The Cloudflare Workers entry stays
// src/index.ts; this file only supplies the bindings Workers would inject.
import { serve } from '@hono/node-server';
import app from './index';
import { FileKV } from './filekv';
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

const server = serve({ fetch: (req) => app.fetch(req, env), port, hostname: '0.0.0.0' }, (info) => {
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
