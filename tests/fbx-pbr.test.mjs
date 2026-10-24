import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readBinaryMaterialMetadata, restoreFbxPbrMaps } from '../src/fbx-pbr.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const S = (value) => ({ type: 'S', value });
const L = (value) => ({ type: 'L', value });
const R = (value) => ({ type: 'R', value });
const D = (value) => ({ type: 'D', value });
const node = (name, props = [], children = []) => ({ name, props, children });
function property({ type, value }) {
  if (type === 'L') { const b = Buffer.alloc(9); b[0] = 76; b.writeBigInt64LE(BigInt(value), 1); return b; }
  if (type === 'D') { const b = Buffer.alloc(9); b[0] = 68; b.writeDoubleLE(value, 1); return b; }
  const data = type === 'S' ? Buffer.from(value) : value, prefix = Buffer.alloc(5); prefix[0] = type.charCodeAt(0); prefix.writeUInt32LE(data.length, 1); return Buffer.concat([prefix, data]);
}
function binary(nodes, version = 7400) {
  const wide = version >= 7500, headerSize = wide ? 25 : 13;
  function encode(item, start) {
    const name = Buffer.from(item.name), props = Buffer.concat(item.props.map(property)), children = [];
    let cursor = start + headerSize + name.length + props.length;
    for (const child of item.children) { const b = encode(child, cursor); children.push(b); cursor += b.length; }
    if (item.children.length) { children.push(Buffer.alloc(headerSize)); cursor += headerSize; }
    const header = Buffer.alloc(headerSize), values = [cursor, item.props.length, props.length];
    values.forEach((value, index) => wide ? header.writeBigUInt64LE(BigInt(value), index * 8) : header.writeUInt32LE(value, index * 4));
    header[headerSize - 1] = name.length; return Buffer.concat([header, name, props, ...children]);
  }
  const header = Buffer.alloc(27); Buffer.from('Kaydara FBX Binary  \0\x1a\0').copy(header); header.writeUInt32LE(version, 23);
  const buffers = [header]; let offset = 27;
  for (const item of nodes) { const b = encode(item, offset); buffers.push(b); offset += b.length; }
  buffers.push(Buffer.alloc(headerSize)); const result = Buffer.concat(buffers); return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}
function fixture({ version = 7400, name = '岩石材质', extraMaterials = [], textureName = 'roughness_texture', relation = 'ShininessExponent', embedded = true, fileName = 'rock_roughness.png', duplicateSlot = false, transforms = [] } = {}) {
  const objects = [node('Material', [L(1), S(name + '\0\x01Material'), S('')]), ...extraMaterials.map((entry, index) => node('Material', [L(index + 2), S(entry), S('')])), node('Texture', [L(10), S(textureName + '\0\x01Texture'), S('')], [node('RelativeFilename', [S(fileName)]), ...transforms]), node('Video', [L(20), S(fileName + '\0\x01Video'), S('')], [node('RelativeFilename', [S(fileName)]), ...(embedded ? [node('Content', [R(png)])] : [])]), node('Texture', [L(11), S('metallic_texture\0\x01Texture'), S('')], [node('RelativeFilename', [S('rock_metallic.png')])]), node('Video', [L(21), S('rock_metallic.png\0\x01Video'), S('')], embedded ? [node('Content', [R(png)])] : []), node('Geometry', [R(Buffer.from('this payload must not be interpreted'))])];
  const connections = [node('C', [S('OP'), L(10), L(1), S(relation)]), node('C', [S('OO'), L(20), L(10)]), node('C', [S('OP'), L(11), L(1), S('ReflectionFactor')]), node('C', [S('OO'), L(21), L(11)])];
  if (duplicateSlot) {
    objects.push(node('Texture', [L(12), S('second_roughness_texture'), S('')], [node('RelativeFilename', [S('other_roughness.png')])]));
    connections.push(node('C', [S('OP'), L(12), L(1), S('ShininessExponent')]));
  }
  return binary([node('Objects', [], objects), node('Connections', [], connections)], version);
}
function mesh(name = '岩石材质') { const material = new THREE.MeshPhongMaterial({ name, shininess: 0, specular: 0xcccccc }); const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.BoxGeometry(), material)); return { root, material }; }

