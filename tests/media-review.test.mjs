import test from 'node:test';
import assert from 'node:assert/strict';
import { planReviewMedia, boundedMediaIndex } from '../src/media-review.js';

test('new review selects ordered images and separates the FBX attachment', () => {
  const files = [{ id: 'fbx', name: 'model.fbx' }, { id: 'a', name: 'front.png' }, { id: 'b', name: 'side.jpg' }];
  const plan = planReviewMedia({ files, stats: { reviewMode: 'media-v1', media: { images: ['side.jpg', 'front.png'] } } });
  assert.deepEqual(plan.slides.map(slide => slide.file.id), ['b', 'a']);
  assert.equal(plan.attachment.id, 'fbx');
  assert.ok(plan.slides.every(slide => !slide.file.name.endsWith('.fbx')));
});

test('legacy FBX textures never become review pictures or preview downloads', () => {
  const plan = planReviewMedia({ filename: 'model.fbx', files: [{ name: 'model.fbx' }, { name: 'albedo.png' }, { name: 'normal.png' }] });
  assert.equal(plan.slides.length, 0);
  assert.equal(plan.attachment.name, 'model.fbx');
  assert.equal(plan.empty, false);
});

test('animation MP4 and original FBX have distinct jobs', () => {
  const plan = planReviewMedia({ files: [{ name: 'action.fbx' }, { name: 'action.mp4' }], stats: { reviewMode: 'media-v1' } });
  assert.deepEqual(plan.slides.map(slide => slide.kind), ['video']);
  assert.equal(plan.video.name, 'action.mp4');
  assert.equal(plan.attachment.name, 'action.fbx');
});

test('gallery respects four picture maximum and bounds navigation', () => {
  const plan = planReviewMedia({ filename: 'first.png', files: Array.from({ length: 7 }, (_, i) => ({ name: i + '.png' })) });
  assert.equal(plan.images.length, 4);
  assert.equal(boundedMediaIndex(-1, 4), 0); assert.equal(boundedMediaIndex(8, 4), 3); assert.equal(boundedMediaIndex(0, 0), 0);
});
