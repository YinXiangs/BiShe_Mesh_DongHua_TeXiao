import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewRecord, formatReviewRecordText } from '../src/review-records.js';

const exportedAt = '2026-10-24T01:10:11.000Z';
function fixture() {
  const asset = { id: 'rock', title: '幽思 · 岩石', category: 'scene', description: '第二版法向已修改。', status: 'approved', teacher_read_version_id: 'v2', teacher_read_at: '2026-10-23T18:01:02.000Z', created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-23T12:00:00.000Z' };
  const versions = [
    { id: 'v2', asset_id: asset.id, number: 2, filename: '岩石二版.fbx', created_at: '2026-10-23T12:00:00.000Z' },
    { id: 'v1', asset_id: asset.id, number: 1, filename: '岩石初版.fbx', created_at: '2026-10-20T00:00:00.000Z' },
  ];
  const comments = [
    { id: 'c1', asset_id: asset.id, version_id: 'v1', author_name: '黄静妮教授', body: '边缘法向需要修改。', dimension: 'normals', verdict: 'changes', context: { camera: [1, 2, 3], target: [0, 0, 0], time: 0, clip: '', mode: 'normal', exposure: 1, normalY: -1 }, created_at: '2026-10-21T01:00:00.000Z', is_guest: false },
    { id: 'c2', asset_id: asset.id, version_id: 'v2', author_name: '黄静妮教授', body: '修改完成，可以通过。', dimension: 'general', verdict: 'approved', context: { time: 4.25 }, created_at: '2026-10-23T18:02:00.000Z', is_guest: false },
  ];
  return { asset, versions, comments, exportedAt };
}

test('preserves approval, exact read version and comments from every version in a JSON-serializable record', () => {
  const source = fixture();
  const record = JSON.parse(JSON.stringify(buildReviewRecord(source)));
  assert.equal(record.format, 'qixi-review-record');
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.project, '《栖息邮局》');
  assert.equal(record.exportedAt, exportedAt);
  assert.equal(record.storageMode, 'local');
  assert.deepEqual(record.asset, source.asset);
  assert.deepEqual(record.versions, source.versions);
  assert.deepEqual(record.comments, source.comments);
  const report = formatReviewRecordText(record);
  assert.match(report, /检查状态：已通过/);
  assert.match(report, /老师已读记录：V2/);
  assert.match(report, /V1 · 黄静妮教授/);
  assert.match(report, /V2 · 黄静妮教授/);
  assert.match(report, /边缘法向需要修改/);
  assert.match(report, /修改完成，可以通过/);
  assert.match(report, /2026-10-24 09:10:11（北京时间）/);
  assert.match(report, /2026-10-24 02:01:02（北京时间）/);
  assert.match(report, /"time":4.25/);
  assert.match(report, /此记录是导出时已保存内容的副本，不包含尚未提交的文字，也不会自动更新/);
  assert.match(report, /尚未同步到云端或其他设备/);
});

test('exports an explicit metadata whitelist without keys, files, thumbnails or unrelated projects', () => {
  const input = fixture();
  input.config = { privateKey: 'top-level-secret' };
  input.asset.config = { supabaseAnonKey: 'asset-secret' };
  input.asset.thumbnail = 'data:image/png;base64,asset-thumbnail';
  input.versions[0].stats = { thumbnail: 'data:image/png;base64,version-thumbnail' };
  input.versions[0].files = [{ blob: new Blob(['file-bytes']), signed_url: 'private-download' }];
  input.versions[0].storage_path = 'private-path';
  input.comments[0].author_id = 'private-author-id';
  input.comments[0].context.config = { service_role: 'context-secret' };
  input.comments[0].context.thumbnail = 'private-context-image';
  input.comments[0].context.file = new Blob(['private-context-file']);
  input.versions.push({ id: 'foreign-version', asset_id: 'another-work', number: 99 });
  input.comments.push({ id: 'foreign-comment', asset_id: 'another-work', body: 'unrelated-feedback' });
  const result = buildReviewRecord(input);
  assert.equal(result.versions.length, 2);
  assert.equal(result.comments.length, 2);
  assert.deepEqual(Object.keys(result.asset), ['id', 'title', 'category', 'description', 'status', 'teacher_read_at', 'teacher_read_version_id', 'created_at', 'updated_at']);
  assert.deepEqual(Object.keys(result.versions[0]), ['id', 'asset_id', 'number', 'filename', 'created_at']);
  assert.deepEqual(Object.keys(result.comments[0]), ['id', 'asset_id', 'version_id', 'author_name', 'body', 'dimension', 'verdict', 'context', 'created_at', 'is_guest']);
  assert.doesNotMatch(JSON.stringify(result), /secret|thumbnail|file-bytes|private-|foreign-|unrelated-feedback/);
  assert.deepEqual(result.comments[0].context.camera, [1, 2, 3]);
});

