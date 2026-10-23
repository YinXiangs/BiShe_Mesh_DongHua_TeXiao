import { relativeFilePath, validateAsset, validateComment, validateFiles, validateVersion } from './validation.js';

const DATABASE_NAME = 'qixi-post-review-local-v1';
const DATABASE_VERSION = 1;
const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('本地数据读取失败。'));
});

function timestamp(value) {
  if (value == null) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('时间格式无效。');
  return date.toISOString();
}

export function fileToStoredRecord(file, versionId, index = 0) {
  if (!(file instanceof Blob) || typeof file.name !== 'string') throw new Error('请选择真实的本地文件。');
  return {
    id: `${versionId}:${index}`,
    version_id: versionId,
    index,
    name: file.name,
    type: file.type || '',
    relativePath: relativeFilePath(file),
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
    blob: file,
  };
}

export function storedRecordToFile(record) {
  if (!(record?.blob instanceof Blob)) throw new Error('本地文件数据损坏，请重新提交此版本。');
  const file = new File([record.blob], record.name, { type: record.type || '', lastModified: record.lastModified || 0 });
  const relativePath = record.relativePath || record.name;
  Object.defineProperties(file, {
    relativePath: { value: relativePath, enumerable: true },
    webkitRelativePath: { value: relativePath, enumerable: true },
  });
  return file;
}

