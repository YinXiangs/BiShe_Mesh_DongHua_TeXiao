import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaReview } from '../src/media-review.js';

// Small deterministic elements exercise request and lifecycle decisions without
// a browser, image decoding, timers or a network connection.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = new Map(); this.listeners = new Map();
    this.classList = { add() {} }; this.isConnected = true; this.currentTime = 0; this.pauseCount = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  pause() { this.pauseCount++; }
  load() {}
  play() { return Promise.resolve(); }
}

const mediaVersion = (files, more = {}) => ({ files, stats: { reviewMode: 'media-v1' }, ...more });
const file = (id, name, type) => ({ id, name, type, size: 4 });
const bytes = metadata => new File(['data'], metadata.name, { type: metadata.type });
function environment(t, version, downloadFile) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  const host = new Element(), controls = new Element();
  const review = new MediaReview({ host, controls, version, cloud: { downloadFile } });
  t.after(() => { review.destroy(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  return { review, host, controls };
}

test('gallery opens only the first image and reuses completed image pages without downloading FBX or MP4', async t => {
  const images = [file('front', 'front.png', 'image/png'), file('side', 'side.jpg', 'image/jpeg')];
  const calls = [];
  const { review, host } = environment(t, mediaVersion([...images, file('fbx', 'model.fbx'), file('video', 'walk.mp4', 'video/mp4')]), async metadata => {
    calls.push(metadata.id); return bytes(metadata);
  });
  await review.start(); assert.deepEqual(calls, ['front']); assert.equal(host.children[0].tagName, 'img');
  await review.showPage(1); assert.deepEqual(calls, ['front', 'side']);
  assert.deepEqual(review.context(), { mediaIndex: 1, filename: 'side.jpg', mediaType: 'image' });
  await review.showPage(0); await review.showPage(1); assert.deepEqual(calls, ['front', 'side']);
  await review.showPage(2); assert.deepEqual(calls, ['front', 'side']); assert.equal(review.context().mediaType, 'video');
  assert.equal(review.video, undefined);
});

test('MP4 remains lazy until explicit playback and keeps timepoint context separate from the FBX attachment', async t => {
  const calls = [];
  const { review, host } = environment(t, mediaVersion([file('fbx', 'rig.fbx'), file('video', 'action.mp4', 'video/mp4')]), async metadata => {
    calls.push(metadata.id); return bytes(metadata);
  });
  await review.start(); assert.deepEqual(calls, []); assert.equal(review.context().mediaType, 'video');
  await review.playVideo(review.plan.slides[0], review.serial);
  assert.deepEqual(calls, ['video']); assert.equal(host.children[0].tagName, 'video'); assert.equal(review.video.preload, 'none');
  review.video.currentTime = 2.5;
  assert.deepEqual(review.context(), { mediaIndex: 0, filename: 'action.mp4', mediaType: 'video', time: 2.5 });
  await review.restore({ mediaIndex: 0, time: 1.2 });
  assert.deepEqual(calls, ['video']); assert.equal(review.video.currentTime, 1.2); assert.equal(review.video.pauseCount, 1);
});

test('a legacy FBX version with texture maps has no automatic media requests', async t => {
  const calls = [];
  const { review, host } = environment(t, { filename: 'rock.fbx', files: [file('fbx', 'rock.fbx'), file('albedo', 'albedo.png', 'image/png')] }, async metadata => {
    calls.push(metadata.id); return bytes(metadata);
  });
  await review.start(); assert.deepEqual(calls, []); assert.equal(review.plan.slides.length, 0);
  assert.equal(host.children[0].children[0].textContent, '待补充三视图或视频');
});

test('rapid page changes cancel obsolete requests and never replace the current image with a late response', async t => {
  const requests = [];
  const { review, host } = environment(t, mediaVersion([file('front', 'front.png', 'image/png'), file('back', 'back.png', 'image/png')]), (metadata, options) => new Promise(resolve => {
    requests.push({ metadata, ...options, resolve });
  }));
  const first = review.start(); const second = review.showPage(1);
  assert.equal(requests.length, 2); assert(requests[0].signal.aborted);
  requests[1].resolve(bytes(requests[1].metadata)); await second;
  const currentImage = host.children[0]; assert(currentImage.alt.includes('back.png'));
  requests[0].resolve(bytes(requests[0].metadata)); await first;
  assert.equal(host.children[0], currentImage); assert.equal(review.cache.size, 1); assert(!review.cache.has('front'));
  const revisit = review.showPage(0); assert.equal(requests.length, 3);
  requests[2].resolve(bytes(requests[2].metadata)); await revisit;
  await review.showPage(1); assert.equal(requests.length, 3);
});

test('destroy aborts an unfinished preview and discards its late file without a blob URL or DOM update', async t => {
  let pending;
  const { review, host } = environment(t, mediaVersion([file('front', 'front.png', 'image/png')]), (metadata, options) => new Promise(resolve => { pending = { metadata, ...options, resolve }; }));
  const start = review.start(); const before = host.children[0]; review.destroy();
  assert(pending.signal.aborted); pending.resolve(bytes(pending.metadata)); await start;
  assert.equal(host.children[0], before); assert.equal(review.cache.size, 0); assert.equal(review.urls.size, 0);
});

test('comment restoration loads its recorded image page and never preloads the remaining pages', async t => {
  const calls = [];
  const { review } = environment(t, mediaVersion([file('front', 'front.png', 'image/png'), file('side', 'side.png', 'image/png'), file('back', 'back.png', 'image/png')]), async metadata => { calls.push(metadata.id); return bytes(metadata); });
  await review.restore({ mediaIndex: 2, filename: 'back.png', mediaType: 'image' });
  assert.deepEqual(calls, ['back']); assert.equal(review.index, 2); assert.equal(review.context().filename, 'back.png');
});

test('a lightweight review image replaces the existing cover without requesting the original; original remains click-only', async t => {
  const cover = 'data:image/jpeg;base64,Y292ZXI=';
  let resolvePreview; const calls = [];
  const version = mediaVersion([file('front', 'front.png', 'image/png')], { stats: { reviewMode: 'media-v1', thumbnail: cover } });
  const { review, host } = environment(t, version, async metadata => { calls.push('original:' + metadata.id); return bytes(metadata); });
  review.cloud.downloadImagePreview = async metadata => { calls.push('preview:' + metadata.id); return new Promise(resolve => { resolvePreview = resolve; }); };
  const pending = review.start();
  assert.equal(host.children[0].src, cover); assert.deepEqual(calls, ['preview:front']);
  resolvePreview(bytes(version.files[0])); await pending;
  assert(host.children[1].children[1].textContent.startsWith('查看原图'));
  await host.children[1].children[1].onclick();
  // The click handler intentionally starts an asynchronous page transition.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['preview:front', 'original:front']);
  assert.equal(host.children[1].children[1].textContent, '返回评审图');
  await review.showPage(0); assert.deepEqual(calls, ['preview:front', 'original:front']);
});

test('missing derived preview falls back only to its image, while network failures do not start a larger download', async t => {
  const calls = [];
  const { review, host } = environment(t, mediaVersion([file('front', 'front.png', 'image/png'), file('side', 'side.png', 'image/png')]), async metadata => { calls.push(metadata.id); return bytes(metadata); });
  review.cloud.downloadImagePreview = async metadata => { throw Object.assign(Error('preview unavailable'), { status: metadata.id === 'front' ? 404 : 503 }); };
  await review.start(); assert.deepEqual(calls, ['front']);
  await review.showPage(1); assert.deepEqual(calls, ['front']);
  assert.equal(host.children[0].children[0].textContent, '预览加载未完成');
});
