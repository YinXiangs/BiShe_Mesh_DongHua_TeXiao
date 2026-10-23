import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDb, db, fileToStoredRecord, storedRecordToFile } from '../src/local-db.js';

test('database exposes the requested async adapter without opening IndexedDB during import', () => {
  for (const method of ['getAssets', 'putAsset', 'getVersions', 'putVersion', 'getFiles', 'getComments', 'putComment', 'deleteAsset']) {
    assert.equal(typeof db[method], 'function');
  }
});

test('a browser without IndexedDB receives an actionable error instead of losing files silently', async () => {
  const unsupported = createLocalDb({ factory: null });
  await assert.rejects(unsupported.getAssets(), /不支持本地数据库/);
});

test('version files survive a structured-clone round trip including bytes and relative texture paths', async () => {
  const source = new File([new Uint8Array([0, 1, 2, 254, 255])], 'diffuse.png', { type: 'image/png', lastModified: 123456789 });
  Object.defineProperty(source, 'webkitRelativePath', { value: '邮局/textures/diffuse.png' });
  const record = fileToStoredRecord(source, 'v-1', 2);
  assert.equal(record.id, 'v-1:2');
  assert.equal(record.version_id, 'v-1');
  const restored = storedRecordToFile(structuredClone(record));
  assert.equal(restored.name, source.name);
  assert.equal(restored.type, source.type);
  assert.equal(restored.lastModified, source.lastModified);
  assert.equal(restored.relativePath, '邮局/textures/diffuse.png');
  assert.equal(restored.webkitRelativePath, restored.relativePath);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), new Uint8Array(await source.arrayBuffer()));
});

test('file serializer uses explicit relativePath and rejects non-file objects', () => {
  const source = new File(['FBX'], 'model.fbx');
  Object.defineProperty(source, 'relativePath', { value: 'models/model.fbx' });
  assert.equal(fileToStoredRecord(source, 'v-2').relativePath, 'models/model.fbx');
  assert.throws(() => fileToStoredRecord({ name: 'fake.fbx' }, 'v-2'), /真实的本地文件/);
  assert.throws(() => storedRecordToFile({ name: 'broken.fbx', blob: null }), /数据损坏/);
});
