import { SocksProxyAgent } from 'socks-proxy-agent';
import { Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';

/**
 * Creates a fetch function that routes requests through a SOCKS5 proxy.
 * Used with WARP or similar proxy containers to get a different egress IP.
 *
 * @param proxyUrl - The SOCKS5 proxy URL, e.g. "socks5://warp:1080"
 * @returns A fetch-compatible function using node:https with the proxy agent
 */
export function createProxyFetch(proxyUrl: string): typeof globalThis.fetch {
  const agent = new SocksProxyAgent(proxyUrl);

  // Use the global fetch but with a custom agent via undici dispatcher
  // This approach wraps requests to go through the SOCKS proxy.
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : {}));

    // Use native https/http module with the SOCKS agent
    const { request } = url.startsWith('https:')
      ? await import('node:https')
      : await import('node:http');

    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          agent: agent as unknown as HttpsAgent | HttpAgent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
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
            resolve(
              new Response(body, {
                status: res.statusCode ?? 200,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              })
            );
          });
          res.on('error', reject);
        }
      );

      req.on('error', reject);

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
