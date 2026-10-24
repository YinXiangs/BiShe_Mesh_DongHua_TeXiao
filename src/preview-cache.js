// Derived previews live separately from the user's original submissions.
import { PREVIEW_REVISION } from './material-preview.js';
const DATABASE = 'qixi-post-review-previews-v1';
let connection;

export function validPreview(value) {
  return typeof value === 'string' && value.startsWith('data:image/jpeg;base64,') && value.length <= 260000;
}

async function database() {
  if (!globalThis.indexedDB) return null;
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('previews');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = null; reject(request.error); };
  });
  return connection;
}

async function access(mode, operation) {
  try {
    const db = await database();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('previews', mode);
      const request = operation(tx.objectStore('previews'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } catch { return null; } // Cache failures must never affect source files or uploads.
}

const cacheKey = (scope, versionId) => `${PREVIEW_REVISION}|${scope}|${versionId}`;
export async function readPreview(scope, versionId) {
  const value = await access('readonly', store => store.get(cacheKey(scope, versionId)));
  return validPreview(value) ? value : null;
}
export async function writePreview(scope, versionId, value) {
  if (validPreview(value)) await access('readwrite', store => store.put(value, cacheKey(scope, versionId)));
}