test('building and formatting do not mutate input or retain mutable context references', () => {
  const input = fixture(), before = structuredClone(input);
  const record = buildReviewRecord(input);
  const recordBefore = structuredClone(record);
  formatReviewRecordText(record);
  assert.deepEqual(input, before);
  assert.deepEqual(record, recordBefore);
  record.comments[0].context.camera[0] = 123;
  record.asset.status = 'changes';
  assert.deepEqual(input, before);
  input.comments[0].context.target[0] = 5;
  assert.equal(record.comments[0].context.target[0], 0);
});

test('plain-text report preserves Unicode, multiline feedback and markup literally without HTML conversion', () => {
  const input = fixture();
  input.asset.title = '栖庭 <script>alert("标题")</script> & 郵局 🍃';
  input.comments[0].body = '<img src=x onerror=alert(1)>\n第二行：不要丢掉 & < >。';
  input.comments[0].author_name = '黄老师 <指导>'; 
  const record = buildReviewRecord(input), report = formatReviewRecordText(record);
  assert.ok(report.includes(input.asset.title));
  assert.ok(report.includes(input.comments[0].body));
  assert.ok(report.includes(input.comments[0].author_name));
  assert.doesNotMatch(report, /<html|<body|&lt;|&amp;/);
  assert.deepEqual(JSON.parse(JSON.stringify(record)).comments[0].body, input.comments[0].body);
});

test('empty work has a sensible read-only report and unknown modes cannot claim cloud synchronization', () => {
  const record = buildReviewRecord({ asset: { id: 'empty', title: '尚未完成的作品', category: 'vfx', status: 'pending' }, mode: 'unverified', exportedAt });
  const report = formatReviewRecordText(record);
  assert.equal(record.storageMode, 'local');
  assert.deepEqual(record.comments, []);
  assert.deepEqual(record.versions, []);
  assert.match(report, /游戏特效/);
  assert.match(report, /检查状态：制作中/);
  assert.match(report, /尚未提交版本/);
  assert.match(report, /尚无检查意见/);
  assert.match(report, /尚无已读记录/);
  assert.match(report, /不包含 FBX、MP4 或贴图文件/);
  assert.match(report, /不会更改作品、老师状态或留言/);
});

test('cloud and guest exports describe saved snapshot copies and distinguish shared from local records', () => {
  for (const mode of ['cloud', 'guest']) {
    const record = buildReviewRecord({ ...fixture(), mode });
    assert.equal(record.storageMode, mode);
    assert.match(formatReviewRecordText(record), /导出后不会自动更新/);
    assert.match(formatReviewRecordText(record), /不包含尚未提交的文字/);
    assert.doesNotMatch(formatReviewRecordText(record), /身份|签名|审批凭证/);
    assert.doesNotMatch(formatReviewRecordText(record), /尚未同步到云端或其他设备/);
  }
});

test('unmatched-version feedback remains visible and guest flag does not export private link IDs', () => {
  const input = fixture();
  input.comments.push({ id: 'old', asset_id: 'rock', version_id: 'archived-version', body: '旧版意见仍需保留。', guest_link_id: 'private-link-id', created_at: '2026-10-19T00:00:00.000Z' });
  input.comments.push({ id: 'unversioned', asset_id: 'rock', version_id: null, body: '整体项目意见。' });
  const record = buildReviewRecord(input), report = formatReviewRecordText(record);
  assert.equal(record.comments.length, 4);
  assert.equal(record.comments.find((item) => item.id === 'old').is_guest, true);
  assert.match(report, /未列出的版本（archived-version）/);
  assert.match(report, /旧版意见仍需保留/);
  assert.match(report, /未关联版本/);
  assert.match(report, /整体项目意见/);
  assert.doesNotMatch(JSON.stringify(record), /private-link-id|guest_link_id/);
});

test('malformed contexts produce portable JSON and invalid export targets are rejected', () => {
  const input = fixture();
  input.comments[0].context = { camera: [Infinity, 2, 3], target: ['x', 0, 0], time: NaN, clip: '片段甲', mode: 'albedo', normalY: -1, exposure: 1.25, extra: 5n };
  const record = buildReviewRecord(input);
  assert.deepEqual(record.comments[0].context, { exposure: 1.25, normalY: -1, clip: '片段甲', mode: 'albedo' });
  assert.doesNotThrow(() => JSON.stringify(record));
  assert.throws(() => buildReviewRecord(), /打开一件真实作品/);
  assert.throws(() => buildReviewRecord({ ...fixture(), exportedAt: 'not-a-date' }), /导出时间/);
  assert.throws(() => formatReviewRecordText({ format: 'other' }), /不是支持的评审记录/);
});