for (const version of [7400, 7500]) test(`binary FBX ${version} recovers named roughness and metallic connections without reading geometry`, () => {
  const data = fixture({ version }), result = readBinaryMaterialMetadata(data), material = result.materials[0];
  assert.equal(result.supported, true); assert.equal(result.version, version); assert.deepEqual(result.warnings, []);
  assert.equal(material.name, '岩石材质'); assert.deepEqual(Object.keys(material.slots), ['roughnessMap', 'metalnessMap']);
  assert.equal(material.slots.roughnessMap.name, 'roughness_texture'); assert.equal(material.slots.roughnessMap.fileName, 'rock_roughness.png');
  assert.deepEqual(Buffer.from(material.slots.roughnessMap.embeddedData), png);
  assert.equal(material.slots.roughnessMap.embeddedData.buffer, data, 'embedded data uses a bounded view instead of duplicating large images');
});

test('generic reflection, wrong relation, packed maps and conflicting sources are never guessed', () => {
  let result = readBinaryMaterialMetadata(fixture({ textureName: 'generic_reflection', fileName: 'reflection.png', relation: 'ReflectionFactor' }));
  assert.equal(result.materials[0].slots.roughnessMap, undefined);
  result = readBinaryMaterialMetadata(fixture({ relation: 'DiffuseColor' })); assert.equal(result.materials[0].slots.roughnessMap, undefined);
  result = readBinaryMaterialMetadata(fixture({ textureName: 'occlusion_roughness_metallic', fileName: 'orm.png' })); assert.equal(result.materials[0].slots.roughnessMap, undefined);
  result = readBinaryMaterialMetadata(fixture({ duplicateSlot: true })); assert.equal(result.materials[0].slots.roughnessMap, undefined); assert.match(result.warnings.join(' '), /多个/);
});

