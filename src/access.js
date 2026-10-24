// UI session helpers only. Password verification and role authority live on the shared server.
const ENTRY_SESSION_KEY = 'qixi-entry-session-v1';
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const ROLES = new Set(['teacher', 'student']);

function entryStorage(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage; } catch { return null; }
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
