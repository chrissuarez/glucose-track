// IndexedDB wrapper. Every failure becomes a StorageError with a readable message.
import { DEFAULT_PROFILES, BACKUP_VERSION, migrateTest, needsMigration, migrateBackup, buildSync, addTombstone } from './logic.js';

const DB_NAME = 'glucose-track';
const DB_VERSION = 1;
const STORES = ['readings', 'tests', 'meta'];

export class StorageError extends Error {}

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageError('This browser does not support local storage (IndexedDB). In a private window, try a normal one.'));
      return;
    }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(new StorageError('Storage is unavailable: ' + e.message)); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('readings', { keyPath: 'id' });
      db.createObjectStore('tests', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('Could not open storage: ' + (req.error?.message || 'unknown error')));
    req.onblocked = () => reject(new StorageError('Storage is blocked by another open tab. Close other tabs and reload.'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(stores, mode); }
    catch (e) { reject(new StorageError('Storage error: ' + e.message)); return; }
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(new StorageError('Storage error: ' + (t.error?.message || 'write failed')));
    t.onabort = () => reject(new StorageError('Storage error: ' + (t.error?.message || 'transaction aborted (storage may be full)')));
    try { result = fn(t); } catch (e) { try { t.abort(); } catch {} reject(new StorageError('Storage error: ' + e.message)); }
  });
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function checkStorage() { await open(); }

export async function getAll(store) {
  const db = await open();
  try { return await reqP(db.transaction(store).objectStore(store).getAll()); }
  catch (e) { throw new StorageError('Could not read data: ' + e.message); }
}

export const put = (store, value) => tx([store], 'readwrite', t => { t.objectStore(store).put(value); });
export const del = (store, key) => tx([store], 'readwrite', t => { t.objectStore(store).delete(key); });
export const putMany = (store, values) => tx([store], 'readwrite', t => { const s = t.objectStore(store); values.forEach(v => s.put(v)); });

export async function getMeta(key, fallback = null) {
  const db = await open();
  try {
    const row = await reqP(db.transaction('meta').objectStore('meta').get(key));
    return row ? row.value : fallback;
  } catch (e) { throw new StorageError('Could not read data: ' + e.message); }
}
export const setMeta = (key, value) => put('meta', { key, value });

export async function loadAll() {
  let [profiles, settings, selected, lastBackup, deleted, tests, readings] = await Promise.all([
    getMeta('profiles', null), getMeta('settings', null), getMeta('selectedProfile', null),
    getMeta('lastBackup', null), getMeta('deleted', []), getAll('tests'), getAll('readings'),
  ]);
  const stale = tests.filter(needsMigration);
  if (stale.length) {
    const migrated = stale.map(migrateTest);
    await putMany('tests', migrated);        // persist the migration
    const byId = new Map(migrated.map(t => [t.id, t]));
    tests = tests.map(t => byId.get(t.id) || t);
  }
  return {
    profiles: profiles || DEFAULT_PROFILES.map(p => ({ ...p })),
    settings: settings || { offsetMin: 0 },
    selectedProfile: selected,
    lastBackup, deleted: Array.isArray(deleted) ? deleted : [], tests, readings,
  };
}

export async function exportBackup() {
  const d = await loadAll();
  return {
    app: 'glucose-track', version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    profiles: d.profiles, settings: d.settings, selectedProfile: d.selectedProfile,
    tests: d.tests, readings: d.readings, deleted: d.deleted,
  };
}

export async function exportSync() {
  return buildSync(await loadAll());
}

/** Delete a record and remember it (tombstone) so a sync removes it on the other phone too. One transaction. */
export async function delWithTombstone(store, id) {
  const deleted = await getMeta('deleted', []);
  const next = addTombstone(Array.isArray(deleted) ? deleted : [], store, id, Date.now());
  return tx([store, 'meta'], 'readwrite', t => {
    t.objectStore(store).delete(id);
    t.objectStore('meta').put({ key: 'deleted', value: next });
  });
}

/** Write a mergeSync() result in one transaction. Never touches profiles, selectedProfile or lastBackup. */
export function applySync(m) {
  return tx(STORES, 'readwrite', t => {
    const ts = t.objectStore('tests'), rs = t.objectStore('readings'), meta = t.objectStore('meta');
    m.deleteTests.forEach(id => ts.delete(id));
    m.deleteReadings.forEach(id => rs.delete(id));
    m.putTests.forEach(x => ts.put(x));
    m.putReadings.forEach(x => rs.put(x));
    meta.put({ key: 'deleted', value: m.tombstones });
    if (m.settings) meta.put({ key: 'settings', value: m.settings });
  });
}

/** Replace everything with backup content in one transaction. */
export function restoreBackup(b) {
  b = migrateBackup(b);
  return tx(STORES, 'readwrite', t => {
    t.objectStore('readings').clear();
    t.objectStore('tests').clear();
    b.readings.forEach(r => t.objectStore('readings').put(r));
    b.tests.forEach(x => t.objectStore('tests').put(x));
    const meta = t.objectStore('meta');
    meta.put({ key: 'profiles', value: b.profiles });
    meta.put({ key: 'settings', value: b.settings });
    meta.put({ key: 'deleted', value: Array.isArray(b.deleted) ? b.deleted : [] });
    if (b.selectedProfile) meta.put({ key: 'selectedProfile', value: b.selectedProfile });
  });
}
