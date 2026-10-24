import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySubmissionFiles, containImage, MEDIA_SIZE, prepareSubmissionMedia } from '../src/submission-media.js';

const file = (name, size = 100, extras = {}) => ({ name, size, ...extras });
const thumbnail = 'data:image/jpeg;base64,aW1hZ2U=';
const preparedImage = async image => ({ file: file(image.name, 80), thumbnail });

test('remote metadata classification reads names only and never opens FBX or other file bytes', () => {
  const source = { name: 'source.FBX', size: 39_000_000, get arrayBuffer() { throw Error('FBX was accessed'); }, get stream() { throw Error('FBX was accessed'); } };
  const image = { filename: 'front.PNG' }, video = file('walk.MP4'), other = file('texture.tga');
  assert.deepEqual(classifySubmissionFiles([source, image, video, other]), {
    imageFiles: [image], videoFiles: [video], fbxFiles: [source], otherFiles: [other],
  });
});

test('1920 by 1080 layout preserves square, portrait and landscape proportions without cropping', () => {
  assert.deepEqual(MEDIA_SIZE, { width: 1920, height: 1080 });
  assert.deepEqual(containImage(1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(containImage(1080, 1080), { x: 420, y: 0, width: 1080, height: 1080 });
  assert.deepEqual(containImage(540, 1080), { x: 690, y: 0, width: 540, height: 1080 });
  assert.deepEqual(containImage(3840, 1080), { x: 0, y: 270, width: 1920, height: 540 });
  for (const dimensions of [[0, 100], [1, Infinity], [NaN, 1], [-1, 1]]) assert.throws(() => containImage(...dimensions), /尺寸/);
});

test('image submission preserves page order and passes FBX through untouched', async () => {
  const source = file('model.fbx', 39_000_000, { slice() { throw Error('FBX must never be read'); }, arrayBuffer() { throw Error('FBX must never be read'); } });
  const pictures = [file('front.png'), file('side.jpg'), file('back.jpeg'), file('wire.png')];
  const calls = [], progress = [];
  const result = await prepareSubmissionMedia('scene', [source, ...pictures], {
    prepareImage: async (image, options) => { calls.push([image.name, options.width, options.height]); return preparedImage(image); },
    prepareVideo: () => assert.fail('A model submission must not open a video'),
    onProgress: value => progress.push(value),
  });
  assert.deepEqual(calls, pictures.map(picture => [picture.name, 1920, 1080]));
  assert.equal(result.files.at(-1), source);
  assert.equal(result.mainFile, result.files[0]);
  assert.equal(result.thumbnail, thumbnail);
  assert.deepEqual(result.stats, {
    reviewMode: 'media-v1', mediaPreview: true, previewKind: 'images', imageCount: 4,
    width: 1920, height: 1080, media: { images: pictures.map(picture => picture.name), video: null },
  });
  assert.deepEqual(progress.map(value => value.completed), [1, 2, 3, 4]);
  assert.ok(progress.every(value => value.total === 4));
});

test('MP4 is the main preview for animation even when images or FBX are selected first', async () => {
  const source = file('walk.fbx'), video = file('walk.mp4'), image = file('pose.png');
  let videos = 0;
  const result = await prepareSubmissionMedia('animation', [source, image, video], {
    prepareImage: preparedImage,
    prepareVideo: async selected => { videos++; assert.equal(selected, video); return { thumbnail, stats: { width: 1280, height: 720, duration: 4.2 } }; },
  });
  assert.equal(videos, 1);
  assert.equal(result.mainFile, video);
  assert.equal(result.files.at(-1), source);
  assert.equal(result.stats.width, 1280);
  assert.equal(result.stats.duration, 4.2);
  assert.equal(result.stats.media.video, 'walk.mp4');
  assert.deepEqual(result.stats.media.images, ['pose.png']);
});

test('invalid submissions are rejected before any decode and decoding failures do not return an upload', async () => {
  const options = { prepareImage: () => assert.fail('Invalid input decoded'), prepareVideo: () => assert.fail('Invalid input decoded') };
  await assert.rejects(prepareSubmissionMedia('scene', [file('only.fbx')], options), /检查图片/);
  await assert.rejects(prepareSubmissionMedia('animation', [file('pose.png')], options), /MP4/);
  await assert.rejects(prepareSubmissionMedia('scene', [file('front.jpg')], { prepareImage: async () => { throw Error('图片无法解码'); } }), /无法解码/);
  await assert.rejects(prepareSubmissionMedia('vfx', [file('effect.mp4')], { prepareVideo: async () => { throw Error('视频无法解码'); } }), /无法解码/);
});

test('malformed outputs, folder output names and oversized encodings are rejected before upload', async () => {
  for (const output of [{ file: file('front.jpg'), thumbnail: 'https://example.test/a.jpg' }, { file: file('changed.jpg'), thumbnail }, { file: file('front.jpg', 100, { relativePath: 'pictures/front.jpg' }), thumbnail }]) {
    await assert.rejects(prepareSubmissionMedia('scene', [file('front.jpg')], { prepareImage: async () => output }), /预览生成失败|文件名无效/);
  }
  await assert.rejects(prepareSubmissionMedia('scene', [file('front.jpg')], {
    prepareImage: async () => ({ file: file('front.jpg', 201 * 1024 ** 2), thumbnail }),
  }), /单文件/);
});

test('cancelled preparation never yields an upload or proceeds to the next image', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareSubmissionMedia('scene', [file('front.jpg')], { signal: controller.signal, prepareImage: () => assert.fail('Cancelled preparation started') }), { name: 'AbortError' });
  const afterImage = new AbortController();
  let images = 0;
  await assert.rejects(prepareSubmissionMedia('scene', [file('front.jpg'), file('back.jpg')], {
    signal: afterImage.signal,
    prepareImage: async image => { images++; afterImage.abort(); return preparedImage(image); },
  }), { name: 'AbortError' });
  assert.equal(images, 1);
});

test('default image preparation rejects disguised JPG and PNG headers before any browser decode', async () => {
  for (const name of ['front.jpg', 'back.png']) {
    const input = new File(['<html>Not an image</html>'], name, { type: name.endsWith('png') ? 'image/png' : 'image/jpeg' });
    await assert.rejects(prepareSubmissionMedia('scene', [input]), /内容不是有效的/);
  }
});
