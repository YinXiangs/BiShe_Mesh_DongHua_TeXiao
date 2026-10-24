// Shared records and files live on the server. Only an expiring login token is kept here.
const SESSION_KEY = 'qixi-shared-session-v1:';
const PART_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_VERSION_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 60_000;
const DOWNLOAD_TOTAL_MS = 300_000;
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = value => { if (!UUID.test(value || '')) throw Error('作品或版本编号无效。'); return encodeURIComponent(value); };
const unwrap = (data, key) => data?.[key] ?? data;

export function relativeFileName(file) {
  const raw = file.relativePath || file.webkitRelativePath || file.name;
  if (typeof raw !== 'string' || typeof file.name !== 'string') throw Error('文件路径无效。');
  const path = raw.normalize('NFC').replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f\u007f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))
    || path.split('/').at(-1).toLowerCase() !== file.name.normalize('NFC').toLowerCase()) throw Error('文件相对路径无效。');
  return path;
}

export function planLegacyVersions(localVersions, cloudVersions) {
  const localIds = new Set(localVersions.map(version => version.id));
  const cloudIds = new Set(cloudVersions.map(version => version.id));
  const missing = localVersions.filter(version => !cloudIds.has(version.id));
  // An old browser snapshot must not append stale geometry after a newer shared version.
  if (missing.length && cloudVersions.some(version => !localIds.has(version.id))) {
    throw Object.assign(Error('共享作品已有新的版本，未追加旧版本。原文件仍保留在这台设备，请联系维护者核对。'), { status: 409 });
  }
  return [...missing].sort((a, b) => a.number - b.number);
}

