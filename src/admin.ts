import { Hono } from 'hono';
import { ApiKeyManager, maskKey } from './apikeys';
import type { Env } from './types';

/**
 * Admin routes for API key management
 * All routes require ADMIN_KEY authentication
 */
export function createAdminApp() {
  const admin = new Hono<{ Bindings: Env }>();

  // Admin authentication middleware
  admin.use('*', async (c, next) => {
    const adminKey = c.env?.ADMIN_KEY?.trim();
    if (!adminKey) {
      return c.json({ error: 'Admin API not configured' }, 503);
    }

    const authHeader = c.req.header('Authorization') || c.req.header('authorization');
    let token = '';
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }

    if (token !== adminKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return next();
  });

  // List all API keys
  admin.get('/keys', async (c) => {
    const manager = new ApiKeyManager(c.env.CHATGPT_KV);
    const keys = await manager.listKeysWithData();

    return c.json({
      object: 'list',
      data: keys.map(k => ({
        id: k.key,
        name: k.name,
        created: Math.floor(k.createdAt / 1000),
        last_used: k.lastUsedAt ? Math.floor(k.lastUsedAt / 1000) : null,
        total_requests: k.totalRequests,
        total_tokens: k.totalTokens,
        rate_limit: k.rateLimit ?? null,
        disabled: k.disabled ?? false,
        // Masked key for display
        redacted_key: maskKey(k.key),
      })),
    });
  });

  // Create a new API key
  admin.post('/keys', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = body.name || 'Unnamed key';
    const project = body.project || 'proj';
    const rateLimit = body.rate_limit;

    const manager = new ApiKeyManager(c.env.CHATGPT_KV);
    const keyData = await manager.createKey(name, project, rateLimit);

    return c.json({
      object: 'api_key',
      id: keyData.key,
      name: keyData.name,
      created: Math.floor(keyData.createdAt / 1000),
      // Full key shown only on creation
      key: keyData.key,
      redacted_key: maskKey(keyData.key),
    }, 201);
  });

  // Get a specific key
  admin.get('/keys/:key', async (c) => {
    const key = c.req.param('key');
    const manager = new ApiKeyManager(c.env.CHATGPT_KV);
    const keyData = await manager.getKey(key);

    if (!keyData) {
      return c.json({ error: 'Key not found' }, 404);
    }

    return c.json({
      object: 'api_key',
      id: keyData.key,
      name: keyData.name,
      created: Math.floor(keyData.createdAt / 1000),
      last_used: keyData.lastUsedAt ? Math.floor(keyData.lastUsedAt / 1000) : null,
      total_requests: keyData.totalRequests,
      total_tokens: keyData.totalTokens,
      rate_limit: keyData.rateLimit ?? null,
      disabled: keyData.disabled ?? false,
      redacted_key: maskKey(keyData.key),
    });
  });

  // Disable a key
  admin.post('/keys/:key/disable', async (c) => {
    const key = c.req.param('key');
    const manager = new ApiKeyManager(c.env.CHATGPT_KV);
    const success = await manager.disableKey(key);

    if (!success) {
      return c.json({ error: 'Key not found' }, 404);
    }

    return c.json({ success: true, message: 'Key disabled' });
  });

  // Delete a key
  admin.delete('/keys/:key', async (c) => {
    const key = c.req.param('key');
    const manager = new ApiKeyManager(c.env.CHATGPT_KV);
    const success = await manager.deleteKey(key);

    if (!success) {
      return c.json({ error: 'Key not found' }, 404);
    }

    return c.json({ success: true, message: 'Key deleted' });
  });

  return admin;
}
