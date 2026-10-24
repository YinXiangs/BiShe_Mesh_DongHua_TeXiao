import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makePreviewMaterial, addNeutralLights } from '../src/material-preview.js';

function texturedPhong() {
  const map = new THREE.Texture();
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshPhongMaterial({
    name: 'Authored rock', color: 0x263844, map, normalMap: new THREE.Texture(),
    normalScale: new THREE.Vector2(.7, .4), alphaMap: new THREE.Texture(),
    side: THREE.DoubleSide, transparent: true, opacity: .65,
    alphaTest: .3, depthWrite: false, vertexColors: true,
    specular: 0xcccccc, shininess: 0,
  });
}

test('neutral preview replaces legacy Phong gloss without changing authored tint, maps or normal scale', () => {
  const source = texturedPhong(), color = source.color.clone(), normalScale = source.normalScale.clone();
  const preview = makePreviewMaterial(source);
  assert.ok(preview.isMeshStandardMaterial);
  assert.notEqual(preview, source);
  assert.equal(preview.name, source.name);
  assert.deepEqual(preview.color.toArray(), color.toArray());
  assert.notEqual(preview.color, source.color);
  assert.equal(preview.map, source.map);
  assert.equal(preview.normalMap, source.normalMap);
  assert.equal(preview.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(preview.normalMap.colorSpace, THREE.NoColorSpace);
  assert.equal(preview.roughness, .85);
  assert.equal(preview.metalness, 0);
  preview.color.set(0xffffff);
  preview.normalScale.set(2, -3);
  assert.deepEqual(source.color.toArray(), color.toArray());
  assert.deepEqual(source.normalScale.toArray(), normalScale.toArray());
  assert.equal(source.shininess, 0);
  assert.equal(source.specular.getHex(), 0xcccccc);
});

test('recovered roughness and metallic maps remain active with their full-range multipliers', () => {
  const source = texturedPhong(), roughnessMap = new THREE.Texture(), metalnessMap = new THREE.Texture();
  source.reviewPbr = {roughnessMap, metalnessMap, roughness: 1, metalness: 1};
  const preview = makePreviewMaterial(source);
  assert.equal(preview.roughnessMap, roughnessMap);
  assert.equal(preview.metalnessMap, metalnessMap);
  assert.equal(preview.roughness, 1);
  // A zero scalar would erase the metallic texture regardless of its pixels.
  assert.equal(preview.metalness, 1);
  assert.equal(roughnessMap.colorSpace, THREE.NoColorSpace);
  assert.equal(metalnessMap.colorSpace, THREE.NoColorSpace);
  assert.equal(source.roughnessMap, undefined);
  assert.equal(source.metalnessMap, undefined);
  assert.deepEqual(Object.keys(source.reviewPbr).sort(), ['metalness', 'metalnessMap', 'roughness', 'roughnessMap']);
});

test('albedo inspection is unlit and keeps authored tint, UV texture, vertex color and alpha settings', () => {
  const source = texturedPhong(), preview = makePreviewMaterial(source, 'albedo');
  assert.ok(preview.isMeshBasicMaterial);
  assert.equal(preview.toneMapped, false);
  assert.equal(preview.map, source.map);
  assert.equal(preview.alphaMap, source.alphaMap);
  assert.deepEqual(preview.color.toArray(), source.color.toArray());
  assert.notEqual(preview.color, source.color);
  for (const key of ['side', 'transparent', 'opacity', 'alphaTest', 'depthWrite', 'vertexColors']) assert.equal(preview[key], source[key], key);
  assert.equal(preview.normalMap, undefined);
  assert.equal(preview.bumpMap, undefined);
});

test('clay inspection shows geometry without any texture, vertex color, or authored metallic response', () => {
  const source = texturedPhong();
  source.bumpMap = new THREE.Texture(); source.displacementMap = new THREE.Texture();
  source.reviewPbr = {roughnessMap: new THREE.Texture(), metalnessMap: new THREE.Texture(), roughness: 1, metalness: 1};
  const preview = makePreviewMaterial(source, 'clay');
  assert.ok(preview.isMeshStandardMaterial);
  assert.equal(preview.vertexColors, false);
  assert.equal(preview.metalness, 0);
  assert.equal(preview.roughness, .85);
  assert.notDeepEqual(preview.color.toArray(), source.color.toArray());
  for (const [key, value] of Object.entries(preview)) assert.equal(Boolean(value?.isTexture), false, `clay unexpectedly keeps ${key}`);
  assert.equal(source.vertexColors, true);
  assert.ok(source.bumpMap.isTexture);
  assert.ok(source.displacementMap.isTexture);
});

test('DirectX normal-Y correction only changes fresh preview copies in every lit mode', () => {
  for (const standard of [false, true]) {
    const source = standard ? new THREE.MeshStandardMaterial({normalMap: new THREE.Texture(), normalScale: new THREE.Vector2(.7, .4)}) : texturedPhong();
    for (const mode of ['material', 'fbx']) {
      const flipped = makePreviewMaterial(source, mode, -1);
      assert.deepEqual(flipped.normalScale.toArray(), [.7, -.4]);
      assert.notEqual(flipped.normalScale, source.normalScale);
      assert.equal(flipped.normalMap, source.normalMap);
      const normal = makePreviewMaterial(source, mode, 1);
      assert.deepEqual(normal.normalScale.toArray(), [.7, .4]);
      assert.deepEqual(source.normalScale.toArray(), [.7, .4]);
      assert.equal(source.normalMap.colorSpace, THREE.NoColorSpace);
    }
  }
});

test('standard and physical authored materials retain their PBR settings instead of preview defaults', () => {
  for (const Material of [THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial]) {
    const source = new Material({color: 0x263844, roughness: .27, metalness: .84}), preview = makePreviewMaterial(source);
    assert.equal(preview.type, source.type);
    assert.notEqual(preview, source);
    assert.equal(preview.roughness, .27);
    assert.equal(preview.metalness, .84);
    assert.deepEqual(preview.color.toArray(), source.color.toArray());
  }
});

test('review light colors are achromatic and cannot add the previous yellow or green cast', () => {
  const scene = new THREE.Scene(), lights = addNeutralLights(scene);
  assert.equal(lights.length, 4);
  assert.deepEqual(scene.children, lights);
  for (const light of lights) {
    assert.equal(light.color.r, light.color.g);
    assert.equal(light.color.g, light.color.b);
    assert.ok(light.intensity > 0 && Number.isFinite(light.intensity));
    if (light.isHemisphereLight) {
      assert.equal(light.groundColor.r, light.groundColor.g);
      assert.equal(light.groundColor.g, light.groundColor.b);
    }
  }
});
