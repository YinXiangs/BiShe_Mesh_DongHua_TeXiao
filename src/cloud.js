import { createClient } from '@supabase/supabase-js';

const BUCKET = 'review-files';
const MAX_FILES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (error) => { if (error) throw error; };
const uuid = (value, name = 'id') => {
  if (!UUID.test(value || '')) throw new Error(`${name} 必须是 UUID`);
  return value;
};
const safeName = (name) => name.normalize('NFC').replace(/[\\/\u0000-\u001f<>:"|?*]/g, '_').slice(-180) || 'file';
// Workflow fields belong to server-side reviewer RPCs, never student form input.
const assetFields = ({ title, category, description = '' }) => ({ title, category, description });
function relativeName(file) {
  const raw = file.relativePath || file.webkitRelativePath || file.name;
  if (typeof raw !== 'string' || typeof file.name !== 'string') throw new Error('文件路径无效');
  const path = raw.normalize('NFC').replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f\u007f]/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))
    || path.split('/').at(-1).toLowerCase() !== file.name.normalize('NFC').toLowerCase()) throw new Error('文件相对路径无效');
  return path;
}
function restoreFile(blob, metadata) {
  const file = new File([blob], metadata.name, { type: metadata.type || blob.type || 'application/octet-stream' });
  Object.defineProperty(file, 'relativePath', { value: relativeName({ name: metadata.name, relativePath: metadata.relative_path || metadata.relativePath }) });
  return file;
}