test('ASCII, truncated metadata and unsafe 64-bit offsets return without blocking the original model', () => {
  const ascii = new TextEncoder().encode('; FBX 7.4.0 project file text content').buffer; assert.equal(readBinaryMaterialMetadata(ascii).supported, false);
  const data = fixture(); const truncated = data.slice(0, data.byteLength - 100), result = readBinaryMaterialMetadata(truncated); assert.deepEqual(result.materials, []); assert.equal(result.warnings.length, 1);
  const wide = fixture({ version: 7500 }); new DataView(wide).setBigUint64(27, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
  assert.equal(readBinaryMaterialMetadata(wide).warnings.length, 1);
});

test('restoration attaches linear PBR extensions while preserving authored Phong material and JSON-safe userData', async (t) => {
  const loaded = [];
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', async function (url) { loaded.push(this.manager.resolveURL(url)); const texture = new THREE.Texture(); texture.colorSpace = THREE.SRGBColorSpace; return texture; });
  const { root, material } = mesh(), urls = [], result = await restoreFbxPbrMaps(root, fixture(), new THREE.LoadingManager(), urls);
  assert.equal(material.type, 'MeshPhongMaterial'); assert.equal(material.shininess, 0); assert.equal(material.specular.getHex(), 0xcccccc);
  assert.equal(material.reviewPbr.roughnessMap.colorSpace, THREE.NoColorSpace); assert.equal(material.reviewPbr.metalnessMap.colorSpace, THREE.NoColorSpace);
  assert.equal(material.reviewPbr.roughness, 1); assert.equal(material.reviewPbr.metalness, 1); assert.equal(material.reviewPbr.roughnessMap.name, 'roughness_texture');
  assert.deepEqual(material.userData, {}); assert.doesNotThrow(() => material.clone());
  assert.deepEqual(result, { restoredMaterials: [{ name: '岩石材质', slots: ['roughnessMap', 'metalnessMap'] }], warnings: [] });
  assert.equal(loaded.length, 2); assert.equal(urls.length, 2); assert.ok(urls.every((url) => url.startsWith('blob:'))); urls.forEach((url) => URL.revokeObjectURL(url));
});

test('external images use the existing loading manager and failed images fall back per channel', async (t) => {
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', async () => { throw Error('embedded image decode failed'); });
  const resolved = [], manager = new THREE.LoadingManager(); manager.setURLModifier((url) => 'uploaded-file:' + url);
  manager.addHandler(/rock_roughness\.png$/, { async loadAsync(url) { resolved.push(manager.resolveURL(url)); return new THREE.Texture(); } });
  const { root, material } = mesh(), urls = [], result = await restoreFbxPbrMaps(root, fixture({ embedded: false }), manager, urls);
  assert.deepEqual(resolved, ['uploaded-file:rock_roughness.png']); assert.equal(material.reviewPbr.roughness, 1); assert.equal(material.reviewPbr.metalness, 0);
  assert.equal(material.reviewPbr.metalnessMap, undefined); assert.equal(result.warnings.length, 1); urls.forEach((url) => URL.revokeObjectURL(url));
});

test('duplicate material names skip restoration instead of connecting another material’s images', async () => {
  const { root, material } = mesh(), result = await restoreFbxPbrMaps(root, fixture({ extraMaterials: ['岩石材质'] }));
  assert.equal(material.reviewPbr, undefined); assert.deepEqual(result.restoredMaterials, []); assert.equal(result.warnings.length, 1);
  const second = mesh(); root.add(new THREE.Mesh(new THREE.BoxGeometry(), second.material));
  const duplicate = await restoreFbxPbrMaps(root, fixture()); assert.deepEqual(duplicate.restoredMaterials, []); assert.equal(duplicate.warnings.length, 1);
});

test('a missing external metallic map resolved to white is rejected instead of making the model fully metallic', async (t) => {
  const missing = new Set(), manager = new THREE.LoadingManager(), newlyLoaded = [];
  manager.setURLModifier((url) => { if (/metallic/.test(url)) { missing.add(url); return 'data:image/png;base64,white-placeholder'; } return url; });
  manager.reviewMissingTexture = (url) => missing.has(url);
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', async function (url) {
    this.manager.resolveURL(url); const texture = new THREE.Texture(); texture.disposalCount = 0; texture.addEventListener('dispose', () => texture.disposalCount++); newlyLoaded.push(texture); return texture;
  });
  const { root, material } = mesh(), originalMap = new THREE.Texture(); let originalDisposals = 0;
  originalMap.addEventListener('dispose', () => originalDisposals++); material.map = originalMap;
  const result = await restoreFbxPbrMaps(root, fixture({ embedded: false }), manager);
  assert.deepEqual(result.restoredMaterials[0].slots, ['roughnessMap']); assert.equal(result.warnings.length, 1);
  assert.equal(material.reviewPbr.metalness, 0); assert.equal(material.reviewPbr.metalnessMap, undefined);
  assert.equal(newlyLoaded[0].disposalCount, 0); assert.equal(newlyLoaded[1].disposalCount, 1);
  assert.equal(material.map, originalMap); assert.equal(originalDisposals, 0, 'unrelated imported maps remain untouched');
});

test('restored maps preserve FBX UV scaling, translation and wrapping from direct fields and Properties70', async (t) => {
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', async () => new THREE.Texture());
  const data = fixture({ transforms: [node('Scaling', [D(2), D(3), D(1)]), node('Properties70', [], [node('P', [S('Translation'), S('Vector3D'), S('Vector'), S(''), D(0.25), D(-0.5), D(0)]), node('P', [S('WrapModeU'), S('enum'), S(''), S(''), D(1)]), node('P', [S('WrapModeV'), S('enum'), S(''), S(''), D(0)])])] });
  const { root, material } = mesh(), urls = [], result = await restoreFbxPbrMaps(root, data, new THREE.LoadingManager(), urls), texture = material.reviewPbr.roughnessMap;
  assert.deepEqual(result.warnings, []); assert.deepEqual(texture.repeat.toArray(), [2, 3]); assert.deepEqual(texture.offset.toArray(), [0.25, -0.5]);
  assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping); assert.equal(texture.wrapT, THREE.RepeatWrapping);
  urls.forEach((url) => URL.revokeObjectURL(url));
});
