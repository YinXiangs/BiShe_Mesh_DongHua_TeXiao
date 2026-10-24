import { relativeFilePath, validateFiles } from './validation.js';

export const MEDIA_SIZE = Object.freeze({ width: 1920, height: 1080 });
export const REVIEW_PREVIEW_MAX_BYTES = 512 * 1024;
const THUMBNAIL_SIZE = Object.freeze({ width: 480, height: 270 });
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const extension = file => String(file?.name || file?.filename || '').split('.').at(-1).toLowerCase();
const cancelled = () => Object.assign(Error('已取消准备预览文件。'), { name: 'AbortError' });
function checkSignal(signal) { if (signal?.aborted) throw cancelled(); }

// This inspects names only, so callers can classify remote metadata without
// downloading an FBX. Legacy texture files must not be passed off as review images.
export function classifySubmissionFiles(inputFiles) {
  const imageFiles = [], videoFiles = [], fbxFiles = [], otherFiles = [];
  for (const file of Array.from(inputFiles || [])) {
    const ext = extension(file);
    if (IMAGE_EXTENSIONS.has(ext)) imageFiles.push(file);
    else if (ext === 'mp4') videoFiles.push(file);
    else if (ext === 'fbx') fbxFiles.push(file);
    else otherFiles.push(file);
  }
  return { imageFiles, videoFiles, fbxFiles, otherFiles };
}

// Pure layout planning is also shared by the full-size image and its thumbnail.
export function containImage(width, height, target = MEDIA_SIZE) {
  if (![width, height, target.width, target.height].every(value => Number.isFinite(value) && value > 0)) throw Error('图片尺寸无效。');
  const scale = Math.min(target.width / width, target.height / height);
  const drawWidth = width * scale, drawHeight = height * scale;
  return { x: (target.width - drawWidth) / 2, y: (target.height - drawHeight) / 2, width: drawWidth, height: drawHeight };
}

// Only local JPG/PNG and MP4 are decoded. The FBX File is returned untouched and
// must only be fetched by the review page after an explicit download click.
export async function prepareSubmissionMedia(category, inputFiles, options = {}) {
  const plan = validateFiles(category, inputFiles);
  const prepareImage = options.prepareImage || browserPrepareImage;
  const prepareVideo = options.prepareVideo || browserPrepareVideo;
  const signal = options.signal;
  const files = [], preparedImages = [];
  let completed = 0;
  const total = plan.imageFiles.length + Number(Boolean(plan.videoFile));
  checkSignal(signal);
  for (const image of plan.imageFiles) {
    checkSignal(signal);
    const prepared = await prepareImage(image, { signal, width: MEDIA_SIZE.width, height: MEDIA_SIZE.height });
    checkSignal(signal);
    if (!prepared?.file || !isThumbnail(prepared.thumbnail)) throw Error(`图片预览生成失败：${image.name}`);
    // Flatten browser folder selections; basename uniqueness was validated above.
    if (prepared.file.name !== image.name || relativeFilePath(prepared.file) !== image.name) throw Error('检查图片的输出文件名无效。');
    files.push(prepared.file);
    preparedImages.push(prepared);
    options.onProgress?.({ completed: ++completed, total, filename: image.name });
  }
  let videoPreview;
  if (plan.videoFile) {
    checkSignal(signal);
    videoPreview = await prepareVideo(plan.videoFile, { signal });
    checkSignal(signal);
    if (!isThumbnail(videoPreview?.thumbnail)) throw Error('MP4 封面生成失败，请重新导出可播放的视频。');
    files.push(plan.videoFile);
    options.onProgress?.({ completed: ++completed, total, filename: plan.videoFile.name });
  }
  if (plan.fbxFile) files.push(plan.fbxFile);
  const finalPlan = validateFiles(category, files);
  const stats = {
    reviewMode: 'media-v1', mediaPreview: true, previewKind: plan.previewKind,
    imageCount: preparedImages.length,
    width: videoPreview?.stats?.width || MEDIA_SIZE.width,
    height: videoPreview?.stats?.height || MEDIA_SIZE.height,
    ...(videoPreview?.stats?.duration != null ? { duration: videoPreview.stats.duration } : {}),
    media: { images: preparedImages.map(image => image.file.name), video: plan.videoFile?.name || null },
  };
  return { files, mainFile: finalPlan.mainFile, thumbnail: videoPreview?.thumbnail || preparedImages[0]?.thumbnail, stats,
    imagePreviews: preparedImages.filter(image => image.preview).map(image => ({ name: image.file.name, blob: image.preview })) };
}

function isThumbnail(value) { return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value); }

