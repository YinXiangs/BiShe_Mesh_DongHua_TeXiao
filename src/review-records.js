const CATEGORY_LABELS = Object.freeze({ scene: '场景建模', character: '角色建模', product: '产品建模', animation: '游戏动画', vfx: '游戏特效' });
const STATUS_LABELS = Object.freeze({ pending: '制作中', review: '待检查', changes: '待修改', approved: '已通过' });
const DIMENSION_LABELS = Object.freeze({ general: '整体建议', overall: '整体建议', topology: '面数与拓扑', material: '材质贴图', structure: '模型结构', normals: '法向检查', animation: '动画表现', vfx: '特效表现' });
const VERDICT_LABELS = Object.freeze({ note: '一般建议', comment: '一般建议', changes: '建议修改', approved: '建议通过' });
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const nullableText = (value) => typeof value === 'string' ? value : null;

function copyContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const context = {};
  for (const key of ['camera', 'target']) {
    if (Array.isArray(input[key]) && input[key].length === 3 && input[key].every(Number.isFinite)) context[key] = [...input[key]];
  }
  for (const key of ['time', 'exposure', 'normalY']) if (Number.isFinite(input[key])) context[key] = input[key];
  for (const key of ['clip', 'mode']) if (typeof input[key] === 'string') context[key] = input[key];
  return context;
}

/** A read-only, portable record. It never writes to local storage or authorizes an import. */
export function buildReviewRecord({ asset, versions = [], comments = [], mode = 'local', exportedAt = new Date().toISOString() } = {}) {
  if (!asset || typeof asset.id !== 'string' || !asset.id) throw new Error('请先打开一件真实作品，再导出评审记录。');
  const exportDate = new Date(exportedAt);
  if (!Number.isFinite(exportDate.getTime())) throw new Error('导出时间无效。');
  const storageMode = ['cloud', 'guest'].includes(mode) ? mode : 'local';
  const local = storageMode === 'local';
  return {
    format: 'qixi-review-record',
    schemaVersion: 1,
    project: '《栖息邮局》',
    exportedAt: exportDate.toISOString(),
    storageMode,
    storageNotice: local ? '本机评审记录：仅从当前浏览器导出，尚未同步到云端或其他设备。' : '共享评审记录的导出副本：导出后不会自动更新，请在网站查看最新记录。',
    recordNotice: '此记录是导出时已保存内容的副本，不包含尚未提交的文字，也不会自动更新。',
    asset: {
      id: asset.id,
      title: text(asset.title),
      category: text(asset.category),
      description: text(asset.description),
      status: text(asset.status),
      teacher_read_at: nullableText(asset.teacher_read_at),
      teacher_read_version_id: nullableText(asset.teacher_read_version_id),
      created_at: nullableText(asset.created_at),
      updated_at: nullableText(asset.updated_at),
    },
    versions: (Array.isArray(versions) ? versions : []).filter((version) => version?.asset_id === asset.id).map((version) => ({
      id: text(version.id),
      asset_id: asset.id,
      number: Number.isSafeInteger(version.number) && version.number > 0 ? version.number : null,
      filename: text(version.filename),
      created_at: nullableText(version.created_at),
    })),
    comments: (Array.isArray(comments) ? comments : []).filter((comment) => comment?.asset_id === asset.id).map((comment) => ({
      id: text(comment.id),
      asset_id: asset.id,
      version_id: nullableText(comment.version_id),
      author_name: text(comment.author_name),
      body: text(comment.body),
      dimension: text(comment.dimension),
      verdict: text(comment.verdict),
      context: copyContext(comment.context),
      created_at: nullableText(comment.created_at),
      is_guest: Boolean(comment.is_guest || comment.guest_link_id),
    })),
  };
}

function beijingTime(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '无法识别的时间：' + String(value);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}（北京时间）`;
}

/** Plain text only: markup and non-ASCII names remain literal text, never HTML. */
export function formatReviewRecordText(record) {
  if (record?.format !== 'qixi-review-record' || record.schemaVersion !== 1 || !record.asset) throw new Error('不是支持的评审记录。');
  const { asset } = record;
  const versions = Array.isArray(record.versions) ? [...record.versions] : [];
  const comments = Array.isArray(record.comments) ? [...record.comments] : [];
  versions.sort((a, b) => (b.number || 0) - (a.number || 0));
  comments.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const readVersion = versions.find((version) => version.id === asset.teacher_read_version_id);
  const versionLabel = (version) => version.number == null ? version.id : `V${version.number}`;
  const lines = [
    '《栖息邮局》作品评审记录',
    `导出时间：${beijingTime(record.exportedAt)}`,
    `保存位置：${record.storageMode === 'local' ? '当前浏览器（本机草稿）' : '共享评审'}`,
    record.storageNotice,
    record.recordNotice,
    '',
    `作品名称：${asset.title || '未命名作品'}`,
    `作品编号：${asset.id}`,
    `作品分类：${CATEGORY_LABELS[asset.category] || asset.category || '未记录'}`,
    `检查状态：${STATUS_LABELS[asset.status] || asset.status || '未记录'}`,
    `制作说明：${asset.description || '未填写'}`,
    `创建时间：${beijingTime(asset.created_at)}`,
    `更新时间：${beijingTime(asset.updated_at)}`,
    `老师已读记录：${asset.teacher_read_version_id ? (readVersion ? versionLabel(readVersion) : asset.teacher_read_version_id) : '尚无已读记录'}`,
    `老师查看时间：${beijingTime(asset.teacher_read_at)}`,
    '',
    `版本记录（${versions.length} 个）`,
    ...(!versions.length ? ['尚未提交版本。'] : versions.map((version) => `${versionLabel(version)} · ${version.filename || '未记录文件名'}\n版本编号：${version.id}\n提交时间：${beijingTime(version.created_at)}`)),
    '',
    `全部版本意见（${comments.length} 条）`,
    '“建议通过”是留言中的建议；作品是否通过以上方“检查状态”为准。',
  ];
  if (!comments.length) lines.push('尚无检查意见。');
  comments.forEach((comment, index) => {
    const version = versions.find((item) => item.id === comment.version_id);
    const relatedVersion = version ? versionLabel(version) : comment.version_id ? `未列出的版本（${comment.version_id}）` : '未关联版本';
    lines.push(
      '',
      `${index + 1}. ${relatedVersion} · ${comment.author_name || '未记录称呼'}${comment.is_guest ? '（访客称呼）' : ''}`,
      `意见编号：${comment.id}`,
      `留言时间：${beijingTime(comment.created_at)}`,
      `检查维度：${DIMENSION_LABELS[comment.dimension] || comment.dimension || '整体建议'}`,
      `留言建议：${VERDICT_LABELS[comment.verdict] || comment.verdict || '一般建议'}`,
      `意见内容：${comment.body || '未填写'}`,
      `查看位置：${comment.context && Object.keys(comment.context).length ? JSON.stringify(comment.context) : '未记录'}`,
    );
  });
  lines.push('', '此文件仅保存作品元数据、版本说明和评审意见，不包含 FBX、MP4 或贴图文件。', '导出与转发此文件不会自动同步网站，也不会更改作品、老师状态或留言。');
  return lines.join('\n');
}
