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

async function bulkPutToStore(storeName, rows, keyPath) {
  const db = await DB.openDB();
  // Filter out null/undefined and rows missing their key path
  const valid = [];
  let skipped = 0;
  for (const row of rows || []) {
    if (row == null || typeof row !== 'object') { skipped++; continue; }
    if (keyPath && (row[keyPath] == null || row[keyPath] === '')) { skipped++; continue; }
    valid.push(row);
  }
  return new Promise((resolve) => {
    if (valid.length === 0) { resolve({ ok: 0, skipped, errors: [] }); return; }
    const t = db.transaction(storeName, 'readwrite');
    const store = t.objectStore(storeName);
    let ok = 0;
    const errors = [];
    for (const row of valid) {
      try {
        const req = store.put(row);
        req.onsuccess = () => { ok++; };
        req.onerror = (e) => {
          errors.push({ row, message: req.error?.message || 'unknown' });
          e.preventDefault?.();
          e.stopPropagation?.();
        };
      } catch (err) {
        errors.push({ row, message: err.message || String(err) });
      }
    }
    const finish = () => resolve({ ok, skipped, errors });
    t.oncomplete = finish;
    t.onerror = finish;
    t.onabort = finish;
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
  if (!text || !text.trim()) {
    throw new Error('Backup file is empty.');
  }
  let blob;
  try {
    blob = JSON.parse(text);
  } catch (err) {
    throw new Error('Not a valid backup file (could not parse JSON).');
  }
  if (blob.app !== 'tdee-tracker') {
    throw new Error("This file isn't a TDEE Tracker backup.");
  }
  if (!blob.stores || typeof blob.stores !== 'object') {
    throw new Error('Backup file has no data sections.');
  }
  const storeNames = Object.keys(blob.stores);
  if (wipeFirst) {
    for (const name of storeNames) {
      try { await clearStore(name); } catch (err) { /* missing store on older DB — ignore */ }
    }
  }
  const counts = {};
  const skipped = {};
  const issues = {};
  for (const name of storeNames) {
    const rows = blob.stores[name] || [];
    if (!rows.length) { counts[name] = 0; continue; }
    const keyPath = DB.STORES?.[name]?.keyPath;
    try {
      const result = await bulkPutToStore(name, rows, keyPath);
      counts[name] = result.ok;
      if (result.skipped) skipped[name] = result.skipped;
      if (result.errors.length) issues[name] = result.errors.slice(0, 3);
    } catch (err) {
      issues[name] = [{ message: err.message || String(err) }];
    }
  }
  const totalOk = Object.values(counts).reduce((s, n) => s + n, 0);
  if (totalOk === 0) {
    throw new Error(
      `Restore wrote 0 records. The backup may be empty or malformed. ` +
      `Stores tried: ${storeNames.join(', ')}.`
    );
  }
  return { counts, skipped, issues, exportedAt: blob.exportedAt };
}

window.Backup = { exportBackup, restoreBackup, BACKUP_VERSION };
