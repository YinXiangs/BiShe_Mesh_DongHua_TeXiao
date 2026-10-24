export const CATEGORIES = Object.freeze(['scene', 'character', 'product', 'animation', 'vfx']);
export const ASSET_STATUSES = Object.freeze(['pending', 'review', 'changes', 'approved']);
export const FILE_LIMITS = Object.freeze({ maxFileBytes: 200 * 1024 ** 2, maxTotalBytes: 300 * 1024 ** 2 });
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);
const SCRIPT_MIME = /(?:javascript|ecmascript|html|svg\+xml|x-sh|x-bat|x-msdownload|x-httpd-php)/i;

export function validateText(value, { label = '内容', min = 1, max = 4000 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw new Error(`请填写${label}。`);
  if (text.length > max) throw new Error(`${label}最多 ${max} 个字符。`);
  return text;
}

export function relativeFilePath(file) {
  const input = file?.relativePath || file?.webkitRelativePath || file?.name;
  if (typeof input !== 'string' || !input.trim()) throw new Error('文件名称无效。');
  const path = input.normalize('NFC').replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error(`文件路径不安全：${file?.name || input}`);
  }
  if (path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`文件路径不安全：${file?.name || input}`);
  }
  return path;
}

export function validateFiles(category, inputFiles, limits = FILE_LIMITS) {
  if (!CATEGORIES.includes(category)) throw new Error('请选择有效的项目分类。');
  const files = Array.from(inputFiles || []);
  const videoRequired = category === 'animation' || category === 'vfx';
  if (!files.length) throw new Error(videoRequired ? '请选择一个 MP4 预览视频，可附图片和 FBX 原件。' : '请选择 1–4 张 JPG / PNG 模型检查图片，可附 FBX 原件。');
  const maxFileBytes = limits.maxFileBytes ?? FILE_LIMITS.maxFileBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? FILE_LIMITS.maxTotalBytes;
  if (!(maxFileBytes > 0) || !(maxTotalBytes > 0)) throw new Error('文件大小限制配置无效。');
  const imageFiles = [];
  const videoFiles = [];
  const fbxFiles = [];
  const paths = new Set();
  const basenames = new Map();
  let totalBytes = 0;

  for (const file of files) {
    if (typeof file?.name !== 'string' || !file.name.trim() || /[\\/]/.test(file.name)) throw new Error('文件名称无效。');
    const path = relativeFilePath(file);
    const key = path.toLocaleLowerCase('en-US');
    const basename = path.split('/').at(-1).toLocaleLowerCase('en-US');
    if (basename !== file.name.normalize('NFC').toLocaleLowerCase('en-US')) throw new Error(`文件名与路径不一致：${file.name}`);
    if (paths.has(key)) throw new Error(`重复文件路径：${path}。请移除重复文件后重试。`);
    if (basenames.has(basename)) throw new Error(`发现同名文件：${file.name}（${basenames.get(basename)} / ${path}）。请重命名后重新选择。`);
    paths.add(key);
    basenames.set(basename, path);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`文件为空或大小无效：${file.name}`);
    if (file.size > maxFileBytes) throw new Error(`${file.name} 超过单文件 ${Math.round(maxFileBytes / 1024 ** 2)} MiB 限制。`);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) throw new Error(`本次提交超过 ${Math.round(maxTotalBytes / 1024 ** 2)} MiB 总大小限制。`);
    const extension = basename.includes('.') ? basename.split('.').at(-1) : '';
    if (SCRIPT_MIME.test(file.type || '')) throw new Error(`不允许上传脚本或网页文件：${file.name}`);
    if (IMAGE_EXTENSIONS.has(extension)) imageFiles.push(file);
    else if (extension === 'mp4' && videoRequired) videoFiles.push(file);
    else if (extension === 'fbx') fbxFiles.push(file);
    else throw new Error(`不支持的文件：${file.name}。${videoRequired ? '请提交 MP4、JPG / PNG 和可选 FBX 原件。' : '模型检查仅接受 JPG / PNG 和可选 FBX 原件。'}`);
  }
  if (imageFiles.length > 4) throw new Error('每个作品版本最多提交 4 张 JPG / PNG 检查图片。');
  if (fbxFiles.length > 1) throw new Error('每个版本最多附加一个 FBX 原件，请分别提交多个作品。');
  if (videoRequired && videoFiles.length !== 1) throw new Error('动画和特效每个版本必须包含且仅包含一个 MP4 预览视频。');
  if (!videoRequired && !imageFiles.length) throw new Error('请提交 1–4 张 JPG / PNG 模型检查图片，FBX 原件仅供点击下载。');
  const mainFile = videoRequired ? videoFiles[0] : imageFiles[0];
  return { mainFile, textureFiles: [], imageFiles, videoFile: videoFiles[0] || null, fbxFile: fbxFiles[0] || null, totalBytes, previewKind: videoRequired ? 'video' : 'images' };
}

export function validateAsset(asset) {
  if (!asset || typeof asset !== 'object') throw new Error('项目数据无效。');
  const id = validateText(asset.id, { label: '项目编号', max: 200 });
  const title = validateText(asset.title, { label: '项目名称', max: 100 });
  if (!CATEGORIES.includes(asset.category)) throw new Error('请选择有效的项目分类。');
  if (!ASSET_STATUSES.includes(asset.status)) throw new Error('项目状态无效。');
  const description = validateText(asset.description || '', { label: '项目说明', min: 0, max: 4000 });
  return { ...asset, id, title, description };
}

export function validateVersion(version) {
  if (!version || typeof version !== 'object') throw new Error('版本数据无效。');
  const id = validateText(version.id, { label: '版本编号', max: 200 });
  const asset_id = validateText(version.asset_id, { label: '项目编号', max: 200 });
  if (!Number.isSafeInteger(version.number) || version.number < 1) throw new Error('版本号必须是大于零的整数。');
  const filename = validateText(version.filename, { label: '主文件名', max: 255 });
  return { ...version, id, asset_id, filename };
}

export function validateComment(comment) {
  if (!comment || typeof comment !== 'object') throw new Error('评语数据无效。');
  const id = validateText(comment.id, { label: '评语编号', max: 200 });
  const asset_id = validateText(comment.asset_id, { label: '项目编号', max: 200 });
  const author_name = validateText(comment.author_name, { label: '姓名', max: 60 });
  const body = validateText(comment.body, { label: '评语', max: 5000 });
  const dimension = validateText(comment.dimension || 'overall', { label: '检查维度', max: 60 });
  const verdict = validateText(comment.verdict || 'comment', { label: '评审结论', max: 60 });
  const version_id = comment.version_id == null ? null : validateText(comment.version_id, { label: '版本编号', max: 200 });
  return { ...comment, id, asset_id, author_name, body, dimension, verdict, version_id, context: comment.context ?? null };
}
