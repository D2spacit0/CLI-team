import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const publicAddress = address => {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b));
  }
  // Restrict to globally routed unicast IPv6, excluding mapped/private forms.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
};

/** Reads an explicitly registered source with a pinned public DNS address. */
export async function readResearchSource(sourceUrl, { redirects = 0 } = {}) {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash || redirects > 3) {
    throw new Error('调研只读取已登记的公共 HTTPS 来源');
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('来源指向本机或非公共地址，未读取');
  const address = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      headers: { 'User-Agent': 'CLI-Team-Research/1.0', Accept: 'text/html,text/plain,application/json' }, timeout: 15000 }, res => {
      const buffers = []; let size = 0;
      res.on('data', chunk => {
        if ((size += chunk.length) > 1024 * 1024) { request.destroy(new Error('调研来源超过 1 MiB 读取上限')); return; }
        buffers.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, type: res.headers['content-type'] || '', body: Buffer.concat(buffers).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('调研来源读取超时')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.location) return readResearchSource(new URL(response.location, url).href, { redirects: redirects + 1 });
  if (response.status !== 200) throw new Error(`来源返回 HTTP ${response.status}，未认定为有效材料`);
  if (!/text\/(html|plain)|application\/json/i.test(response.type)) throw new Error('来源格式不适合文字调研');
  const body = response.body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 18000);
  return { url: url.href, status: 'read', content: body, capturedAt: new Date().toISOString(), evidenceType: 'source_excerpt',
    warning: '网页节选是来源材料，内容真实性仍需审查；截取不代表读取全文。' };
}
