import * as THREE from 'three';

export const PREVIEW_REVISION = 'neutral-pbr-v2';

// Preview materials are disposable copies. Authored materials and file bytes stay intact.
export function makePreviewMaterial(source, mode = 'material', normalY = 1) {
  let material;
  const common = {
    side: source.side, transparent: source.transparent, opacity: source.opacity,
    alphaTest: source.alphaTest, depthWrite: source.depthWrite,
    vertexColors: source.vertexColors,
  };
  if (mode === 'normal') {
    material = new THREE.MeshNormalMaterial({side: THREE.DoubleSide});
    material.toneMapped = false;
  } else if (mode === 'wireframe') {
    material = new THREE.MeshBasicMaterial({color: 0xb6cbd4, wireframe: true, side: THREE.DoubleSide});
    material.toneMapped = false;
  } else if (mode === 'albedo') {
    material = new THREE.MeshBasicMaterial({...common, color: source.color || 0xffffff, map: source.map, alphaMap: source.alphaMap});
    material.toneMapped = false;
  } else if (mode === 'clay') {
    material = new THREE.MeshStandardMaterial({color: 0xaeb4bc, roughness: .85, metalness: 0, side: source.side, flatShading: source.flatShading});
  } else if (mode === 'fbx' || source.isMeshStandardMaterial || source.isMeshPhysicalMaterial) {
    material = source.clone();
  } else {
    const properties = {...common, roughness: .85, metalness: 0};
    for (const key of ['color','map','normalMap','normalScale','normalMapType','bumpMap','bumpScale','aoMap','aoMapIntensity','emissive','emissiveMap','emissiveIntensity','alphaMap','flatShading']) {
      if (source[key] !== undefined) properties[key] = source[key]?.clone && !source[key]?.isTexture ? source[key].clone() : source[key];
    }
    Object.assign(properties, source.reviewPbr || {});
    material = new THREE.MeshStandardMaterial(properties);
  }
  material.name = source.name;
  if (material.normalMap && material.normalScale) material.normalScale.y *= normalY;
  return material;
}

export function addNeutralLights(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x777777, .65);
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(5,8,6);
  const fill = new THREE.DirectionalLight(0xffffff, .8); fill.position.set(-6,3,2);
  const rim = new THREE.DirectionalLight(0xffffff, .65); rim.position.set(-2,5,-5);
  scene.add(hemi, key, fill, rim);
  return [hemi,key,fill,rim];
}
