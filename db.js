/* IndexedDB wrapper — single DB, multiple object stores, profile-scoped data. */
const DB_NAME = 'tdee_tracker';
const DB_VERSION = 2;

const STORES = {
  profiles: { keyPath: 'id', autoIncrement: false },
  daily_logs: { keyPath: 'id', autoIncrement: false, indexes: [
    { name: 'by_profile_date', keyPath: ['profile_id', 'date'], unique: true },
    { name: 'by_profile', keyPath: 'profile_id' },
  ] },
  health_daily: { keyPath: 'id', autoIncrement: false, indexes: [
    { name: 'by_profile_date', keyPath: ['profile_id', 'date'], unique: true },
    { name: 'by_profile', keyPath: 'profile_id' },
  ] },
  measurements: { keyPath: 'id', autoIncrement: false, indexes: [
    { name: 'by_profile_date', keyPath: ['profile_id', 'date'], unique: true },
    { name: 'by_profile', keyPath: 'profile_id' },
  ] },
  settings: { keyPath: 'key' },
};

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, {
            keyPath: cfg.keyPath,
            autoIncrement: !!cfg.autoIncrement,
          });
          (cfg.indexes || []).forEach(idx => {
            store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
          });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDB().then(db => {
    const transaction = db.transaction(storeName, mode);
    return { store: transaction.objectStore(storeName), transaction };
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* -------- profiles -------- */

async function listProfiles() {
  const { store } = await tx('profiles');
  return reqToPromise(store.getAll());
}

async function getProfile(id) {
  const { store } = await tx('profiles');
  return reqToPromise(store.get(id));
}

async function saveProfile(profile) {
  const { store } = await tx('profiles', 'readwrite');
  return reqToPromise(store.put(profile));
}

async function deleteProfile(id) {
  // Delete profile + cascade its data
  const db = await openDB();
  const t = db.transaction(['profiles', 'daily_logs', 'health_daily', 'measurements'], 'readwrite');
  await Promise.all([
    reqToPromise(t.objectStore('profiles').delete(id)),
    deleteByIndex(t.objectStore('daily_logs'), 'by_profile', id),
    deleteByIndex(t.objectStore('health_daily'), 'by_profile', id),
    deleteByIndex(t.objectStore('measurements'), 'by_profile', id),
  ]);
}

function deleteByIndex(store, indexName, value) {
  return new Promise((resolve, reject) => {
    const idx = store.index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(value));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/* -------- daily logs -------- */

function logId(profileId, date) { return `${profileId}::${date}`; }

async function getDailyLog(profileId, date) {
  const { store } = await tx('daily_logs');
  return reqToPromise(store.get(logId(profileId, date)));
}

async function upsertDailyLog(profileId, date, patch) {
  const { store } = await tx('daily_logs', 'readwrite');
  const id = logId(profileId, date);
  const existing = await reqToPromise(store.get(id));
  const merged = {
    id,
    profile_id: profileId,
    date,
    weight_kg: null,
    calories: null,
    carbs: null,
    notes: '',
    updated_at: new Date().toISOString(),
    ...(existing || {}),
    ...patch,
  };
  await reqToPromise(store.put(merged));
  return merged;
}

async function deleteDailyLog(profileId, date) {
  const { store } = await tx('daily_logs', 'readwrite');
  return reqToPromise(store.delete(logId(profileId, date)));
}

async function listDailyLogs(profileId, { limit, since } = {}) {
  const { store } = await tx('daily_logs');
  const idx = store.index('by_profile');
  const all = await reqToPromise(idx.getAll(profileId));
  all.sort((a, b) => b.date.localeCompare(a.date));
  let out = all;
  if (since) out = out.filter(r => r.date >= since);
  if (limit) out = out.slice(0, limit);
  return out;
}

/* -------- health daily -------- */

async function upsertHealthDaily(profileId, date, patch) {
  const { store } = await tx('health_daily', 'readwrite');
  const id = logId(profileId, date);
  const existing = await reqToPromise(store.get(id));
  const merged = {
    id,
    profile_id: profileId,
    date,
    active_calories: null,
    basal_calories: null,
    total_calories: null,
    steps: null,
    body_mass_kg: null,
    source: null,
    ...(existing || {}),
    ...patch,
  };
  await reqToPromise(store.put(merged));
  return merged;
}

async function listHealthDaily(profileId, { since } = {}) {
  const { store } = await tx('health_daily');
  const idx = store.index('by_profile');
  const all = await reqToPromise(idx.getAll(profileId));
  all.sort((a, b) => a.date.localeCompare(b.date));
  return since ? all.filter(r => r.date >= since) : all;
}

/* -------- measurements -------- */

async function upsertMeasurement(profileId, date, patch) {
  const { store } = await tx('measurements', 'readwrite');
  const id = `${profileId}::${date}`;
  const existing = await reqToPromise(store.get(id));
  const merged = {
    id,
    profile_id: profileId,
    date,
    waist_cm: null,
    arms_cm: null,
    legs_cm: null,
    calves_cm: null,
    chest_cm: null,
    notes: '',
    ...(existing || {}),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await reqToPromise(store.put(merged));
  return merged;
}

async function deleteMeasurement(profileId, date) {
  const { store } = await tx('measurements', 'readwrite');
  return reqToPromise(store.delete(`${profileId}::${date}`));
}

async function listMeasurements(profileId, { limit, since } = {}) {
  const { store } = await tx('measurements');
  const idx = store.index('by_profile');
  const all = await reqToPromise(idx.getAll(profileId));
  all.sort((a, b) => b.date.localeCompare(a.date));
  let out = all;
  if (since) out = out.filter(r => r.date >= since);
  if (limit) out = out.slice(0, limit);
  return out;
}

/* -------- settings -------- */

async function getSetting(key, fallback = null) {
  const { store } = await tx('settings');
  const row = await reqToPromise(store.get(key));
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  const { store } = await tx('settings', 'readwrite');
  return reqToPromise(store.put({ key, value }));
}

window.DB = {
  openDB,
  listProfiles, getProfile, saveProfile, deleteProfile,
  getDailyLog, upsertDailyLog, deleteDailyLog, listDailyLogs,
  upsertHealthDaily, listHealthDaily,
  upsertMeasurement, deleteMeasurement, listMeasurements,
  getSetting, setSetting,
  STORES,
};
