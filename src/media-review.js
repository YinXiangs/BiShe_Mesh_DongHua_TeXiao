import { validPreview } from './preview-cache.js';

export const MEDIA_REVIEW_REVISION = 'media-v1';
const imageFile = file => /\.(?:jpe?g|png)$/i.test(file?.name || '');
const videoFile = file => /\.mp4$/i.test(file?.name || '');
const fbxFile = file => /\.fbx$/i.test(file?.name || '');

/** A preview plan never includes FBX data. Legacy texture maps aren't review images. */
export function planReviewMedia(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  const stats = version?.stats || {};
  const imagesAllowed = stats.reviewMode === MEDIA_REVIEW_REVISION || imageFile({ name: version?.filename });
  let images = imagesAllowed ? files.filter(imageFile).slice(0, 4) : [];
  const order = Array.isArray(stats.media?.images) ? stats.media.images : [];
  if (order.length) images = [...images].sort((a, b) => {
    const position = file => { const i = order.findIndex(name => name === file.relative_path || name === file.name); return i < 0 ? order.length : i; };
    return position(a) - position(b);
  });
  const video = files.find(videoFile) || null;
  const slides = images.map(file => ({ kind: 'image', file }));
  if (video) slides.push({ kind: 'video', file: video });
  const thumbnail = validPreview(stats.thumbnail) ? stats.thumbnail : null;
  if (!slides.length && thumbnail) slides.push({ kind: 'thumbnail', thumbnail });
  const retained = stats.downloadAttachment;
  const attachment = files.find(fbxFile) || (retained && typeof retained.id === 'string' && fbxFile(retained) ? retained : null);
  return { images, video, slides, attachment, thumbnail,
    legacy: stats.reviewMode !== MEDIA_REVIEW_REVISION, empty: files.length === 0 };
}

export function boundedMediaIndex(index, length) {
  return Math.max(0, Math.min(Math.max(0, length - 1), Number.isInteger(index) ? index : 0));
}

const byteLabel = bytes => (Number(bytes || 0) / 1048576).toFixed(1) + ' MB';

