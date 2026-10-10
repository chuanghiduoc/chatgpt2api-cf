import { SocksProxyAgent } from 'socks-proxy-agent';
import { Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { Readable } from 'node:stream';

interface ProxyState {
  url: string;
  agent: SocksProxyAgent;
  cooldownUntil: number; // timestamp, 0 = available
  consecutive429: number;
}

/**
 * Pool of SOCKS5 proxies with automatic rotation and cooldown on 429.
 * When a proxy hits rate limit, it's put in cooldown and the next one is used.
 */
export class ProxyPool {
  private proxies: ProxyState[] = [];
  private currentIndex = 0;
  private readonly cooldownMs: number;

  /**
   * @param proxyUrls - Array of SOCKS5 proxy URLs, e.g. ["socks5://warp1:1080", "socks5://warp2:1080"]
   * @param cooldownMs - How long to cooldown a proxy after 429 (default 5 minutes)
   */
  constructor(proxyUrls: string[], cooldownMs = 5 * 60 * 1000) {
    if (proxyUrls.length === 0) {
      throw new Error('ProxyPool requires at least one proxy URL');
    }
    this.cooldownMs = cooldownMs;
    this.proxies = proxyUrls.map((url) => ({
      url,
      agent: new SocksProxyAgent(url),
      cooldownUntil: 0,
      consecutive429: 0,
    }));
    console.log(`ProxyPool initialized with ${this.proxies.length} proxies`);
  }

  /**
   * Get the next available proxy, skipping those in cooldown.
   * Returns null if all proxies are in cooldown.
   */
  private getNextProxy(): ProxyState | null {
    const now = Date.now();
    const startIndex = this.currentIndex;

    // Try each proxy once
    for (let i = 0; i < this.proxies.length; i++) {
      const index = (startIndex + i) % this.proxies.length;
      const proxy = this.proxies[index];

      // Check if cooldown expired
      if (proxy.cooldownUntil > 0 && now >= proxy.cooldownUntil) {
        proxy.cooldownUntil = 0;
        proxy.consecutive429 = 0;
        console.log(`Proxy ${proxy.url} cooldown expired, back in rotation`);
      }

      if (proxy.cooldownUntil === 0) {
        this.currentIndex = (index + 1) % this.proxies.length;
        return proxy;
      }
    }

    // All in cooldown - return the one with earliest expiry
    const earliest = this.proxies.reduce((a, b) =>
      a.cooldownUntil < b.cooldownUntil ? a : b
    );
    console.warn(`All proxies in cooldown, using ${earliest.url} (expires in ${Math.round((earliest.cooldownUntil - now) / 1000)}s)`);
    return earliest;
  }

  /**
   * Report that a proxy got 429. Puts it in cooldown with exponential backoff.
   */
  reportRateLimit(proxyUrl: string): void {
    const proxy = this.proxies.find((p) => p.url === proxyUrl);
    if (!proxy) return;

    proxy.consecutive429++;
    // Exponential backoff: 5min, 10min, 20min, max 30min
    const backoffMultiplier = Math.min(Math.pow(2, proxy.consecutive429 - 1), 6);
    const cooldown = this.cooldownMs * backoffMultiplier;
    proxy.cooldownUntil = Date.now() + cooldown;

    console.log(
      `Proxy ${proxyUrl} rate limited (${proxy.consecutive429}x), cooldown ${Math.round(cooldown / 1000)}s`
    );
  }

  /**
   * Report successful request - resets consecutive 429 counter.
   */
  reportSuccess(proxyUrl: string): void {
    const proxy = this.proxies.find((p) => p.url === proxyUrl);
    if (proxy && proxy.consecutive429 > 0) {
      proxy.consecutive429 = 0;
    }
  }

  /**
   * Get pool status for health endpoint.
   */
  getStatus(): { total: number; available: number; proxies: Array<{ url: string; available: boolean; cooldownSeconds?: number }> } {
    const now = Date.now();
    const proxies = this.proxies.map((p) => ({
      url: p.url,
      available: p.cooldownUntil === 0 || now >= p.cooldownUntil,
      cooldownSeconds: p.cooldownUntil > now ? Math.round((p.cooldownUntil - now) / 1000) : undefined,
    }));
    return {
      total: this.proxies.length,
      available: proxies.filter((p) => p.available).length,
      proxies,
    };
  }

  /**
   * Creates a fetch function that uses the proxy pool with automatic rotation.
   */
  createFetch(): typeof globalThis.fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const proxy = this.getNextProxy();
      if (!proxy) {
        throw new Error('No proxies available');
      }

      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
      const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : {}));

      const { request } = url.startsWith('https:')
        ? await import('node:https')
        : await import('node:http');

      const signal = init?.signal ?? undefined;

      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }

        const req = request(
          url,
          {
            method,
            headers: Object.fromEntries(headers.entries()),
            agent: proxy.agent as unknown as HttpsAgent | HttpAgent,
          },
          (res) => {
            res.on('close', () => signal?.removeEventListener('abort', onAbort));

            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value) {
                if (Array.isArray(value)) {
                  value.forEach((v) => responseHeaders.append(key, v));
                } else {
                  responseHeaders.set(key, value);
                }
              }
            }

            const status = res.statusCode ?? 200;

            // Track 429s for rotation
            if (status === 429) {
              this.reportRateLimit(proxy.url);
            } else if (status >= 200 && status < 300) {
              this.reportSuccess(proxy.url);
            }

            // Resolve on headers and hand the socket through as a stream, so SSE
            // frames reach the client as they arrive instead of after upstream ends.
            const hasNoBody = status === 204 || status === 304 || method === 'HEAD';
            if (hasNoBody) {
              res.resume();
            }
            // Cast: node:stream/web ReadableStream and the Workers-typed global differ only in typings.
            const body = hasNoBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);

            resolve(
              new Response(body, {
                status,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              })
            );
          }
        );

        const onAbort = () => {
          req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        req.on('error', (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        });

        if (init?.body) {
          if (typeof init.body === 'string') {
            req.write(init.body);
          } else if (init.body instanceof ArrayBuffer) {
            req.write(Buffer.from(init.body));
          } else if (ArrayBuffer.isView(init.body)) {
            req.write(Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength));
          }
        }

        req.end();
      });
    };
  }
}
