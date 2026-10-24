import { ClampToEdgeWrapping, LoadingManager, NoColorSpace, RepeatWrapping, TextureLoader } from 'three';

const signature = 'Kaydara FBX Binary  \0\x1a\0';
const decoder = new TextDecoder();
const cleanName = (value) => typeof value === 'string' ? value.split('\0')[0] : '';
const idOf = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

// Only inspect metadata nodes. Geometry and compressed vertex arrays are skipped by
// their absolute node offsets, so this second pass does not expand the mesh again.
export function readBinaryMaterialMetadata(arrayBuffer) {
  const empty = { supported: false, materials: [], warnings: [] };
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 27) return empty;
  const bytes = new Uint8Array(arrayBuffer), view = new DataView(arrayBuffer);
  if (decoder.decode(bytes.subarray(0, 23)) !== signature) return empty;
  const version = view.getUint32(23, true);
  if (version < 7400 || version >= 8000) return empty;
  const wide = version >= 7500, headerSize = wide ? 25 : 13;
  let visited = 0;
  const warnings = [], materials = [], textures = new Map(), videos = new Map(), connections = [];
  const requireRange = (offset, length, limit = bytes.length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > limit - length) throw Error('FBX metadata offset is out of bounds');
  };
  const uint = (offset) => {
    requireRange(offset, wide ? 8 : 4);
    if (!wide) return view.getUint32(offset, true);
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('FBX metadata offset exceeds the safe integer range');
    return Number(value);
  };
  function header(start, limit) {
    if (++visited > 100000) throw Error('FBX metadata node limit exceeded');
    requireRange(start, headerSize, limit);
    const width = wide ? 8 : 4, end = uint(start), count = uint(start + width), propertyBytes = uint(start + width * 2), nameLength = view.getUint8(start + width * 3);
    if (!end && !count && !propertyBytes && !nameLength) return null;
    if (count > 100000 || end <= start || end > limit) throw Error('Invalid FBX metadata node');
    const nameStart = start + headerSize, propertyStart = nameStart + nameLength, childStart = propertyStart + propertyBytes;
    requireRange(nameStart, nameLength, end); requireRange(propertyStart, propertyBytes, end);
    return { name: decoder.decode(bytes.subarray(nameStart, propertyStart)), count, propertyStart, childStart, end };
  }
  function properties(node) {
    let p = node.propertyStart;
    const values = [], limit = node.childStart;
    for (let i = 0; i < node.count; i++) {
      requireRange(p, 1, limit); const type = String.fromCharCode(bytes[p++]);
      const numeric = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
      if (numeric[type]) {
        const size = numeric[type]; requireRange(p, size, limit);
        values.push(type === 'L' ? view.getBigInt64(p, true).toString() : type === 'Y' ? view.getInt16(p, true) : type === 'C' ? Boolean(bytes[p]) : type === 'I' ? view.getInt32(p, true) : type === 'F' ? view.getFloat32(p, true) : view.getFloat64(p, true));
        p += size;
      } else if (type === 'S' || type === 'R') {
        requireRange(p, 4, limit); const length = view.getUint32(p, true); p += 4; requireRange(p, length, limit);
        const value = bytes.subarray(p, p + length); values.push(type === 'S' ? decoder.decode(value) : value); p += length;
      } else if ('fdlibc'.includes(type)) {
        requireRange(p, 12, limit); const length = view.getUint32(p + 8, true); p += 12; requireRange(p, length, limit); p += length; values.push(null);
      } else throw Error('Unsupported FBX metadata property');
    }
    if (p !== limit) throw Error('FBX metadata property length mismatch');
    return values;
  }
  function children(node, visit) {
    for (let p = node.childStart; p < node.end;) {
      const child = header(p, node.end); if (!child) break;
      visit(child); p = child.end;
    }
  }
  function fields(node, names) {
    const result = {};
    children(node, (child) => { if (names.includes(child.name)) result[child.name] = properties(child)[0]; });
    return result;
  }
  function textureFields(node) {
    const result = fields(node, ['TextureName', 'FileName', 'RelativeFilename']);
    const names = ['Scaling', 'Translation', 'WrapModeU', 'WrapModeV'];
    children(node, (child) => {
      if (names.includes(child.name)) {
        const values = properties(child); result[child.name] = values.length === 1 ? values[0] : values;
      }
      if (child.name === 'Properties70') children(child, (property) => {
        if (property.name !== 'P') return;
        const [name, , , , ...values] = properties(property);
        if (names.includes(name)) result[name] = values.length === 1 ? values[0] : values;
      });
    });
    return result;
  }
  try {
    for (let p = 27; p + headerSize <= bytes.length;) {
      const node = header(p, bytes.length); if (!node) break;
      if (node.name === 'Objects') children(node, (item) => {
        if (!['Material', 'Texture', 'Video'].includes(item.name)) return;
        const [rawId, rawName] = properties(item), id = idOf(rawId), name = cleanName(rawName);
        if (!id) return;
        if (item.name === 'Material') materials.push({ id, name, slots: {} });
        if (item.name === 'Texture') textures.set(id, { id, name, ...textureFields(item) });
        if (item.name === 'Video') videos.set(id, { id, name, ...fields(item, ['Filename', 'RelativeFilename', 'Content']) });
      });
      if (node.name === 'Connections') children(node, (item) => { if (item.name === 'C') connections.push(properties(item)); });
      p = node.end;
    }
    const videoLinks = new Map();
    for (const [type, source, target] of connections) if (type === 'OO' && videos.has(idOf(source)) && textures.has(idOf(target))) {
      const ids = videoLinks.get(idOf(target)) || new Set(); ids.add(idOf(source)); videoLinks.set(idOf(target), ids);
    }
    const byMaterial = new Map(materials.map((material) => [material.id, material]));
    const candidates = new Map();
    for (const [type, source, target, relation] of connections) {
      const texture = textures.get(idOf(source)), material = byMaterial.get(idOf(target));
      if (type !== 'OP' || !texture || !material) continue;
      const links = videoLinks.get(texture.id), video = links?.size === 1 ? videos.get([...links][0]) : null;
      const names = [texture.name, texture.TextureName, texture.FileName, texture.RelativeFilename, video?.name, video?.Filename, video?.RelativeFilename].filter((value) => typeof value === 'string').join(' ');
      const roughness = /roughness/i.test(names), metallic = /metallic|metalness/i.test(names);
      // Packed ORM maps require explicit channel metadata and must not be guessed.
      if (roughness === metallic) continue;
      const normalizedRelation = String(relation || '').split('|').at(-1).replace(/[^a-z]/gi, '').toLowerCase();
      const roughnessRelations = ['roughness', 'roughnessfactor', 'roughnessmap', 'texroughnessmap', 'shininessexponent'];
      const metalnessRelations = ['metalness', 'metallic', 'metalnessfactor', 'metallicfactor', 'metalnessmap', 'metallicmap', 'texmetalnessmap', 'texmetallicmap', 'reflectionfactor'];
      const slot = roughness && roughnessRelations.includes(normalizedRelation) ? 'roughnessMap' : metallic && metalnessRelations.includes(normalizedRelation) ? 'metalnessMap' : null;
      if (!slot) continue;
      if (links?.size > 1) { warnings.push(`材质“${material.name}”的贴图来源不明确，已保留原始预览。`); continue; }
      const fileName = texture.RelativeFilename || texture.FileName || video?.RelativeFilename || video?.Filename || '';
      const vector2 = (value) => Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every(Number.isFinite) ? value.slice(0, 2) : null;
      const descriptor = { id: texture.id, name: texture.name || cleanName(texture.TextureName), fileName, embeddedData: video?.Content instanceof Uint8Array ? video.Content : null,
        scaling: vector2(texture.Scaling), translation: vector2(texture.Translation), wrapModeU: Number.isFinite(texture.WrapModeU) ? texture.WrapModeU : 0, wrapModeV: Number.isFinite(texture.WrapModeV) ? texture.WrapModeV : 0 };
      const key = material.id + ':' + slot, list = candidates.get(key) || new Map(); list.set(texture.id, descriptor); candidates.set(key, list);
    }
    for (const material of materials) for (const slot of ['roughnessMap', 'metalnessMap']) {
      const list = candidates.get(material.id + ':' + slot);
      if (list?.size === 1) material.slots[slot] = [...list.values()][0];
      else if (list?.size > 1) warnings.push(`材质“${material.name}”有多个${slot === 'roughnessMap' ? '粗糙度' : '金属度'}贴图，已跳过自动连接。`);
    }
    return { supported: true, version, materials, warnings };
  } catch {
    return { supported: true, version, materials: [], warnings: ['FBX 的补充材质信息无法读取，已保留原始模型预览。'] };
  }
}