export function createSharedApi(config, options = {}) {
  const url = new URL(config.apiUrl);
  if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:')) throw Error('共享服务地址必须使用 HTTPS。');
  if (url.username || url.password || url.search || url.hash) throw Error('共享服务地址无效。');
  const base = url.href.replace(/\/$/, '') + '/api';
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const now = options.now || Date.now;
  const schedule = options.setTimeout || globalThis.setTimeout;
  const unschedule = options.clearTimeout || globalThis.clearTimeout;
  const cancelled = () => Object.assign(Error('已取消连接共享服务。'), { name: 'AbortError' });
  const sleep = options.sleep || ((milliseconds, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const abort = () => { unschedule(timer); reject(cancelled()); };
    const timer = schedule(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  }));
  let storage = options.storage;
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  const key = SESSION_KEY + base;
  let session = null;
  const previewCache = new Map(); let previewCacheBytes = 0, sessionGeneration = 0;
  try { session = JSON.parse(storage?.getItem(key) || 'null'); } catch { /* An invalid local login is discarded. */ }

  function expiry(value) { return typeof value === 'number' ? value : Date.parse(value); }
  function validSession(value) {
    return Boolean(value && typeof value.token === 'string' && value.token.length >= 20
      && ['student', 'teacher'].includes(value.role) && expiry(value.expiresAt) > now());
  }
  function clear() { session = null; sessionGeneration++; previewCache.clear(); previewCacheBytes = 0; try { storage?.removeItem(key); } catch { /* Best effort. */ } }
  if (!validSession(session)) clear();
  function savedGrant(grant) {
    if (!validSession(grant)) throw Error('共享服务返回的登录信息无效。');
    if (!storage) throw Error('当前浏览器无法保存登录，请允许网站使用会话存储。');
    storage.setItem(key, JSON.stringify(grant));
    if (session?.token !== grant.token) { sessionGeneration++; previewCache.clear(); previewCacheBytes = 0; }
    session = grant;
  }
  async function request(path, { method = 'GET', json, body, token, anonymous = false, raw = false, signal } = {}) {
    const activeToken = token || session?.token;
    if (!anonymous && !activeToken) throw Object.assign(Error('请重新输入访问密码登录。'), { status: 401 });
    const headers = new Headers();
    if (!anonymous) headers.set('Authorization', 'Bearer ' + activeToken);
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/octet-stream');
    let response;
    try { response = await fetcher(base + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : body, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...(signal ? { signal } : {}) }); }
    catch (cause) {
      if (signal?.aborted) throw Object.assign(Error('请求已取消。'), { name: 'AbortError' });
      throw Object.assign(Error('无法连接共享服务，请检查网络后重试；作品不会改存到本机。', { cause }), { network: true });
    }
    if (!response.ok) {
      let detail; try { detail = await response.json(); } catch { /* HTML errors must not be shown as saved data. */ }
      if (response.status === 401 && !anonymous && activeToken === session?.token) { clear(); options.onUnauthorized?.(); }
      throw Object.assign(Error(detail?.error || (response.status === 401 ? '登录已过期，请重新输入访问密码。' : '共享服务请求失败（' + response.status + '），请稍后重试。')), { status: response.status, ...(detail?.uploadId ? { uploadId: detail.uploadId } : {}) });
    }
    if (raw) return response;
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw Error('共享服务响应异常，请稍后重试。'); }
  }
  async function loginWithCode(password, { persist = true } = {}) {
    const grant = await request('/login', { method: 'POST', json: { password }, anonymous: true });
    if (!validSession(grant)) throw Error('共享服务返回的登录信息无效。');
    if (persist) {
      try { savedGrant(grant); } catch (error) { await request('/logout', { method: 'POST', token: grant.token }).catch(() => {}); throw error; }
    }
    return grant;
  }
  async function ensureReady({ onWait, signal } = {}) {
    const deadline = now() + 90_000;
    let lastError;
    // Only this anonymous, read-only endpoint is retried. Authentication and review
    // mutations remain single requests and never run before readiness is confirmed.
    while (now() < deadline) {
      if (signal?.aborted) throw cancelled();
      onWait?.();
      const controller = new AbortController();
      const attemptMilliseconds = Math.min(8_000, deadline - now());
      let timer, abort;
      const limit = new Promise((_, reject) => {
        timer = schedule(() => { controller.abort(); reject(Object.assign(Error('共享服务启动响应超时。'), { timeout: true })); }, attemptMilliseconds);
        abort = () => { controller.abort(); reject(cancelled()); };
        signal?.addEventListener('abort', abort, { once: true });
      });
      try {
        const operation = (async () => {
          const response = await fetcher(base + '/health', { method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
          if (!response.ok) {
            let detail; try { detail = await response.json(); } catch { /* Startup pages can contain HTML. */ }
            throw Object.assign(Error(detail?.error || '共享服务暂时无法连接（' + response.status + '）。'), { status: response.status });
          }
          const health = await response.json();
          if (health?.ok !== true || health?.storageReady !== true || health?.version !== 'qixi-shared-v1') throw Error('共享服务尚未完成启动，请稍候。');
          return health;
        })();
        return await Promise.race([operation, limit]);
      } catch (error) {
        // fetch can surface AbortError before the attempt timer's rejection. An
        // internal timeout still retries; only the caller's cancellation stops.
        if (signal?.aborted) throw cancelled();
        // A real access/configuration error must be displayed, not disguised as a cold start.
        if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) throw error;
        lastError = error;
      } finally {
        unschedule(timer); signal?.removeEventListener('abort', abort);
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(5_000, remaining), { signal });
    }
    throw Object.assign(Error('共享服务启动时间较长，请稍后重新点击“进入网站”。', { cause: lastError }), { timeout: true });
  }
  async function getSession() {
    if (!validSession(session)) { clear(); return null; }
    try {
      const remote = await request('/session');
      const grant = { ...session, role: remote.role, expiresAt: remote.expiresAt };
      savedGrant(grant); return grant;
    } catch (error) { if (error.status === 401) return null; throw error; }
  }
  async function logoutToken(token) { if (token) await request('/logout', { method: 'POST', token }); }
  async function logout() { const token = session?.token; clear(); if (token) await logoutToken(token); }
  const role = async () => validSession(session) ? (session.role === 'student' ? 'owner' : 'reviewer') : null;
  const listVersions = async id => (await request('/assets/' + uuid(id) + '/versions')).versions;
  const listAssets = async () => (await request('/assets')).assets;
  async function uploadVersion(assetId, meta, inputFiles, onProgress) {
    const files = Array.from(inputFiles || []);
    if (!files.length || files.length > 100) throw Error('每个版本请选择 1–100 个文件。');
    if (files.some(file => !(file instanceof Blob) || !file.name || !file.size || file.size > MAX_FILE_BYTES)) throw Error('文件无效；单文件上限为 200 MB。');
    if (files.reduce((total, file) => total + file.size, 0) > MAX_VERSION_BYTES) throw Error('每个版本文件总计不能超过 300 MB。');
    uuid(meta.id);
    const assetPath = '/assets/' + uuid(assetId);
    const info = files.map(file => ({ name: file.name, relative_path: relativeFileName(file), size: file.size, type: file.type || 'application/octet-stream' }));
    const upload = await request(assetPath + '/uploads', { method: 'POST', json: { versionId: meta.id, filename: meta.filename, stats: meta.stats || {}, files: info } });
    if (upload.completed && upload.version) return upload.version;
    let commitAttempted = false;
    try {
      if (!upload.id || upload.files?.length !== files.length) throw Error('共享服务返回的上传信息无效。');
      let sent = 0;
      const total = files.reduce((sum, file) => sum + file.size, 0);
      for (let index = 0; index < files.length; index++) {
        const file = files[index], target = upload.files[index], partSize = target.partSize || PART_BYTES;
        if (partSize !== PART_BYTES || (target.partCount && target.partCount !== Math.ceil(file.size / partSize))) throw Error('共享服务分片信息无效。');
        if (target.completed === true) { sent += file.size; onProgress?.({ sent, total, filename: file.name }); continue; }
        for (let part = 1, offset = 0; offset < file.size; part++, offset += partSize) {
          const bytes = file.slice(offset, Math.min(offset + partSize, file.size));
          for (let attempt = 0; ; attempt++) {
            try { await request('/uploads/' + encodeURIComponent(upload.id) + '/files/' + encodeURIComponent(target.id) + '/parts/' + part, { method: 'PUT', body: bytes }); break; }
            catch (error) { if (attempt >= 2 || (!error.network && !(error.status >= 500))) throw error; }
          }
          sent += bytes.size; onProgress?.({ sent, total, filename: file.name });
        }
      }
      commitAttempted = true;
      return unwrap(await request('/uploads/' + encodeURIComponent(upload.id) + '/commit', { method: 'POST' }), 'version');
    } catch (error) {
      // A response can be lost after a successful commit. Verify before aborting or inviting another upload.
      if (commitAttempted) {
        let versions;
        try { versions = await listVersions(assetId); }
        catch { throw Object.assign(Error('提交结果暂时无法确认，请恢复网络后刷新版本列表；不要重复提交。', { cause: error }), { versionId: meta.id, uploadId: upload.id, uncertain: true }); }
        const committed = versions.find(version => version.id === meta.id);
        if (committed) return committed;
        // A partial R2 commit may already contain complete files. Keep its task so the
        // same immutable version can safely finish instead of abandoning those bytes.
        throw Object.assign(Error('版本提交尚未完成，请保持原文件选择并再次保存以续传。' + error.message, { cause: error }), { versionId: meta.id, uploadId: upload.id, retryable: true });
      }
      if (upload.id) await request('/uploads/' + encodeURIComponent(upload.id), { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  }
  async function downloadFile(metadata, { onProgress, signal, imagePreview = false } = {}) {
    if (!metadata || typeof metadata.id !== 'string' || !metadata.id) throw Error('下载文件编号无效。');
    const relativePath = relativeFileName({ name: metadata.name, relativePath: metadata.relative_path });
    const expectedSize = !imagePreview && Number.isSafeInteger(metadata.size) && metadata.size > 0 ? metadata.size : 0;
    const maxBytes = imagePreview ? PREVIEW_MAX_BYTES : MAX_FILE_BYTES;
    if (expectedSize > MAX_FILE_BYTES) throw Error('文件超过单文件 200 MB 的下载上限。');
    const aborted = () => Object.assign(Error('已取消文件下载。'), { name: 'AbortError' });
    if (signal?.aborted) throw aborted();
    const controller = new AbortController();
    let reader, idleTimer, totalTimer, rejectLimit, finished = false, completed = false;
    const limit = new Promise((_, reject) => { rejectLimit = reject; });
    const cancelReader = () => { try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* The request deadline must still reject. */ } };
    const stop = error => {
      if (finished) return;
      controller.abort();
      // Cancellation is best effort: a stalled stream must not keep the dialog waiting.
      cancelReader();
      rejectLimit(error);
    };
    const timeout = () => stop(Object.assign(Error('文件下载超时，请检查网络后重试。'), { timeout: true, network: true }));
    const resetIdle = () => { unschedule(idleTimer); idleTimer = schedule(timeout, DOWNLOAD_IDLE_MS); };
    const abort = () => stop(aborted());
    signal?.addEventListener('abort', abort, { once: true });
    resetIdle(); totalTimer = schedule(timeout, DOWNLOAD_TOTAL_MS);
    try {
      const operation = (async () => {
        // Files remain authenticated. Never put a login token into a preview or download URL.
        const response = await request('/files/' + encodeURIComponent(metadata.id) + (imagePreview ? '/preview' : ''), { raw: true, signal: controller.signal });
        if (controller.signal.aborted) throw aborted();
        resetIdle();
        const contentLength = Number(response.headers?.get('content-length'));
        const total = expectedSize || (Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0);
        let received = 0;
        const progress = () => onProgress?.({ received, total, filename: metadata.name });
        progress();
        const chunks = [];
        reader = response.body?.getReader?.();
        if (reader) {
          while (true) {
            if (controller.signal.aborted) throw aborted();
            const { value, done } = await reader.read();
            if (controller.signal.aborted) throw aborted();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) throw Error(imagePreview ? '评审图片过大。' : '文件超过单文件 200 MB 的下载上限。');
            chunks.push(value); resetIdle(); progress();
          }
        } else {
          const blob = await response.blob();
          if (controller.signal.aborted) throw aborted();
          received = blob.size;
          if (received > maxBytes) throw Error(imagePreview ? '评审图片过大。' : '文件超过单文件 200 MB 的下载上限。');
          chunks.push(blob); progress();
        }
        if ((expectedSize || (imagePreview && total)) && received !== total) throw Object.assign(Error('文件下载不完整，请重新下载。'), { network: true });
        if (imagePreview && !received) throw Object.assign(Error('评审图片为空，请重试。'), { network: true });
        if (controller.signal.aborted) throw aborted();
        const file = new File(chunks, metadata.name, { type: imagePreview ? 'image/jpeg' : metadata.type || response.headers?.get('content-type') || 'application/octet-stream' });
        Object.defineProperty(file, 'relativePath', { value: relativePath });
        completed = true;
        return file;
      })();
      return await Promise.race([operation, limit]);
    } catch (cause) {
      if (signal?.aborted) throw aborted();
      if (cause.status || cause.timeout || cause.network || /200 MB/.test(cause.message)) throw cause;
      throw Object.assign(Error('文件下载中断，请检查网络后重试。', { cause }), { network: true });
    } finally {
      finished = true; unschedule(idleTimer); unschedule(totalTimer);
      signal?.removeEventListener('abort', abort);
      if (!completed) {
        controller.abort();
        cancelReader();
      }
    }
  }
  async function downloadImagePreview(metadata, options = {}) {
    if (!validSession(session)) { clear(); throw Object.assign(Error('登录已过期，请重新输入访问密码。'), { status: 401 }); }
    if (!/\.(jpe?g|png)$/i.test(metadata?.name || '')) throw Error('只有 JPG / PNG 可以加载评审图片。');
    if (options.signal?.aborted) throw cancelled();
    const cached = previewCache.get(metadata.id);
    if (cached) {
      previewCache.delete(metadata.id); previewCache.set(metadata.id, cached);
      options.onProgress?.({ received: cached.size, total: cached.size, filename: metadata.name }); return cached;
    }
    const generation = sessionGeneration;
    const result = await downloadFile(metadata, { ...options, imagePreview: true });
    if (generation !== sessionGeneration || !validSession(session)) throw cancelled();
    while (previewCache.size && previewCacheBytes + result.size > PREVIEW_CACHE_BYTES) {
      const oldest = previewCache.keys().next().value; previewCacheBytes -= previewCache.get(oldest).size; previewCache.delete(oldest);
    }
    // Concurrent requests for the same page must not count the same bytes twice.
    if (previewCache.has(metadata.id)) previewCacheBytes -= previewCache.get(metadata.id).size;
    previewCache.set(metadata.id, result); previewCacheBytes += result.size;
    return result;
  }
  async function uploadImagePreviews(version, previews = [], onProgress) {
    const failures = [];
    for (let index = 0; index < previews.length; index++) {
      const preview = previews[index];
      const file = version.files?.find(file => file.name === preview.name && /\.(jpe?g|png)$/i.test(file.name));
      if (!file || !(preview.blob instanceof Blob) || preview.blob.type !== 'image/jpeg' || !preview.blob.size || preview.blob.size > PREVIEW_MAX_BYTES) throw Error('轻量评审图片无效。');
      try { await request('/files/' + encodeURIComponent(file.id) + '/preview', { method: 'PUT', body: preview.blob }); }
      catch (error) { if (error.status === 401 || error.status === 403) throw error; failures.push(preview.name); }
      onProgress?.({ completed: index + 1, total: previews.length });
    }
    return { failures };
  }
  async function downloadVersion(version, options = {}) {
    if (!version.files?.length) return [];
    // Sequential reads bound memory and simultaneous QQ webview requests.
    const files = [];
    for (const metadata of version.files) {
      files.push(await downloadFile(metadata, options));
    }
    return files;
  }
  return {
    provider: 'shared-api', getSession, role, ensureReady, loginWithCode, logout, logoutToken, signOut: logout,
    listAssets, listDeletedAssets: async () => (await request('/assets?deleted=1')).assets,
    createAsset: async ({ id, title, category, description }) => unwrap(await request('/assets', { method: 'POST', json: { id, title, category, description } }), 'asset'),
    saveAsset: async ({ id, title, description }) => unwrap(await request('/assets/' + uuid(id), { method: 'PATCH', json: { title, description } }), 'asset'),
    listVersions, uploadVersion, downloadFile, downloadVersion, downloadImagePreview, uploadImagePreviews,
    listComments: async id => (await request('/assets/' + uuid(id) + '/comments')).comments,
    addComment: async comment => unwrap(await request('/comments', { method: 'POST', json: comment }), 'comment'),
    reviewAsset: async (id, status, versionId) => unwrap(await request('/assets/' + uuid(id) + '/review', { method: 'POST', json: { status, versionId } }), 'asset'),
    markRead: async (id, versionId) => unwrap(await request('/assets/' + uuid(id) + '/read', { method: 'POST', json: { versionId } }), 'asset'),
    softDeleteAsset: async id => unwrap(await request('/assets/' + uuid(id) + '/delete', { method: 'POST' }), 'asset'),
    restoreAsset: async id => unwrap(await request('/assets/' + uuid(id) + '/restore', { method: 'POST' }), 'asset'),
    importReview: (id, snapshot, teacherToken) => request('/assets/' + uuid(id) + '/import-review', { method: 'POST', json: snapshot, token: teacherToken }),
  };
}
