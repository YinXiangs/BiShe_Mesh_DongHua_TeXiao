import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { inspectObject, makeDemo } from '../src/viewer.js';

const fixtureUrl = new URL('./fixtures/box.fbx', import.meta.url);
async function importBox() {
  const bytes = await readFile(fixtureUrl);
  return new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}

test('real FBXLoader imports the local ASCII cube as 12 triangles and one mesh with authored material', async () => {
  const object = await importBox();
  const stats = inspectObject(object);
  assert.equal(stats.triangles, 12);
  assert.equal(stats.meshes, 1);
  assert.equal(stats.vertices, 36, 'FBX quads expand into 36 buffer vertices; this is not the 8 source control points');
  assert.equal(stats.materialCount, 1);
  assert.equal(stats.materials[0].name, 'ReviewCubeMaterial');
  assert.equal(stats.materials[0].type, 'MeshPhongMaterial');
  assert.equal(stats.missingNormals, 0);
  assert.deepEqual(stats.size, [2, 2, 2]);
  assert.ok(stats.nodes.some((node) => node.name === 'ReviewCube' && node.type === 'Mesh'));
  assert.deepEqual(stats.animations, []);
});

test('inspection reads actual imported geometry and unique material identity instead of fixed sample counts', async () => {
  const object = await importBox();
  let original;
  object.traverse((node) => { if (node.isMesh) original = node; });
  const second = original.clone();
  second.name = 'SecondActualCube';
  second.position.x = 4;
  object.add(second);
  object.updateMatrixWorld(true);
  const stats = inspectObject(object);
  assert.equal(stats.triangles, 24);
  assert.equal(stats.meshes, 2);
  assert.equal(stats.vertices, 72);
  assert.equal(stats.materialCount, 1, 'both cubes share the imported material, which is counted once');
  assert.deepEqual(stats.size, [6, 2, 2]);
  assert.ok(stats.nodes.some((node) => node.name === 'SecondActualCube'));
});

test('demonstration animation is an actual Three.js clip that moves geometry through AnimationMixer', () => {
  const object = makeDemo('animation');
  const stats = inspectObject(object);
  assert.equal(stats.animations.length, 1);
  assert.equal(stats.animations[0].duration, 2);
  const wing = object.getObjectByName('旋转展示翼');
  assert.ok(wing?.isMesh);
  const startRotation = wing.rotation.z;
  const mixer = new THREE.AnimationMixer(object);
  mixer.clipAction(object.animations[0]).play();
  mixer.setTime(0.5);
  assert.ok(Math.abs(wing.rotation.z - 0.35) < 1e-6);
  assert.notEqual(wing.rotation.z, startRotation);
  mixer.setTime(1.5);
  assert.ok(Math.abs(wing.rotation.z + 0.35) < 1e-6);
  mixer.stopAllAction();
  mixer.uncacheRoot(object);
});