/** Only the visible image or an explicitly requested MP4 is fetched. */
export class MediaReview {
  constructor({ host, controls, version, cloud, onReady = () => {}, onUpdate = () => {} }) {
    this.host = host; this.controls = controls; this.version = version; this.cloud = cloud;
    this.onReady = onReady; this.onUpdate = onUpdate; this.plan = planReviewMedia(version);
    this.index = 0; this.serial = 0; this.dead = false; this.urls = new Set(); this.cache = new Map();
    this.host.classList.add('media-review-host'); this.host.tabIndex = 0;
    this.keydown = event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); const target = boundedMediaIndex(this.index + (event.key === 'ArrowLeft' ? -1 : 1), this.plan.slides.length); if (target !== this.index) void this.showPage(target);
      }
    };
    this.pointerdown = event => { this.pointer = { x: event.clientX, y: event.clientY }; };
    this.pointerup = event => {
      if (!this.pointer || event.target.closest('video,button')) return;
      const dx = event.clientX - this.pointer.x, dy = event.clientY - this.pointer.y; this.pointer = null;
      if (Math.abs(dx) > 55 && Math.abs(dy) < 75) void this.showPage(this.index + (dx < 0 ? 1 : -1));
    };
    this.host.addEventListener('keydown', this.keydown);
    this.host.addEventListener('pointerdown', this.pointerdown);
    this.host.addEventListener('pointerup', this.pointerup);
  }
  async start() { await this.showPage(0); }
  current() { return !this.dead && this.host.isConnected; }
  releaseVideo() {
    if (!this.video) return;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video = null;
  }
  navigation() {
    this.controls.replaceChildren();
    if (this.plan.slides.length < 2) return;
    const nav = document.createElement('nav'); nav.className = 'media-pagination'; nav.setAttribute('aria-label', '作品图片与视频翻页');
    const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'button ghost'; previous.textContent = '← 上一张'; previous.disabled = this.index === 0;
    previous.onclick = () => void this.showPage(this.index - 1);
    const pages = document.createElement('div'); pages.className = 'media-page-buttons';
    this.plan.slides.forEach((slide, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'media-page-button' + (index === this.index ? ' active' : '');
      button.textContent = slide.kind === 'video' ? '视频' : String(index + 1); button.setAttribute('aria-label', slide.kind === 'video' ? '查看 MP4 视频' : '查看第 ' + (index + 1) + ' 张图片');
      if (index === this.index) { button.setAttribute('aria-current', 'page'); button.disabled = true; }
      button.onclick = () => void this.showPage(index); pages.append(button);
    });
    const next = document.createElement('button'); next.type = 'button'; next.className = 'button ghost'; next.textContent = '下一张 →'; next.disabled = this.index === this.plan.slides.length - 1;
    next.onclick = () => void this.showPage(this.index + 1);
    const count = document.createElement('span'); count.className = 'media-page-count'; count.setAttribute('aria-live', 'polite'); count.textContent = (this.index + 1) + ' / ' + this.plan.slides.length;
    nav.append(previous, pages, count, next); this.controls.append(nav);
  }
  message(title, text = '') {
    const box = document.createElement('div'); box.className = 'viewer-empty media-message'; box.setAttribute('aria-live', 'polite');
    const heading = document.createElement('h3'); heading.textContent = title;
    const detail = document.createElement('p'); detail.textContent = text; box.append(heading, detail); this.host.replaceChildren(box);
    return { box, detail };
  }
  async getFile(file, progress, signal) {
    if (this.cache.has(file.id)) return this.cache.get(file.id);
    const result = await this.cloud.downloadFile(file, { onProgress: progress, signal });
    if (signal.aborted || !this.current()) throw Object.assign(Error('已取消预览。'), { name: 'AbortError' });
    const url = URL.createObjectURL(result); this.urls.add(url); this.cache.set(file.id, url); return url;
  }
  async showPage(index) {
    if (!this.current()) return;
    this.controller?.abort(); this.controller = new AbortController();
    this.releaseVideo(); this.index = boundedMediaIndex(index, this.plan.slides.length); const serial = ++this.serial;
    this.navigation();
    const slide = this.plan.slides[this.index]; this.onUpdate(this.context());
    if (!slide) {
      this.message(this.plan.empty ? '尚未提交预览内容' : '待补充三视图或视频',
        this.plan.empty ? '模型提交 JPG / PNG，动画与特效提交 MP4。' : '此版本的 FBX 已保留，请点击上方“下载 FBX”检查。学生可以提交图片或视频新版本。');
      this.onReady(); return;
    }
    if (slide.kind === 'video') {
      const { box } = this.message('MP4 视频评审', '点击下方按钮加载并播放，不会下载 FBX。');
      if (this.plan.thumbnail) { const poster = document.createElement('img'); poster.className = 'media-video-poster'; poster.src = this.plan.thumbnail; poster.alt = '视频封面'; box.prepend(poster); }
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button primary'; button.textContent = '加载并播放 MP4 · ' + byteLabel(slide.file.size);
      button.onclick = () => void this.playVideo(slide, serial); box.append(button); return;
    }
    const { detail } = this.message('正在加载图片…');
    try {
      const src = slide.kind === 'thumbnail' ? slide.thumbnail : await this.getFile(slide.file, ({ received, total }) => {
        if (this.current() && serial === this.serial) detail.textContent = byteLabel(received) + (total ? ' / ' + byteLabel(total) : '');
      }, this.controller.signal);
      if (!this.current() || serial !== this.serial) return;
      const image = document.createElement('img'); image.className = 'review-image'; image.alt = slide.kind === 'thumbnail' ? '已有版本预览图片' : '第 ' + (this.index + 1) + ' 张作品图片 · ' + slide.file.name;
      image.onload = () => { if (this.current() && serial === this.serial) { this.onReady(); this.onUpdate(this.context()); } };
      image.onerror = () => this.failed('图片无法显示，请重新提交 JPG 或 PNG。', serial);
      image.src = src; this.host.replaceChildren(image);
      if (slide.kind === 'thumbnail') { const note = document.createElement('span'); note.className = 'media-legacy-note'; note.textContent = '已有预览图 · 可提交三视图新版本'; this.host.append(note); }
    } catch (error) { if (error.name !== 'AbortError') this.failed(error.message, serial); }
  }
  failed(message, serial) {
    if (!this.current() || serial !== this.serial) return;
    const { box } = this.message('预览加载未完成', message);
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button ghost'; retry.textContent = '重新加载'; retry.onclick = () => void this.showPage(this.index); box.append(retry);
  }
  async playVideo(slide, serial) {
    if (!this.current() || serial !== this.serial) return;
    const { detail } = this.message('正在加载 MP4…');
    try {
      const src = await this.getFile(slide.file, ({ received, total }) => {
        if (this.current() && serial === this.serial) detail.textContent = byteLabel(received) + (total ? ' / ' + byteLabel(total) : '');
      }, this.controller.signal);
      if (!this.current() || serial !== this.serial) return;
      const video = document.createElement('video'); video.className = 'video-preview review-video'; video.controls = true; video.playsInline = true; video.preload = 'none';
      if (this.plan.thumbnail) video.poster = this.plan.thumbnail;
      video.onloadeddata = () => { if (this.current() && serial === this.serial) this.onReady(); };
      video.onloadedmetadata = () => this.onUpdate(this.context());
      video.onerror = () => this.failed('视频无法播放，请导出为 H.264 / AAC 编码的 MP4。', serial);
      this.video = video; video.src = src; this.host.replaceChildren(video); await video.play().catch(() => {});
    } catch (error) { if (error.name !== 'AbortError') this.failed(error.message, serial); }
  }
  context() {
    const slide = this.plan.slides[this.index];
    return { mediaIndex: this.index, ...(slide?.file ? { filename: slide.file.name } : {}),
      ...(slide ? { mediaType: slide.kind } : {}), ...(this.video ? { time: this.video.currentTime } : {}) };
  }
  async restore(context = {}) {
    const index = Number.isInteger(context.mediaIndex) ? context.mediaIndex : Number.isFinite(context.time) ? this.plan.slides.findIndex(slide => slide.kind === 'video') : 0;
    await this.showPage(index);
    const slide = this.plan.slides[this.index];
    if (slide?.kind === 'video' && Number.isFinite(context.time)) {
      await this.playVideo(slide, this.serial);
      if (this.video) { this.video.pause(); this.video.currentTime = Math.max(0, context.time); }
    }
  }
  destroy() {
    this.dead = true; this.serial++; this.controller?.abort(); this.releaseVideo();
    this.host.removeEventListener('keydown', this.keydown); this.host.removeEventListener('pointerdown', this.pointerdown); this.host.removeEventListener('pointerup', this.pointerup);
    for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear(); this.cache.clear();
  }
}