function bounded(operation, { signal, milliseconds = 20000, message = '预览文件读取超时，请重试。' } = {}) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, cancelled());
    const timer = setTimeout(() => finish(reject, Error(message)), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function verifyImageHeader(file, signal) {
  const bytes = new Uint8Array(await bounded(file.slice(0, 16).arrayBuffer(), { signal }));
  const ext = extension(file);
  const valid = ext === 'png'
    ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw Error(`${file.name} 的内容不是有效的 ${ext === 'png' ? 'PNG' : 'JPG'} 图片，请重新导出。`);
}

function ready(element, events, predicate, { signal, milliseconds = 20000, message }) {
  checkSignal(signal);
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      for (const event of events) element.removeEventListener(event, check);
      element.removeEventListener('error', failed);
    };
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const failed = () => { cleanup(); reject(Error(message)); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(failed, milliseconds);
    for (const event of events) element.addEventListener(event, check);
    element.addEventListener('error', failed);
    signal?.addEventListener('abort', abort, { once: true });
    if (element.error) failed(); else check();
  });
}

function canvasFor(source, width, height, sourceWidth, sourceHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw Error('当前浏览器无法准备检查图片，请更换浏览器后重试。');
  context.fillStyle = '#151e1a'; context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  const rectangle = containImage(sourceWidth, sourceHeight, { width, height });
  context.drawImage(source, rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  return canvas;
}

function thumbnailFrom(source, width, height) {
  const canvas = canvasFor(source, THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height, width, height);
  try { return canvas.toDataURL('image/jpeg', 0.82); }
  finally { canvas.width = canvas.height = 1; }
}

// A separate JPEG keeps every review page at 1920×1080 while preserving the
// submitted PNG/JPG. Neither the FBX nor the original image is replaced.
export async function encodeReviewPreview(canvas, { signal } = {}) {
  for (const quality of [0.78, 0.65, 0.5, 0.36]) {
    checkSignal(signal);
    const blob = await bounded(new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error('评审图片编码失败。')), 'image/jpeg', quality)), { signal });
    checkSignal(signal);
    if (blob.type !== 'image/jpeg') throw Error('当前浏览器无法生成 JPG 评审图片。');
    if (blob.size <= REVIEW_PREVIEW_MAX_BYTES) return blob;
  }
  throw Error('图片细节过多，无法生成轻量评审图，请降低噪点后重试。');
}

async function browserPrepareImage(file, { signal }) {
  await verifyImageHeader(file, signal);
  checkSignal(signal);
  const image = document.createElement('img'), url = URL.createObjectURL(file);
  let canvas;
  try {
    image.src = url;
    await ready(image, ['load'], () => image.complete && image.naturalWidth > 0, {
      signal, message: `无法解码图片 ${file.name}，请使用有效的 JPG / PNG。`,
    });
    // Some browsers defer decoding until drawImage. Finish it asynchronously
    // first, keeping corrupt files and decode waits inside the bounded error path.
    if (typeof image.decode === 'function') {
      try { await bounded(image.decode(), { signal, message: `图片解码超时：${file.name}，请缩小图片后重试。` }); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        throw Error(`无法完整解码图片 ${file.name}，请重新导出 JPG / PNG。`, { cause: error });
      }
    }
    checkSignal(signal);
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width * height > 100_000_000) throw Error(`${file.name} 的分辨率过高，请缩小图片后重试。`);
    canvas = canvasFor(image, MEDIA_SIZE.width, MEDIA_SIZE.height, width, height);
    const type = extension(file) === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await bounded(new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error(`无法编码图片 ${file.name}。`)), type, 0.9)), { signal });
    checkSignal(signal);
    if (blob.type !== type) throw Error(`浏览器未能生成正确的 ${type === 'image/png' ? 'PNG' : 'JPG'} 格式，请更换浏览器重试。`);
    const output = new File([blob], file.name, { type, lastModified: file.lastModified || Date.now() });
    return { file: output, thumbnail: thumbnailFrom(canvas, canvas.width, canvas.height), preview: await encodeReviewPreview(canvas, { signal }) };
  } finally {
    image.removeAttribute('src'); image.remove(); URL.revokeObjectURL(url);
    if (canvas) canvas.width = canvas.height = 1;
  }
}

async function browserPrepareVideo(file, { signal }) {
  checkSignal(signal);
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  const deadline = Date.now() + 20000;
  const wait = (events, predicate) => ready(video, events, predicate, {
    signal, milliseconds: Math.max(1, deadline - Date.now()),
    message: '视频封面读取失败或超时，请使用 H.264 / AAC 编码的 MP4 后重试。',
  });
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  try {
    video.src = url; video.load();
    await wait(['loadedmetadata', 'durationchange'], () => video.readyState >= 1);
    if (!video.videoWidth || !video.videoHeight) throw Error('MP4 没有可读取的画面。');
    await wait(['loadeddata', 'canplay'], () => video.readyState >= 2);
    if (Number.isFinite(video.duration) && video.duration > 0.1) {
      const time = Math.min(1, video.duration * 0.2);
      video.currentTime = time;
      await wait(['seeked', 'loadeddata', 'canplay'], () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.1);
    }
    checkSignal(signal);
    return { thumbnail: thumbnailFrom(video, video.videoWidth, video.videoHeight), stats: {
      width: video.videoWidth, height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : null,
    } };
  } finally {
    video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
  }
}
