import test from 'node:test';
import assert from 'node:assert/strict';
import { FILE_LIMITS, relativeFilePath, validateAsset, validateComment, validateFiles, validateText, validateVersion } from '../src/validation.js';

const file = (name, size = 100, path = name, type = '') => ({ name, size, relativePath: path, type });

test('each model category accepts one case-insensitive FBX plus common external textures', () => {
  for (const category of ['scene', 'character', 'product', 'animation']) {
    const main = file('Model.FBX');
    const texture = file('Diffuse.PNG', 200, 'textures/Diffuse.PNG', 'image/png');
    assert.deepEqual(validateFiles(category, [main, texture]), { mainFile: main, textureFiles: [texture], totalBytes: 300 });
  }
});

test('vfx accepts only a single MP4 and rejects textures and FBX', () => {
  const main = file('effect.mp4');
  assert.equal(validateFiles('vfx', [main]).mainFile, main);
  assert.throws(() => validateFiles('vfx', [main, file('preview.png')]), /不支持/);
  assert.throws(() => validateFiles('vfx', [file('model.fbx')]), /不支持/);
  assert.throws(() => validateFiles('vfx', [main, file('effect2.mp4')]), /仅包含一个 MP4/);
});

test('missing main file, multiple models, empty files, invalid categories are rejected', () => {
  assert.throws(() => validateFiles('scene', []), /FBX/);
  assert.throws(() => validateFiles('scene', [file('map.png')]), /仅包含一个 FBX/);
  assert.throws(() => validateFiles('scene', [file('a.fbx'), file('b.fbx')]), /分别提交/);
  assert.throws(() => validateFiles('scene', [file('a.fbx', 0)]), /为空/);
  assert.throws(() => validateFiles('other', [file('a.fbx')]), /分类/);
});

test('script extensions and script MIME disguised as textures are rejected', () => {
  const main = file('model.fbx');
  for (const filename of ['evil.js', 'evil.html', 'evil.svg', 'evil.php', 'image.png.exe']) {
    assert.throws(() => validateFiles('scene', [main, file(filename)]), /不支持/);
  }
  assert.throws(() => validateFiles('scene', [main, file('map.png', 100, 'map.png', 'text/javascript')]), /脚本/);
});

test('duplicate paths and case-insensitive duplicate filenames are rejected before texture mapping', () => {
  const main = file('model.fbx');
  assert.throws(() => validateFiles('scene', [main, file('map.png'), file('map.png')]), /重复文件路径/);
  assert.throws(() => validateFiles('scene', [main, file('Map.png', 100, 'A/Map.png'), file('map.PNG', 100, 'B/map.PNG')]), /同名文件/);
});

test('relative file paths preserve folders but reject absolute and traversal paths', () => {
  assert.equal(relativeFilePath(file('map.png', 100, 'textures\\map.png')), 'textures/map.png');
  for (const path of ['../map.png', '/map.png', 'C:\\map.png', 'folder/../map.png', 'folder//map.png', 'folder/./map.png']) {
    assert.throws(() => relativeFilePath(file('map.png', 100, path)), /路径不安全/);
  }
  assert.throws(() => validateFiles('scene', [file('a.fbx', 100, 'folder/b.fbx')]), /文件名与路径不一致/);
});

test('individual and aggregate byte limits enforce actual bytes including textures', () => {
  assert.equal(validateFiles('scene', [file('a.fbx', FILE_LIMITS.maxFileBytes)]).totalBytes, FILE_LIMITS.maxFileBytes);
  assert.throws(() => validateFiles('scene', [file('a.fbx', FILE_LIMITS.maxFileBytes + 1)]), /单文件/);
  assert.throws(() => validateFiles('scene', [file('a.fbx', 160 * 1024 ** 2), file('map.png', 141 * 1024 ** 2)]), /总大小/);
  assert.throws(() => validateFiles('scene', [file('a.fbx', 11)], { maxFileBytes: 10, maxTotalBytes: 20 }), /单文件/);
});

test('asset and feedback text fields are trimmed and validated without deleting text markup', () => {
  const asset = validateAsset({ id: 'asset-1', title: '  邮局外墙  ', category: 'scene', status: 'pending', description: '' });
  assert.equal(asset.title, '邮局外墙');
  assert.throws(() => validateAsset({ ...asset, status: 'unknown' }), /状态/);
  assert.throws(() => validateAsset({ ...asset, title: ' ' }), /项目名称/);
  const comment = validateComment({ id: 'comment-1', asset_id: asset.id, author_name: ' 王老师 ', body: '  检查 <边缘> 法向  ' });
  assert.equal(comment.author_name, '王老师');
  assert.equal(comment.body, '检查 <边缘> 法向');
  assert.equal(comment.version_id, null);
  assert.throws(() => validateComment({ ...comment, body: 'x'.repeat(5001) }), /最多/);
  assert.throws(() => validateComment({ ...comment, author_name: '' }), /姓名/);
  assert.throws(() => validateText(''), /填写/);
});

test('version numbers must be positive safe integers', () => {
  const version = { id: 'v1', asset_id: 'a1', filename: 'model.fbx', number: 1 };
  assert.equal(validateVersion(version).number, 1);
  for (const number of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => validateVersion({ ...version, number }), /版本号/);
});
