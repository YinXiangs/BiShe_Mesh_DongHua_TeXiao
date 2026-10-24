import http from 'node:http';
import https from 'node:https';
import { Transform, pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const UPSTREAM = 'https://qixi-post-review-shared-yinxiangs.sharp-root-9607.chatgpt.site';
export const ALLOWED_ORIGIN = 'https://yinxiangs.github.io';
export const MAX_BODY_BYTES = 6 * 1024 * 1024;
const VERSION = 'qixi-access-v1';
const ID = '[A-Za-z0-9_-]{1,128}';
const ROUTES = [
  ['GET', /^\/api\/(health|session)$/],
  ['POST', /^\/api\/(login|logout|comments)$/],
  ['GET|POST', /^\/api\/assets$/],
  ['GET|PATCH', new RegExp(`^/api/assets/${ID}$`)],
  ['GET', new RegExp(`^/api/assets/${ID}/(versions|comments)$`)],
  ['POST', new RegExp(`^/api/assets/${ID}/(delete|restore|review|read|uploads|import-review)$`)],
  ['GET', new RegExp(`^/api/files/${ID}$`)],
  ['DELETE', new RegExp(`^/api/uploads/${ID}$`)],
  ['POST', new RegExp(`^/api/uploads/${ID}/commit$`)],
  ['PUT', new RegExp(`^/api/uploads/${ID}/files/${ID}/parts/[0-9]{1,5}$`)],
];
const RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag',
  'last-modified', 'cache-control', 'retry-after', 'content-disposition',
]);

function targetForTests(value) {
  const target = new URL(value ?? UPSTREAM);
  if (value && !(target.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname))) {
    throw new Error('The injected test upstream must be a loopback HTTP server.');
  }
  if (target.pathname !== '/' || target.search || target.hash || target.username || target.password) {
    throw new Error('The upstream must be an origin.');
  }
  return target;
}

/** Production always uses the fixed upstream. An optional loopback origin supports isolated tests. */
export function createServer({ testUpstream, idleTimeoutMs = 45_000, headerTimeoutMs = 30_000 } = {}) {
  const target = targetForTests(testUpstream);
  const requestUpstream = target.protocol === 'https:' ? https.request : http.request;
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('vary', 'Origin');
    const send = (status, error) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const body = JSON.stringify(typeof error === 'string' ? { error } : error);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (origin && origin !== ALLOWED_ORIGIN) {
      send(403, '此来源不允许访问共享服务。');
      req.resume();
      return;
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', ALLOWED_ORIGIN);
      res.setHeader('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Retry-After');
    }
    const rawUrl = req.url ?? '';
    if (rawUrl.length > 4096 || !rawUrl.startsWith('/') || /[\r\n\\#]/.test(rawUrl)) {
      send(400, '无效的共享服务路径。'); req.resume(); return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && rawUrl === '/health') {
      send(200, { ok: true, service: 'qixi-access-gateway', version: VERSION });
      return;
    }
    const pathname = rawUrl.split('?')[0];
    const matches = ROUTES.filter(([, pattern]) => pattern.test(pathname));
    if (!matches.length) {
      send(404, '不存在的共享服务接口。'); req.resume(); return;
    }
    if (req.method === 'OPTIONS') {
      const requested = String(req.headers['access-control-request-method'] ?? '');
      const requestedHeaders = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
      const methodAllowed = matches.some(([methods]) => methods.split('|').includes(requested));
      if (!origin || !methodAllowed || requestedHeaders.some(x => !['authorization', 'content-type', 'range'].includes(x))) {
        send(403, '不允许此跨域请求。'); return;
      }
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, Range',
        'access-control-max-age': '600',
      });
      res.end(); return;
    }
    if (!matches.some(([methods]) => methods.split('|').includes(req.method))) {
      send(405, '此接口不支持该操作。'); req.resume(); return;
    }
    const rawLength = req.headers['content-length'];
    if (rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > MAX_BODY_BYTES)) {
      send(413, '单次分块请求不能超过 6 MiB。'); req.resume(); return;
    }
    if (['GET', 'DELETE'].includes(req.method) && (Number(rawLength || 0) > 0 || req.headers['transfer-encoding'])) {
      send(400, '此请求不能带上传内容。'); req.resume(); return;
    }
    const headers = { 'user-agent': 'Qixi-Access-Gateway/1.0 (+https://yinxiangs.github.io/BiShe_Mesh_DongHua_TeXiao/)' };
    for (const name of ['authorization', 'content-type', 'range', 'origin']) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    if (rawLength !== undefined) headers['content-length'] = rawLength;
    let finished = false;
    let upstreamResponse;
    const upstream = requestUpstream({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      method: req.method, path: rawUrl, headers,
    });
    const fail = (status, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(headerTimer);
      send(status, message);
      upstreamResponse?.destroy();
      upstream.destroy();
    };
    const headerTimer = setTimeout(() => fail(504, '共享服务响应超时，请稍后重试。'), headerTimeoutMs);
    headerTimer.unref();
    upstream.setTimeout(idleTimeoutMs, () => fail(504, '共享服务连接超时，请稍后重试。'));
    upstream.on('error', () => fail(502, '暂时无法连接共享服务，请稍后重试。'));
    upstream.on('response', response => {
      clearTimeout(headerTimer);
      if (finished) { response.destroy(); return; }
      upstreamResponse = response;
      for (const [name, value] of Object.entries(response.headers)) {
        if (RESPONSE_HEADERS.has(name) && value !== undefined) res.setHeader(name, value);
      }
      // Do not forward Location, cookies, platform credentials, or upstream CORS headers.
      res.writeHead(response.statusCode ?? 502);
      pipeline(response, res, () => { finished = true; upstream.destroy(); });
    });
    req.on('aborted', () => { finished = true; clearTimeout(headerTimer); upstreamResponse?.destroy(); upstream.destroy(); });
    res.on('close', () => {
      clearTimeout(headerTimer);
      if (!res.writableFinished) { finished = true; upstreamResponse?.destroy(); upstream.destroy(); }
    });
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          fail(413, '单次分块请求不能超过 6 MiB。');
          callback(new Error('Request body exceeds limit'));
        } else callback(null, chunk);
      },
    });
    // Preserve backpressure; no model, texture, or token is stored on disk or buffered in full.
    req.pipe(limit).pipe(upstream);
    limit.on('error', () => { req.unpipe(limit); req.resume(); });
    req.on('error', () => fail(400, '上传连接已中断。'));
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createServer();
  server.listen(port, '0.0.0.0', () => console.log(`Qixi access gateway listening on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
