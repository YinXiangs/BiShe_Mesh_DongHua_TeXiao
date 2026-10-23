// This is a public site's entry workflow, not server-side authentication.
// Server permissions and shared storage still need their own authenticated backend.
const TEACHER_DIGEST = '8343021f8a97747e7bf59d1a3099c5ba68e39c8d38df96dbdc3027cbff7698de';
const STUDENT_DIGEST = 'bc5fdcd9105691d6914563b7e615d3e2fa2ad9a8a97fb4369c71216f2f3c313c';
const ENTRY_SESSION_KEY = 'qixi-entry-session-v1';
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const ROLES = new Set(['teacher', 'student']);

function entryStorage(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage; } catch { return null; }
}

/** Public fingerprint only: short access codes remain guessable from public code. */
export async function digestPassword(password) {
  if (typeof password !== 'string') throw new TypeError('请输入有效的访问密码。');
  const input = new TextEncoder().encode('qixi-entry-v1:' + password);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyEntryPassword(password) {
  if (typeof password !== 'string' || !password) return null;
  const digest = await digestPassword(password);
  if (digest === TEACHER_DIGEST) return 'teacher';
  if (digest === STUDENT_DIGEST) return 'student';
  return null;
}

export function readEntrySession(storage, now = Date.now()) {
  const target = entryStorage(storage);
  if (!Number.isFinite(now)) return null;
  try {
    const saved = JSON.parse(target?.getItem(ENTRY_SESSION_KEY) || 'null');
    if (!saved || !ROLES.has(saved.role)
      || !Number.isFinite(saved.createdAt) || !Number.isFinite(saved.expiresAt)
      || saved.createdAt > now || saved.expiresAt <= now
      || saved.expiresAt - saved.createdAt !== SESSION_LIFETIME_MS) {
      try { target?.removeItem(ENTRY_SESSION_KEY); } catch { /* Best-effort cleanup. */ }
      return null;
    }
    return saved.role;
  } catch {
    try { target?.removeItem(ENTRY_SESSION_KEY); } catch { /* Storage may be unavailable. */ }
    return null;
  }
}

export function saveEntrySession(role, storage, now = Date.now()) {
  if (!ROLES.has(role) || !Number.isFinite(now)) return false;
  try {
    const target = entryStorage(storage);
    if (!target) return false;
    target.setItem(ENTRY_SESSION_KEY, JSON.stringify({
      role, createdAt: now, expiresAt: now + SESSION_LIFETIME_MS,
    }));
    return true;
  } catch { return false; }
}

export function clearEntrySession(storage) {
  try { entryStorage(storage)?.removeItem(ENTRY_SESSION_KEY); } catch { /* Best-effort logout. */ }
}

export function submissionAllowed(entryRole, { token = null, mode = 'local', cloudRole = null } = {}) {
  return entryRole === 'student' && !token && (mode === 'local' || (mode === 'cloud' && cloudRole === 'owner'));
}

export function reviewAllowed(entryRole, { token = null, mode = 'local', cloudRole = null } = {}) {
  return entryRole === 'teacher' && (Boolean(token) || mode === 'local' || (mode === 'cloud' && cloudRole === 'reviewer'));
}
