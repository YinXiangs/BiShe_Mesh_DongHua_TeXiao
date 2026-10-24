import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer, ALLOWED_ORIGIN, MAX_BODY_BYTES } from '../server.mjs';

async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = createServer({ testUpstream: `http://127.0.0.1:${upstream.address().port}`, ...options });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(async () => {
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]);
  });
  return `http://127.0.0.1:${gateway.address().port}`;
}

async function rawUpload(url, chunks, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'PUT', headers, agent: false }, response => {
      const parts = [];
      response.on('data', chunk => parts.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts).toString() }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('local health does not contact upstream and exact-origin CORS preflight is enforced', async t => {
  let called = 0;
  const url = await fixture(t, (req, res) => { called++; res.end('{}'); });
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'qixi-access-gateway', version: 'qixi-access-v1' });
  const valid = await fetch(`${url}/api/login`, { method: 'OPTIONS', headers: {
    Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization',
  } });
  assert.equal(valid.status, 204);
  assert.equal(valid.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  const denied = await fetch(`${url}/api/login`, { method: 'OPTIONS', headers: {
    Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-platform-bypass',
  } });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(`${url}/api/health`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal(called, 0);
});

test('authenticated API forwards only necessary headers, preserves status, and never leaks cookies', async t => {
  const url = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/api/assets?deleted=1');
    assert.equal(req.headers.authorization, 'Bearer test-session');
    assert.equal(req.headers.origin, ALLOWED_ORIGIN);
    assert.match(req.headers['user-agent'], /^Qixi-Access-Gateway\/1\.0/);
    for (const header of ['cookie', 'x-forwarded-for', 'cf-connecting-ip', 'x-platform-bypass']) assert.equal(req.headers[header], undefined);
    res.writeHead(401, { 'content-type': 'application/json', 'set-cookie': 'private=hidden', 'x-private': 'hidden' });
    res.end('{"error":"session expired"}');
  });
  const response = await fetch(`${url}/api/assets?deleted=1`, { headers: {
    Origin: ALLOWED_ORIGIN, Authorization: 'Bearer test-session', Cookie: 'do-not-forward=1',
    'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4', 'x-platform-bypass': 'invalid',
  } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-private'), null);
  assert.deepEqual(await response.json(), { error: 'session expired' });
});

test('no arbitrary proxy destinations, path traversal, encoded paths, or unsupported methods', async t => {
  let called = 0;
  const url = await fixture(t, (req, res) => { called++; res.end(); });
  const paths = ['/https://example.invalid', '//example.invalid/api/login', '/api/%2e%2e/login', '/api/assets%2flogin', '/api/login%3furl=https://example.invalid', '/api/unknown', '/api/assets/../login'];
  for (const endpoint of paths) {
    const result = await new Promise((resolve, reject) => {
      const request = http.request(url, { method: 'GET', path: endpoint }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end();
    });
    assert.equal(result, 404, endpoint);
  }
  assert.equal((await fetch(`${url}/api/assets`, { method: 'DELETE' })).status, 405);
  assert.equal(called, 0);
  assert.throws(() => createServer({ testUpstream: 'https://example.invalid' }), /loopback/);
});

test('5 MiB part upload is streamed before client completion and preserves exact bytes', async t => {
  let observeFirst;
  const firstChunkArrived = new Promise(r => { observeFirst = r; });
  const bytes = Buffer.alloc(5 * 1024 * 1024, 0x6b);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const url = await fixture(t, (req, res) => {
    let size = 0; const hash = createHash('sha256');
    req.on('data', chunk => { size += chunk.length; hash.update(chunk); observeFirst(); });
    req.on('end', () => {
      assert.equal(size, bytes.length); assert.equal(hash.digest('hex'), digest);
      res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"part":0}');
    });
  });
  const request = http.request(`${url}/api/uploads/u1/files/f1/parts/0`, {
    method: 'PUT', headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length },
  });
  const completed = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
  });
  request.write(bytes.subarray(0, 64 * 1024));
  await firstChunkArrived;
  assert.equal(request.writableEnded, false, 'upstream must receive bytes before the upload completes');
  request.end(bytes.subarray(64 * 1024));
  assert.equal(await completed, 201);
});

test('rejects declared and chunked oversized uploads without accepting complete oversized content', async t => {
  let upstreamBytes = 0;
  const url = await fixture(t, (req, res) => {
    req.on('error', () => {});
    req.on('data', chunk => { upstreamBytes += chunk.length; });
    req.on('end', () => res.end('{}'));
  });
  const path = `${url}/api/uploads/u1/files/f1/parts/0`;
  const declared = await rawUpload(path, [], { 'Content-Length': MAX_BODY_BYTES + 1 });
  assert.equal(declared.status, 413); assert.equal(upstreamBytes, 0);
  const chunked = await rawUpload(path, Array.from({ length: 7 }, () => Buffer.alloc(1024 * 1024)));
  assert.equal(chunked.status, 413);
  assert.ok(upstreamBytes <= MAX_BODY_BYTES);
});