function embeddedMime(bytes) {
  if (bytes?.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes?.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  return null;
}

export async function restoreFbxPbrMaps(object, arrayBuffer, manager = new LoadingManager(), urls = []) {
  const metadata = readBinaryMaterialMetadata(arrayBuffer), warnings = [...metadata.warnings], restoredMaterials = [];
  const materialGroups = new Map(), sourceCounts = new Map(), loaded = new Map();
  for (const material of metadata.materials) sourceCounts.set(material.name, (sourceCounts.get(material.name) || 0) + 1);
  object?.traverse((node) => {
    if (!node.isMesh) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material) {
      const name = cleanName(material.name), group = materialGroups.get(name) || new Set(); group.add(material); materialGroups.set(name, group);
    }
  });
  async function load(descriptor) {
    if (!loaded.has(descriptor.id)) loaded.set(descriptor.id, (async () => {
      let url = descriptor.fileName;
      if (descriptor.embeddedData) {
        const mime = embeddedMime(descriptor.embeddedData);
        if (!mime) throw Error('Unsupported embedded PBR image');
        url = URL.createObjectURL(new Blob([descriptor.embeddedData], { type: mime })); urls.push(url);
      }
      if (!url) throw Error('Missing PBR texture filename');
      const loader = manager.getHandler(url) || new TextureLoader(manager);
      let timer, timedOut = false;
      const promise = loader.loadAsync(url).then((texture) => {
        if (timedOut) { texture.dispose(); throw Error('PBR image load expired'); }
        // The viewer substitutes a white image for missing uploads. A white
        // metallic map would wrongly turn a dielectric surface into solid metal.
        if (manager.reviewMissingTexture?.(url)) { texture.dispose(); throw Error('Missing uploaded PBR image'); }
        texture.colorSpace = NoColorSpace; texture.name = descriptor.name || descriptor.fileName.split(/[\\/]/).at(-1);
        texture.wrapS = descriptor.wrapModeU === 0 ? RepeatWrapping : ClampToEdgeWrapping;
        texture.wrapT = descriptor.wrapModeV === 0 ? RepeatWrapping : ClampToEdgeWrapping;
        if (descriptor.scaling) texture.repeat.fromArray(descriptor.scaling);
        if (descriptor.translation) texture.offset.fromArray(descriptor.translation);
        texture.needsUpdate = true; return texture;
      });
      try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Error('PBR image load timeout')); }, 15000); })]);
      } finally { clearTimeout(timer); }
    })());
    return loaded.get(descriptor.id);
  }
  for (const source of metadata.materials) {
    const slots = Object.keys(source.slots); if (!slots.length) continue;
    const group = materialGroups.get(source.name);
    if (sourceCounts.get(source.name) !== 1 || group?.size !== 1) {
      warnings.push(`材质“${source.name}”无法唯一对应，已跳过自动连接 PBR 贴图。`); continue;
    }
    const material = [...group][0], maps = {};
    for (const slot of slots) try { maps[slot] = await load(source.slots[slot]); }
    catch { warnings.push(`材质“${source.name}”的${slot === 'roughnessMap' ? '粗糙度' : '金属度'}贴图读取失败，已使用中性预览参数。`); }
    if (Object.keys(maps).length) {
      // Keep textures outside userData: Three.js clones userData through JSON.
      // The imported Phong material remains intact for the original-material mode.
      material.reviewPbr = { ...maps, roughness: maps.roughnessMap ? 1 : 0.8, metalness: maps.metalnessMap ? 1 : 0 };
      restoredMaterials.push({ name: source.name, slots: Object.keys(maps) });
    }
  }
  return { restoredMaterials, warnings };
}