/** Public browser configuration only. A secret/service-role key must never enter this module. */
export function createCloud(config) {
  const { supabaseUrl, supabaseAnonKey } = config;
  if (!/^https:\/\//i.test(supabaseUrl || '') || !supabaseAnonKey) throw new Error('请配置 Supabase HTTPS 地址与公开密钥');
  if (/^sb_secret_/.test(supabaseAnonKey)) throw new Error('禁止把 Supabase secret 密钥用于网页');
  if (supabaseAnonKey.split('.').length === 3) {
    try {
      const part = supabaseAnonKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      if (JSON.parse(atob(part)).role === 'service_role') throw new Error('禁止把 service_role 密钥用于网页');
    } catch (error) {
      if (error.message.includes('service_role')) throw error;
      throw new Error('Supabase 公开密钥格式不正确');
    }
  }
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const storage = client.storage.from(BUCKET);
  // A share token is kept only in this instance's memory to renew expired download URLs.
  let activeShareToken = null;

  async function getSession() {
    const { data, error } = await client.auth.getSession();
    fail(error);
    return data.session;
  }
  async function role() {
    const session = await getSession();
    if (!session) return null;
    const { data, error } = await client.from('review_members').select('role').eq('user_id', session.user.id).maybeSingle();
    fail(error);
    return data?.role || null;
  }
  async function requireOwner() {
    if (await role() !== 'owner') throw new Error('需要项目所有者权限');
  }
  async function requireReviewer() {
    if (await role() !== 'reviewer') throw new Error('需要已认证的老师账户；网站访问口令不能代替云端身份认证');
  }
  async function listAssets() {
    const { data, error } = await client.from('assets').select('*').is('deleted_at', null).order('created_at', { ascending: true });
    fail(error);
    return data;
  }
  async function listDeletedAssets() {
    await requireOwner();
    const { data, error } = await client.from('assets').select('*').not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
    fail(error);
    return data;
  }
  async function createAsset(asset) {
    await requireOwner();
    const { data, error } = await client.from('assets').insert({ id: uuid(asset.id || crypto.randomUUID()), ...assetFields(asset) }).select().single();
    fail(error);
    return data;
  }
  async function saveAsset(asset) {
    await requireOwner();
    const { data, error } = await client.from('assets').update(assetFields(asset)).eq('id', uuid(asset.id)).select().single();
    fail(error);
    return data;
  }
  async function listVersions(assetId) {
    const { data, error } = await client.from('versions').select('*').eq('asset_id', uuid(assetId)).order('number', { ascending: false });
    fail(error);
    return data;
  }
  async function uploadVersion(assetId, versionMeta, inputFiles) {
    uuid(assetId, 'asset_id');
    await requireOwner();
    const files = Array.from(inputFiles || []);
    if (!files.length || files.length > MAX_FILES) throw new Error(`每次提交需包含 1–${MAX_FILES} 个文件`);
    const maxBytes = Number(config.maxUploadBytes) || 250 * 1024 * 1024;
    if (files.some((file) => !(file instanceof File) || file.size > maxBytes)) throw new Error(`文件无效或超过单文件 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
    // Always allocate a fresh immutable version path, including when retrying a draft.
    const id = crypto.randomUUID();
    const paths = [];
    const metadata = [];
    let insertAttempted = false;
    try {
      for (const [index, file] of files.entries()) {
        const path = `${assetId}/${id}/${index}_${safeName(file.name)}`;
        // Include the in-flight path: a lost response may hide a successful upload.
        paths.push(path);
        const { error } = await storage.upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
        fail(error);
        metadata.push({ name: file.name, relative_path: relativeName(file), path, size: file.size, type: file.type || 'application/octet-stream' });
      }
      const versions = versionMeta.number ? [] : await listVersions(assetId);
      const number = versionMeta.number || Math.max(0, ...versions.map((item) => item.number)) + 1;
      const primary = metadata.find((file) => /\.(fbx|mp4)$/i.test(file.name)) || metadata[0];
      const row = {
        id, asset_id: assetId, number, filename: versionMeta.filename || primary.name,
        storage_path: primary.path, files: metadata, stats: versionMeta.stats || {},
      };
      insertAttempted = true;
      const { data, error } = await client.from('versions').insert(row).select().single();
      fail(error);
      return data;
    } catch (error) {
      if (insertAttempted) {
        const check = await client.from('versions').select('*').eq('id', id).maybeSingle();
        if (!check.error && check.data) return check.data;
        if (check.error) {
          // Do not remove files belonging to a possibly committed version.
          const uncertain = new Error(`提交结果暂时无法确认，请恢复网络后刷新版本列表再重试。待核对路径：${paths.join(', ')}`, { cause: error });
          uncertain.cleanupPaths = paths;
          uncertain.versionId = id;
          throw uncertain;
        }
      }
      if (paths.length) {
        const cleanup = await storage.remove(paths);
        if (cleanup.error) {
          const incomplete = new Error(`${error.message || '上传失败'}；自动清理未完成，请所有者在 Storage 删除这些路径：${paths.join(', ')}`, { cause: error });
          incomplete.cleanupPaths = paths;
          throw incomplete;
        }
      }
      throw error;
    }
  }
  async function downloadVersion(version) {
    if (version.signed_files) {
      const readSignedFiles = (items) => Promise.all(items.map(async (item) => {
        const response = await fetch(item.url, { referrerPolicy: 'no-referrer' });
        if (!response.ok) {
          const error = new Error(`文件下载失败（${response.status}），请刷新分享页面重新获取链接`);
          error.status = response.status;
          throw error;
        }
        return restoreFile(await response.blob(), item);
      }));
      try { return await readSignedFiles(version.signed_files); }
      catch (error) {
        if (!activeShareToken || ![400, 401, 403].includes(error.status)) throw error;
        // A still-open teacher page may outlive the 15-minute signed URL. Retry once.
        const latest = await invokeShared('get_shared_data', activeShareToken);
        const freshVersion = latest.versions.find((item) => item.id === version.id && item.asset_id === version.asset_id);
        if (!freshVersion) throw new Error('此版本已不可访问，请刷新评审页面');
        return readSignedFiles(freshVersion.signed_files);
      }
    }
    const files = version.files?.length ? version.files : [{ path: version.storage_path, name: version.filename }];
    return Promise.all(files.map(async (item) => {
      const { data, error } = await storage.download(item.path);
      fail(error);
      return restoreFile(data, item);
    }));
  }
  async function listComments(assetId) {
    const { data, error } = await client.from('comments').select('*').eq('asset_id', uuid(assetId)).order('created_at');
    fail(error);
    return data;
  }
  async function addComment(comment) {
    const session = await getSession();
    if (!session) throw new Error('请先登录');
    const { asset_id, version_id, author_name, body, dimension = 'general', verdict = 'note', context = {} } = comment;
    const { data, error } = await client.from('comments').insert({
      asset_id: uuid(asset_id), version_id: version_id ? uuid(version_id) : null,
      author_id: session.user.id, author_name, body, dimension, verdict, context,
    }).select().single();
    fail(error);
    return data;
  }
  async function reviewAsset(assetId, status, versionId) {
    await requireReviewer();
    const { data, error } = await client.rpc('review_asset', {
      p_asset_id: uuid(assetId), p_status: status, p_version_id: uuid(versionId, 'version_id'),
    });
    fail(error);
    return data;
  }
  async function markRead(assetId, versionId) {
    await requireReviewer();
    const { data, error } = await client.rpc('mark_asset_read', { p_asset_id: uuid(assetId), p_version_id: uuid(versionId, 'version_id') });
    fail(error);
    return data;
  }
  async function softDeleteAsset(id) {
    await requireOwner();
    const { data, error } = await client.rpc('soft_delete_asset', { p_asset_id: uuid(id) });
    fail(error);
    return data;
  }
  async function restoreAsset(id) {
    await requireOwner();
    const { data, error } = await client.rpc('restore_asset', { p_asset_id: uuid(id) });
    fail(error);
    return data;
  }
  async function createReviewLink(assetId = null, expiresInDays = 30) {
    await requireOwner();
    if (assetId) uuid(assetId);
    if (!Number.isFinite(expiresInDays) || expiresInDays < 1 / 24 || expiresInDays > 90) throw new Error('分享链接有效期应为 1 小时至 90 天');
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const { data, error } = await client.from('review_links').insert({
      asset_id: assetId, token_hash: tokenHash, expires_at: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
    }).select('id,asset_id,expires_at,created_at').single();
    fail(error);
    // Only return the plaintext once; do not persist it in a database or browser storage.
    return { ...data, token };
  }
  async function revokeReviewLink(id) {
    const { data, error } = await client.from('review_links').update({ revoked_at: new Date().toISOString() }).eq('id', uuid(id)).select('id,revoked_at').single();
    fail(error);
    return data;
  }
  async function invokeShared(action, token, comment) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('分享链接无效');
    const { data, error } = await client.functions.invoke('review-share', { body: { action, token, ...(comment ? { comment } : {}) } });
    if (error) {
      let message;
      try { message = (await error.context?.json())?.error; } catch { /* Preserve SDK error when the body is not JSON. */ }
      throw new Error(message || error.message || '分享服务请求失败', { cause: error });
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  return {
    client, getSession, role, listAssets, listDeletedAssets, createAsset, saveAsset, listVersions, uploadVersion,
    downloadVersion, listComments, addComment, reviewAsset, markRead, softDeleteAsset, restoreAsset, createReviewLink, revokeReviewLink,
    signIn: async (email) => {
      const redirect = new URL(location.href); redirect.hash = ''; redirect.search = '';
      const { data, error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirect.href } });
      fail(error); return data;
    },
    signOut: async () => { const { error } = await client.auth.signOut(); fail(error); },
    getSharedData: async (token) => {
      const data = await invokeShared('get_shared_data', token);
      activeShareToken = token;
      return data;
    },
    addSharedComment: (token, comment) => invokeShared('post_comment', token, comment),
  };
}