test('range responses preserve file bytes and lengths without buffering downloads', async t => {
  const data = Buffer.from('0123456789abcdef');
  const url = await fixture(t, (req, res) => {
    assert.equal(req.headers.range, 'bytes=4-9');
    res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes 4-9/${data.length}`, 'content-length': '6', 'accept-ranges': 'bytes', etag: '"test-etag"' });
    res.end(data.subarray(4, 10));
  });
  const response = await fetch(`${url}/api/files/f1`, { headers: { Range: 'bytes=4-9', Authorization: 'Bearer test-session' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-9/16');
  assert.equal(response.headers.get('content-length'), '6');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '456789');
});

test('derived image previews allow only GET and PUT preflight without contacting upstream', async t => {
  let called = 0;
  const url = await fixture(t, (req, res) => { called++; res.end(); });
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(`${url}/api/files/f1/preview`, { method: 'OPTIONS', headers: {
      Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(response.status, 204, method);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  }
  const disallowed = await fetch(`${url}/api/files/f1/preview`, { method: 'OPTIONS', headers: {
    Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'DELETE',
  } });
  assert.equal(disallowed.status, 403);
  assert.equal((await fetch(`${url}/api/files/f1/preview`, { method: 'POST' })).status, 405);
  for (const route of ['/api/files/f1/thumbnail', '/api/files/f1/preview/extra', '/api/files/f1%2Fpreview']) {
    assert.equal((await fetch(`${url}${route}`)).status, 404, route);
  }
  assert.equal(called, 0);
});

test('preview GET streams exact image bytes with authorization and no private headers', async t => {
  const data = Buffer.from('derived-preview-image-bytes');
  let observeFirst;
  const firstReceived = new Promise(r => { observeFirst = r; });
  const url = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/api/files/f1/preview');
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer test-session');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['x-forwarded-for'], undefined);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': data.length,
      'cache-control': 'private, no-store', 'set-cookie': 'private=hidden', 'x-private': 'hidden' });
    res.write(data.subarray(0, 8));
    await firstReceived;
    res.end(data.subarray(8));
  });
  const response = await fetch(`${url}/api/files/f1/preview`, { headers: {
    Origin: ALLOWED_ORIGIN, Authorization: 'Bearer test-session', Cookie: 'do-not-forward=1',
    'x-forwarded-for': '1.2.3.4',
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('content-length'), String(data.length));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-private'), null);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.deepEqual(Buffer.from(first.value), data.subarray(0, 8), 'first image bytes arrive before upstream finishes');
  observeFirst();
  const chunks = [Buffer.from(first.value)];
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(Buffer.from(part.value));
  }
  assert.deepEqual(Buffer.concat(chunks), data);
});

test('preview PUT streams the body with authorization and preserves upstream rejection', async t => {
  const data = Buffer.from('encoded-review-preview');
  let observeFirst;
  const firstReceived = new Promise(r => { observeFirst = r; });
  const url = await fixture(t, (req, res) => {
    assert.equal(req.url, '/api/files/f1/preview');
    assert.equal(req.method, 'PUT');
    assert.equal(req.headers.authorization, 'Bearer student-session');
    assert.equal(req.headers['content-type'], 'image/jpeg');
    assert.equal(req.headers['content-length'], String(data.length));
    assert.equal(req.headers['x-platform-bypass'], undefined);
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); observeFirst(); });
    req.on('end', () => {
      assert.deepEqual(Buffer.concat(chunks), data);
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"student required"}');
    });
  });
  const request = http.request(`${url}/api/files/f1/preview`, { method: 'PUT', headers: {
    Origin: ALLOWED_ORIGIN, Authorization: 'Bearer student-session', 'Content-Type': 'image/jpeg',
    'Content-Length': data.length, 'X-Platform-Bypass': 'invalid',
  } });
  const completed = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
  });
  request.write(data.subarray(0, 8));
  await firstReceived;
  assert.equal(request.writableEnded, false, 'preview uploads retain streaming backpressure');
  request.end(data.subarray(8));
  assert.deepEqual(await completed, { status: 403, body: '{"error":"student required"}' });
});

test('upstream redirects are not followed and redirect/cookie headers are stripped', async t => {
  let called = 0;
  const url = await fixture(t, (req, res) => {
    called++;
    res.writeHead(302, { location: 'https://example.invalid/private', 'set-cookie': 'private=1' }); res.end('redirect');
  });
  const response = await fetch(`${url}/api/health`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), 'redirect'); assert.equal(called, 1);
});

test('stalled upstream returns a bounded timeout instead of hanging', async t => {
  const url = await fixture(t, () => {}, { headerTimeoutMs: 40, idleTimeoutMs: 100 });
  const response = await fetch(`${url}/api/health`);
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /超时/);
});

test('client download disconnect promptly cancels the upstream stream', async t => {
  let signalClosed;
  const closed = new Promise(r => { signalClosed = r; });
  const url = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const interval = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 5);
    res.on('close', () => { clearInterval(interval); signalClosed(); });
  });
  await new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/files/f1`, response => {
      response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
    });
    request.on('error', reject);
  });
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream remained open after client disconnect')), 1000); timer.unref(); })]);
});
