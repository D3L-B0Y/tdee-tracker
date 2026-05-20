/* Full data backup + restore. Roundtrips every IndexedDB store into a single JSON file. */

const BACKUP_VERSION = 1;

async function readAllFromStore(storeName) {
  const db = await DB.openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readonly');
    const req = t.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function clearStore(storeName) {
  const db = await DB.openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const req = t.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function bulkPutToStore(storeName, rows) {
  const db = await DB.openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const store = t.objectStore(storeName);
    let errored = false;
    for (const row of rows) {
      const req = store.put(row);
      req.onerror = (e) => {
        if (!errored) {
          errored = true;
          reject(req.error || new Error(`Failed writing to ${storeName}`));
        }
      };
    }
    t.oncomplete = () => { if (!errored) resolve(); };
    t.onerror = () => { if (!errored) { errored = true; reject(t.error); } };
  });
}

async function exportBackup() {
  const storeNames = Object.keys(DB.STORES || {
    profiles: 1, daily_logs: 1, health_daily: 1, measurements: 1, settings: 1,
  });
  const data = {};
  for (const name of storeNames) {
    try {
      data[name] = await readAllFromStore(name);
    } catch (err) {
      // store may not exist yet on very old DB versions — treat as empty
      data[name] = [];
    }
  }
  const blob = {
    app: 'tdee-tracker',
    version: BACKUP_VERSION,
    dbVersion: 2,
    exportedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    stores: data,
  };
  const json = JSON.stringify(blob, null, 2);
  const file = new Blob([json], { type: 'application/json' });
  const filename = `tdee-tracker-backup_${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename, counts: blob.counts };
}

async function restoreBackup(file, { wipeFirst = true } = {}) {
  const text = await file.text();
  let blob;
  try {
    blob = JSON.parse(text);
  } catch (err) {
    throw new Error('Not a valid backup file (could not parse JSON).');
  }
  if (blob.app !== 'tdee-tracker') {
    throw new Error('This file isn\'t a TDEE Tracker backup.');
  }
  if (!blob.stores || typeof blob.stores !== 'object') {
    throw new Error('Backup file has no data sections.');
  }
  // Optionally wipe each store first
  const storeNames = Object.keys(blob.stores);
  if (wipeFirst) {
    for (const name of storeNames) {
      try { await clearStore(name); } catch (err) { /* ignore missing store */ }
    }
  }
  // Restore
  const counts = {};
  for (const name of storeNames) {
    const rows = blob.stores[name] || [];
    if (!rows.length) { counts[name] = 0; continue; }
    try {
      await bulkPutToStore(name, rows);
      counts[name] = rows.length;
    } catch (err) {
      throw new Error(`Failed restoring ${name}: ${err.message || err}`);
    }
  }
  return { counts, exportedAt: blob.exportedAt };
}

window.Backup = { exportBackup, restoreBackup, BACKUP_VERSION };
