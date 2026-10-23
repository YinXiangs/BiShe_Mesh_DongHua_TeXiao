import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) throw new Error('Supabase server environment is incomplete');
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const bucket = admin.storage.from('review-files');
const allowedOrigins = (Deno.env.get('REVIEW_ALLOWED_ORIGINS') || 'https://yinxiangs.github.io').split(',').map((origin) => origin.trim()).filter(Boolean);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dimensions = new Set(['general', 'topology', 'material', 'structure', 'normals', 'animation', 'vfx']);
const verdicts = new Set(['note', 'changes', 'approved']);

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
type FileMeta = { name: string; path: string; type?: string; size?: number; relative_path?: string };
type Version = { id: string; asset_id: string; files: FileMeta[]; signed_files?: (FileMeta & { url: string })[] };

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const cors: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin',
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  };
  if (origin && allowedOrigins.includes(origin)) cors['Access-Control-Allow-Origin'] = origin;
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
  if (origin && !allowedOrigins.includes(origin)) return respond({ error: '访问来源未配置' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return respond({ error: '只接受 POST 请求' }, 405);
  try {
    // Do not log bodies, token hashes, or signed URLs.
    if (Number(req.headers.get('content-length')) > 32768) throw new HttpError(413, '提交内容过大');
    const text = await readBoundedBody(req, 32768);
    let input;
    try { input = JSON.parse(text); } catch { throw new HttpError(400, '请求格式错误'); }
    if (!input || !/^[A-Za-z0-9_-]{43}$/.test(input.token || '')) throw new HttpError(403, '分享链接无效或已过期');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.token))), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (input.action === 'get_shared_data') {
      const { data, error } = await admin.rpc('get_shared_data', { p_token_hash: hash });
      if (error) throw rpcError(error);
      // Sign only paths returned from the token-scoped SQL query, never a client path.
      for (const version of data.versions as Version[]) {
        const prefix = `${version.asset_id}/${version.id}/`;
        const files = version.files || [];
        if (files.some((file) => !file.path.startsWith(prefix) || file.path.slice(prefix.length).includes('/'))) throw new HttpError(500, '文件路径校验失败');
        if (!files.length) { version.signed_files = []; continue; }
        const seconds = Math.max(1, Math.min(900, Math.floor((new Date(data.expires_at).getTime() - Date.now()) / 1000)));
        const signed = await bucket.createSignedUrls(files.map((file) => file.path), seconds);
        if (signed.error || signed.data?.some((file) => file.error || !file.signedUrl)) throw new HttpError(502, '部分模型文件暂时不可用，请联系项目所有者');
        version.signed_files = files.map((file, index) => ({ ...file, url: signed.data![index].signedUrl }));
      }
      return respond(data);
    }
    if (input.action === 'post_comment') {
      const comment = input.comment;
      if (!comment || !uuid.test(comment.asset_id || '') || (comment.version_id && !uuid.test(comment.version_id))
        || typeof comment.author_name !== 'string' || !comment.author_name.trim() || comment.author_name.length > 80
        || typeof comment.body !== 'string' || !comment.body.trim() || comment.body.length > 5000
        || !dimensions.has(comment.dimension || 'general') || !verdicts.has(comment.verdict || 'note')
        || (comment.context !== undefined && (comment.context === null || typeof comment.context !== 'object' || Array.isArray(comment.context)))) {
        throw new HttpError(400, '请填写有效的姓名、意见和评审对象');
      }
      const { data, error } = await admin.rpc('submit_shared_comment', {
        p_token_hash: hash, p_asset_id: comment.asset_id, p_version_id: comment.version_id || null,
        p_author_name: comment.author_name.trim(), p_body: comment.body.trim(),
        p_dimension: comment.dimension || 'general', p_verdict: comment.verdict || 'note', p_context: comment.context || {},
      });
      if (error) throw rpcError(error);
      return respond(data, 201);
    }
    throw new HttpError(400, '未知请求类型');
  } catch (error) {
    if (error instanceof HttpError) return respond({ error: error.message }, error.status);
    // Do not expose database internals, environment configuration, or secrets.
    return respond({ error: '分享服务暂时不可用，请稍后重试' }, 500);
  }
});

function rpcError(error: { code: string; message: string }) {
  if (error.code === '42501') return new HttpError(403, '分享链接无效、已过期或无权评审此项目');
  if (error.code === 'P0001' && error.message.includes('Rate limit')) return new HttpError(429, '提交或刷新过于频繁，请一分钟后再试');
  if (['22023', '23514', '23503'].includes(error.code)) return new HttpError(400, '意见内容或关联版本不符合要求');
  return new HttpError(502, '分享服务读取失败，请联系项目所有者');
}

async function readBoundedBody(req: Request, limit: number) {
  if (!req.body) throw new HttpError(400, '请求内容为空');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, '提交内容过大'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
