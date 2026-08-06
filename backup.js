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

function looksLikeLegacyBackup(blob) {
  // Other "tdee-tracker" implementation: schemaVersion at root, camelCase fields,
  // dailyLogs/healthDaily store names, profiles keyed by userId not id.
  if (blob.schemaVersion != null && blob.version == null) return true;
  if (blob.stores?.dailyLogs || blob.stores?.healthDaily) return true;
  if (Array.isArray(blob.stores?.profiles)
      && blob.stores.profiles.length > 0
      && blob.stores.profiles.some(p => p && 'userId' in p && !('id' in p))) return true;
  return false;
}

function activityLevelToNumber(level) {
  if (typeof level === 'number') return level;
  const map = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9,
    'very active': 1.9,
    'very-active': 1.9,
  };
  return map[String(level || '').toLowerCase()] || 1.55;
}

function convertLegacyBackup(legacy) {
  const stores = {
    profiles: [],
    daily_logs: [],
    health_daily: [],
    measurements: [],
    settings: [],
  };
  const stats = { profiles_kept: 0, profiles_skipped: 0, daily_logs: 0, health_daily: 0, settings: 0 };

  for (const p of legacy.stores?.profiles || []) {
    if (!p || !p.userId) { stats.profiles_skipped++; continue; }
    // Skip empty stub profiles (no DOB, no height, no starting weight)
    if (!p.dob && p.heightCm == null && p.startingWeightKg == null) {
      stats.profiles_skipped++;
      continue;
    }
    stores.profiles.push({
      id: p.userId,
      name: p.name || '',
      sex: p.sex || 'female',
      dob: p.dob || '',
      height_cm: p.heightCm ?? null,
      height_unit: p.preferredHeightUnit || 'cm',
      starting_weight_kg: p.startingWeightKg ?? null,
      goal_weight_kg: p.goalWeightKg ?? null,
      weight_unit: p.preferredWeightUnit || 'kg',
      activity_level: activityLevelToNumber(p.activityLevel),
      created_at: p.createdAt || new Date().toISOString(),
      updated_at: p.updatedAt || new Date().toISOString(),
    });
    stats.profiles_kept++;
  }

  for (const d of legacy.stores?.dailyLogs || []) {
    if (!d || !d.userId || !d.date) continue;
    stores.daily_logs.push({
      id: `${d.userId}::${d.date}`,
      profile_id: d.userId,
      date: d.date,
      calories: d.caloriesEaten ?? null,
      carbs: d.carbsGrams ?? null,
      weight_kg: d.weightKg ?? null,
      notes: d.notes || '',
      updated_at: d.updatedAt || new Date().toISOString(),
    });
    stats.daily_logs++;
  }

  for (const h of legacy.stores?.healthDaily || []) {
    if (!h || !h.userId || !h.date) continue;
    stores.health_daily.push({
      id: `${h.userId}::${h.date}`,
      profile_id: h.userId,
      date: h.date,
      active_calories: h.activeCalories ?? null,
      basal_calories: h.basalCalories ?? null,
      steps: h.steps ?? null,
      body_mass_kg: h.bodyMassKg ?? null,
    });
    stats.health_daily++;
  }

  for (const s of legacy.stores?.settings || []) {
    if (!s || !s.key) continue;
    if (s.key === 'activeProfileId') {
      stores.settings.push({ key: 'active_profile_id', value: s.value });
    } else if (s.key.startsWith('deficitMode:')) {
      const uid = s.key.split(':')[1];
      const tk = s.value === 1000 ? 'cut1000' : s.value === 0 ? 'maintenance' : 'cut500';
      stores.settings.push({ key: `target_${uid}`, value: tk });
    } else {
      stores.settings.push(s);
    }
    stats.settings++;
  }

  // Also write each profile's last health import metadata so the dashboard shows it
  for (const p of legacy.stores?.profiles || []) {
    if (p?.userId && p.lastHealthImportAt) {
      stores.settings.push({
        key: `health_meta_${p.userId}`,
        value: {
          lastImportAt: p.lastHealthImportAt,
          firstDate: p.healthDataStart || null,
          lastDate: p.healthDataEnd || null,
          recordsParsed: null,
          recordsKept: stores.health_daily.filter(r => r.profile_id === p.userId).length,
          daysCovered: stores.health_daily.filter(r => r.profile_id === p.userId && r.active_calories != null).length,
          fileName: 'imported via legacy backup',
        },
      });
    }
  }

  return {
    converted: {
      app: 'tdee-tracker',
      version: 1,
      dbVersion: 2,
      exportedAt: legacy.exportedAt || new Date().toISOString(),
      convertedFromLegacy: true,
      stores,
    },
    stats,
  };
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
  let conversionStats = null;
  if (looksLikeLegacyBackup(blob)) {
    const result = convertLegacyBackup(blob);
    blob = result.converted;
    conversionStats = result.stats;
    console.info('Detected legacy backup format — converted on the fly.', conversionStats);
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
  return { counts, skipped, issues, exportedAt: blob.exportedAt, conversionStats };
}

window.Backup = { exportBackup, restoreBackup, BACKUP_VERSION };
