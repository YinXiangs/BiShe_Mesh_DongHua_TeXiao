import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  digestPassword, verifyEntryPassword, readEntrySession, saveEntrySession,
  clearEntrySession, submissionAllowed, reviewAllowed,
} from '../src/access.js';

const NOW = 1_800_000_000_000;
const EIGHT_HOURS = 8 * 60 * 60 * 1000;

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

test('password fingerprint uses the exact namespace and does not normalize the submitted secret', async () => {
  const password = 'test-only synthetic passphrase';
  assert.equal(await digestPassword(password), createHash('sha256').update('qixi-entry-v1:' + password).digest('hex'));
  assert.notEqual(await digestPassword(password), await digestPassword(' ' + password));
  assert.equal(await verifyEntryPassword(password), null);
  assert.equal(await verifyEntryPassword(''), null);
  assert.equal(await verifyEntryPassword(null), null);
  await assert.rejects(digestPassword({}), TypeError);
});

test('configured synthetic fingerprints select the corresponding role and reject a wrong password', async () => {
  const teacherPassword = 'synthetic teacher passphrase';
  const studentPassword = 'synthetic student passphrase';
  // Swap public fingerprints in an isolated copy, never real deployment passwords.
  const source = (await readFile(new URL('../src/access.js', import.meta.url), 'utf8'))
    .replace(/const TEACHER_DIGEST = '[^']*';/, `const TEACHER_DIGEST = '${await digestPassword(teacherPassword)}';`)
    .replace(/const STUDENT_DIGEST = '[^']*';/, `const STUDENT_DIGEST = '${await digestPassword(studentPassword)}';`);
  const isolated = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(await isolated.verifyEntryPassword(teacherPassword), 'teacher');
  assert.equal(await isolated.verifyEntryPassword(studentPassword), 'student');
  assert.equal(await isolated.verifyEntryPassword('wrong synthetic passphrase'), null);
  assert.equal(await isolated.verifyEntryPassword(teacherPassword + ' '), null);
});

test('both roles persist only until the eight-hour boundary and logout clears them', () => {
  for (const role of ['teacher', 'student']) {
    const storage = memoryStorage();
    assert.equal(saveEntrySession(role, storage, NOW), true);
    assert.equal(readEntrySession(storage, NOW), role);
    assert.equal(readEntrySession(storage, NOW + EIGHT_HOURS - 1), role);
    assert.equal(readEntrySession(storage, NOW + EIGHT_HOURS), null);
    assert.equal(storage.values.size, 0);
    saveEntrySession(role, storage, NOW);
    clearEntrySession(storage);
    assert.equal(readEntrySession(storage, NOW), null);
  }
});

test('malformed, invented, future and extended sessions never grant a role', () => {
  const invalid = [
    '{invalid json', 'null', '[]', '"teacher"',
    JSON.stringify({ role: 'owner', createdAt: NOW, expiresAt: NOW + EIGHT_HOURS }),
    JSON.stringify({ role: 'teacher', expiresAt: NOW + EIGHT_HOURS }),
    JSON.stringify({ role: 'teacher', createdAt: String(NOW), expiresAt: NOW + EIGHT_HOURS }),
    JSON.stringify({ role: 'teacher', createdAt: NOW + 1, expiresAt: NOW + EIGHT_HOURS + 1 }),
    JSON.stringify({ role: 'teacher', createdAt: NOW, expiresAt: NOW + EIGHT_HOURS + 1 }),
    JSON.stringify({ role: 'teacher', createdAt: NOW, expiresAt: NOW - 1 }),
  ];
  for (const value of invalid) {
    const storage = memoryStorage();
    storage.setItem('qixi-entry-session-v1', value);
    assert.equal(readEntrySession(storage, NOW), null);
    assert.equal(storage.values.size, 0);
  }
  assert.equal(saveEntrySession('owner', memoryStorage(), NOW), false);
  assert.equal(saveEntrySession('teacher', memoryStorage(), NaN), false);
  assert.equal(readEntrySession(memoryStorage(), NaN), null);
});

test('disabled or unavailable storage fails gracefully without retaining a session', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.equal(readEntrySession(blocked, NOW), null);
  assert.equal(saveEntrySession('teacher', blocked, NOW), false);
  assert.doesNotThrow(() => clearEntrySession(blocked));
  assert.equal(readEntrySession(null, NOW), null);
  assert.equal(saveEntrySession('teacher', null, NOW), false);
  assert.doesNotThrow(() => clearEntrySession(null));
});

test('submission permissions require student entry and the existing cloud owner authority', () => {
  const contexts = [
    [{ mode: 'local' }, true],
    [{ mode: 'cloud', cloudRole: 'owner' }, true],
    [{ mode: 'cloud', cloudRole: 'reviewer' }, false],
    [{ mode: 'cloud' }, false],
    [{ mode: 'guest', token: 'shared-token' }, false],
    [{ mode: 'cloud', cloudRole: 'owner', token: 'shared-token' }, false],
    [{ mode: 'guest' }, false],
    [{ mode: 'unknown' }, false],
  ];
  for (const [context, expected] of contexts) {
    assert.equal(submissionAllowed('student', context), expected);
    for (const role of ['teacher', null, 'owner']) assert.equal(submissionAllowed(role, context), false);
  }
});

test('review permissions require teacher entry and never upgrade cloud owners or students', () => {
  const contexts = [
    [{ mode: 'local' }, true],
    [{ mode: 'cloud', cloudRole: 'reviewer' }, true],
    [{ mode: 'cloud', cloudRole: 'owner' }, false],
    [{ mode: 'cloud' }, false],
    [{ mode: 'guest', token: 'shared-token' }, true],
    [{ mode: 'cloud', token: 'shared-token' }, true],
    [{ mode: 'guest' }, false],
    [{ mode: 'unknown' }, false],
  ];
  for (const [context, expected] of contexts) {
    assert.equal(reviewAllowed('teacher', context), expected);
    for (const role of ['student', null, 'reviewer']) assert.equal(reviewAllowed(role, context), false);
  }
});