// Local records never contain sample content. Cloud persistence is a separate adapter.
export function createLocalDb({ factory = globalThis.indexedDB, name = DATABASE_NAME } = {}) {
  let openPromise;
  let connection;

  function open() {
    if (!factory) return Promise.reject(new Error('当前浏览器不支持本地数据库，请使用新版 Chrome、Edge、Firefox 或 Safari。'));
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      const request = factory.open(name, DATABASE_VERSION);
      let settled = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('assets', { keyPath: 'id' });
        const versions = database.createObjectStore('versions', { keyPath: 'id' });
        versions.createIndex('asset_id', 'asset_id');
        versions.createIndex('asset_number', ['asset_id', 'number'], { unique: true });
        const files = database.createObjectStore('files', { keyPath: 'id' });
        files.createIndex('version_id', 'version_id');
        const comments = database.createObjectStore('comments', { keyPath: 'id' });
        comments.createIndex('asset_id', 'asset_id');
        comments.createIndex('version_id', 'version_id');
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        connection = request.result;
        connection.onversionchange = () => { connection.close(); connection = null; openPromise = null; };
        resolve(connection);
      };
      request.onerror = () => {
        settled = true;
        openPromise = null;
        reject(request.error || new Error('本地数据库打开失败。'));
      };
      request.onblocked = () => {
        settled = true;
        openPromise = null;
        reject(new Error('另一个页面正在使用旧版本数据库，请关闭其他评审页面后重试。'));
      };
    });
    return openPromise;
  }

  async function transaction(names, mode, operation) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(names, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('本地保存已取消，数据未完成写入。'));
      tx.onerror = () => reject(tx.error || new Error('本地保存失败，可能是浏览器储存空间不足。'));
      Promise.resolve().then(() => operation(tx)).then((value) => { result = value; }).catch((error) => {
        try { tx.abort(); } catch { /* Transaction may have already ended. */ }
        reject(error);
      });
    });
  }

  return {
    async getAssets({ includeDeleted = false } = {}) {
      const rows = await transaction(['assets'], 'readonly', (tx) => requestResult(tx.objectStore('assets').getAll()));
      return rows.filter((row) => includeDeleted || !row.deleted_at).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },

    async getDeletedAssets() {
      const rows = await transaction(['assets'], 'readonly', (tx) => requestResult(tx.objectStore('assets').getAll()));
      return rows.filter((row) => row.deleted_at).sort((a, b) => b.deleted_at.localeCompare(a.deleted_at) || b.updated_at.localeCompare(a.updated_at));
    },

    async softDeleteAsset(assetId) {
      return transaction(['assets'], 'readwrite', async (tx) => {
        const assets = tx.objectStore('assets');
        const asset = await requestResult(assets.get(assetId));
        if (!asset) throw new Error('项目不存在，无法移入回收站。');
        if (asset.deleted_at) return asset;
        const row = { ...asset, deleted_at: new Date().toISOString() };
        await requestResult(assets.put(row));
        return row;
      });
    },

    async restoreAsset(assetId) {
      return transaction(['assets'], 'readwrite', async (tx) => {
        const assets = tx.objectStore('assets');
        const asset = await requestResult(assets.get(assetId));
        if (!asset) throw new Error('项目不存在，无法恢复。');
        if (!asset.deleted_at) return asset;
        const row = { ...asset, deleted_at: null };
        await requestResult(assets.put(row));
        return row;
      });
    },

    async markRead(assetId, versionId) {
      return transaction(['assets', 'versions'], 'readwrite', async (tx) => {
        const assets = tx.objectStore('assets');
        const asset = await requestResult(assets.get(assetId));
        if (!asset) throw new Error('项目不存在，无法记录已读状态。');
        const versions = tx.objectStore('versions');
        const version = await requestResult(versions.get(versionId));
        if (!version || version.asset_id !== assetId) throw new Error('所查看的版本不属于此项目。');
        const rows = await requestResult(versions.index('asset_id').getAll(assetId));
        if (rows.some((row) => row.number > version.number) || asset.teacher_read_version_id === versionId) return asset;
        const row = { ...asset, teacher_read_version_id: versionId, teacher_read_at: new Date().toISOString() };
        await requestResult(assets.put(row));
        return row;
      });
    },

    async setReviewStatus(assetId, status, versionId) {
      if (!['review', 'changes', 'approved'].includes(status)) throw new Error('请选择待检查、待修改或已通过。');
      return transaction(['assets', 'versions'], 'readwrite', async (tx) => {
        const assets = tx.objectStore('assets');
        const asset = await requestResult(assets.get(assetId));
        if (!asset) throw new Error('项目不存在，无法保存评审状态。');
        if (asset.deleted_at) throw new Error('作品已移入回收站，无法保存评审状态。');
        if (!versionId) throw new Error('请打开作品的最新版本后检查。');
        const versions = tx.objectStore('versions');
        const version = await requestResult(versions.get(versionId));
        const rows = await requestResult(versions.index('asset_id').getAll(assetId));
        const latest = rows.reduce((current, row) => !current || row.number > current.number ? row : current, null);
        if (!version || version.asset_id !== assetId || latest?.id !== versionId) throw new Error('作品已有新版本，请重新打开最新版本后检查。');
        const row = { ...asset, status };
        await requestResult(assets.put(row));
        return row;
      });
    },

    async updateAssetMetadata(assetId, { title, description }) {
      return transaction(['assets'], 'readwrite', async (tx) => {
        const assets = tx.objectStore('assets');
        const asset = await requestResult(assets.get(assetId));
        if (!asset) throw new Error('项目不存在，无法保存作品说明。');
        const row = validateAsset({ ...asset, title, description, updated_at: new Date().toISOString() });
        await requestResult(assets.put(row));
        return row;
      });
    },

    async putAsset(input) {
      const checked = validateAsset({ status: 'pending', ...input });
      return transaction(['assets'], 'readwrite', async (tx) => {
        const store = tx.objectStore('assets');
        const existing = await requestResult(store.get(checked.id));
        const now = new Date().toISOString();
        const row = { ...checked, created_at: existing?.created_at || timestamp(checked.created_at), updated_at: timestamp(checked.updated_at || now) };
        await requestResult(store.put(row));
        return row;
      });
    },

    async getVersions(assetId) {
      const rows = await transaction(['versions'], 'readonly', (tx) => requestResult(tx.objectStore('versions').index('asset_id').getAll(assetId)));
      return rows.sort((a, b) => b.number - a.number || b.created_at.localeCompare(a.created_at));
    },

    async putVersion(input, inputFiles) {
      const checked = validateVersion(input);
      const files = Array.from(inputFiles || []);
      const records = files.map((file, index) => fileToStoredRecord(file, checked.id, index));
      return transaction(['assets', 'versions', 'files'], 'readwrite', async (tx) => {
        const assets = tx.objectStore('assets');
        const asset = await requestResult(assets.get(checked.asset_id));
        if (!asset) throw new Error('项目不存在，请先创建项目。');
        const { mainFile } = validateFiles(asset.category, files);
        if (mainFile.name !== checked.filename) throw new Error('版本主文件名与提交文件不一致。');
        const versions = tx.objectStore('versions');
        const existing = await requestResult(versions.get(checked.id));
        if (existing && existing.asset_id !== checked.asset_id) throw new Error('版本编号已被其他项目使用。');
        const row = { ...checked, stats: checked.stats ?? null, created_at: existing?.created_at || timestamp(checked.created_at) };
        const storedFiles = tx.objectStore('files');
        const oldKeys = await requestResult(storedFiles.index('version_id').getAllKeys(checked.id));
        await Promise.all(oldKeys.map((key) => requestResult(storedFiles.delete(key))));
        await requestResult(versions.put(row));
        await Promise.all(records.map((record) => requestResult(storedFiles.put(record))));
        await requestResult(assets.put({
          ...asset,
          ...(!existing ? { status: 'review', teacher_read_version_id: null, teacher_read_at: null } : {}),
          updated_at: new Date().toISOString(),
        }));
        return row;
      });
    },

    async getFiles(versionId) {
      const rows = await transaction(['files'], 'readonly', (tx) => requestResult(tx.objectStore('files').index('version_id').getAll(versionId)));
      return rows.sort((a, b) => a.index - b.index).map(storedRecordToFile);
    },

    async getComments(assetId) {
      const rows = await transaction(['comments'], 'readonly', (tx) => requestResult(tx.objectStore('comments').index('asset_id').getAll(assetId)));
      return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    async putComment(input) {
      const checked = validateComment(input);
      return transaction(['assets', 'versions', 'comments'], 'readwrite', async (tx) => {
        if (!await requestResult(tx.objectStore('assets').get(checked.asset_id))) throw new Error('项目不存在，无法保存评语。');
        if (checked.version_id) {
          const version = await requestResult(tx.objectStore('versions').get(checked.version_id));
          if (!version || version.asset_id !== checked.asset_id) throw new Error('评语所关联的版本不属于此项目。');
        }
        const comments = tx.objectStore('comments');
        const existing = await requestResult(comments.get(checked.id));
        if (existing && existing.asset_id !== checked.asset_id) throw new Error('评语编号已被其他项目使用。');
        const row = { ...checked, created_at: existing?.created_at || timestamp(checked.created_at) };
        await requestResult(comments.put(row));
        return row;
      });
    },

    async deleteAsset(assetId) {
      return transaction(['assets', 'versions', 'files', 'comments'], 'readwrite', async (tx) => {
        const versions = tx.objectStore('versions');
        const versionKeys = await requestResult(versions.index('asset_id').getAllKeys(assetId));
        const files = tx.objectStore('files');
        for (const versionId of versionKeys) {
          const fileKeys = await requestResult(files.index('version_id').getAllKeys(versionId));
          await Promise.all(fileKeys.map((key) => requestResult(files.delete(key))));
          await requestResult(versions.delete(versionId));
        }
        const comments = tx.objectStore('comments');
        const commentKeys = await requestResult(comments.index('asset_id').getAllKeys(assetId));
        await Promise.all(commentKeys.map((key) => requestResult(comments.delete(key))));
        await requestResult(tx.objectStore('assets').delete(assetId));
      });
    },

    close() {
      connection?.close();
      connection = null;
      openPromise = null;
    },
  };
}

export const db = createLocalDb();
