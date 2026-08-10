/* Google health data importer.
   Handles:
     - Google Takeout -> Fit -> "Daily activity metrics" CSVs
     - Health Connect / Fit CSV exports with recognisable column headers
   IMPORTANT: Google reports TOTAL daily calories (BMR included), unlike Apple's
   ActiveEnergyBurned which is movement only. We store it as total_calories so the
   TDEE calc doesn't add BMR on top. */

function gSplitCsvLine(line) {
  const out = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function gNorm(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')          // drop "(kcal)", "(kg)"
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function gNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function gIsoDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d)) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

/* Column detection for Google Fit "Daily activity metrics" and similar.
   Real Google Fit header looks like:
   Date,Move Minutes count,Calories (kcal),Distance (m),Heart Points,...,
   Step count,Average weight (kg),Max weight (kg),Min weight (kg) */
function gDetectColumns(headers) {
  const norm = headers.map(gNorm);
  const exact = (...names) => {
    for (const n of names) {
      const i = norm.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const partial = (...frags) => {
    for (const f of frags) {
      const i = norm.findIndex(h => h.includes(f));
      if (i >= 0) return i;
    }
    return -1;
  };

  const date = exact('date', 'day', 'start_time', 'time') >= 0
    ? exact('date', 'day', 'start_time', 'time')
    : partial('date');

  // Active-only energy (Health Connect sometimes exposes this explicitly)
  const active = exact('active_calories', 'active_energy', 'active_energy_burned',
                       'activecaloriesburned', 'active_kcal');

  // Total daily energy — Google Fit's plain "Calories (kcal)"
  let total = exact('calories', 'total_calories', 'total_energy', 'energy',
                    'total_calories_burned', 'caloriesburned', 'kcal');
  if (total < 0 && active < 0) total = partial('calorie', 'energy');

  const steps = exact('step_count', 'steps', 'stepcount') >= 0
    ? exact('step_count', 'steps', 'stepcount')
    : partial('step');

  const weight = exact('average_weight', 'weight', 'body_mass', 'avg_weight') >= 0
    ? exact('average_weight', 'weight', 'body_mass', 'avg_weight')
    : partial('weight');

  return { date, active, total, steps, weight };
}

function gWeightUnitFromHeader(h) {
  const s = String(h || '').toLowerCase();
  if (s.includes('lb') || s.includes('pound')) return 'lb';
  return 'kg';
}

function parseGoogleCsv(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length);
  if (lines.length < 2) return { rows: [], detected: null };
  const headers = gSplitCsvLine(lines[0]).map(h => h.trim());
  const cols = gDetectColumns(headers);
  if (cols.date < 0) return { rows: [], detected: null };

  const weightUnit = cols.weight >= 0 ? gWeightUnitFromHeader(headers[cols.weight]) : 'kg';
  const byDate = new Map();

  for (let i = 1; i < lines.length; i++) {
    const f = gSplitCsvLine(lines[i]);
    const date = gIsoDate(f[cols.date]);
    if (!date) continue;

    let b = byDate.get(date);
    if (!b) {
      b = { date, total: null, active: null, steps: null, weight_kg: null };
      byDate.set(date, b);
    }

    const total = cols.total >= 0 ? gNum(f[cols.total]) : null;
    if (total != null) b.total = (b.total ?? 0) + total;

    const active = cols.active >= 0 ? gNum(f[cols.active]) : null;
    if (active != null) b.active = (b.active ?? 0) + active;

    const steps = cols.steps >= 0 ? gNum(f[cols.steps]) : null;
    if (steps != null) b.steps = (b.steps ?? 0) + steps;

    const w = cols.weight >= 0 ? gNum(f[cols.weight]) : null;
    if (w != null && w > 0) {
      b.weight_kg = weightUnit === 'lb' ? +(w / 2.20462).toFixed(2) : +w.toFixed(2);
    }
  }

  return {
    rows: Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
    detected: {
      date:   headers[cols.date]   ?? null,
      total:  cols.total  >= 0 ? headers[cols.total]  : null,
      active: cols.active >= 0 ? headers[cols.active] : null,
      steps:  cols.steps  >= 0 ? headers[cols.steps]  : null,
      weight: cols.weight >= 0 ? headers[cols.weight] : null,
    },
  };
}

/* Find the most useful CSV inside a Google Takeout zip. Prefers the aggregated
   "Daily activity metrics.csv" over the per-day files. */
async function extractGoogleCsvFromZip(zip) {
  const candidates = [
    /Daily activity metrics[\/\\]?Daily activity metrics\.csv$/i,
    /Daily activity metrics\.csv$/i,
    /Fit[\/\\].*\.csv$/i,
    /Health Connect[\/\\].*\.csv$/i,
  ];
  for (const pattern of candidates) {
    const matches = zip.file(pattern);
    if (matches && matches.length) {
      // If several, prefer the largest (the aggregate file)
      let best = matches[0];
      for (const m of matches) {
        const a = m._data?.uncompressedSize || 0;
        const b = best._data?.uncompressedSize || 0;
        if (a > b) best = m;
      }
      return { entry: best, name: best.name };
    }
  }
  // Fallback: any CSV whose header mentions calories/steps
  const allCsv = zip.file(/\.csv$/i) || [];
  for (const entry of allCsv.slice(0, 40)) {
    const head = (await entry.async('text')).slice(0, 500).toLowerCase();
    if (head.includes('date') && (head.includes('calor') || head.includes('step'))) {
      return { entry, name: entry.name };
    }
  }
  return null;
}

function looksLikeGoogleZip(zip) {
  return !!(
    zip.file(/Takeout[\/\\]/i)?.length ||
    zip.file(/Daily activity metrics/i)?.length ||
    zip.file(/[\/\\]?Fit[\/\\]/i)?.length ||
    zip.file(/Health ?Connect/i)?.length
  );
}

async function importGoogleData(profileId, file, onProgress) {
  const name = (file.name || '').toLowerCase();
  let csvText = null;
  let sourceName = file.name || 'Google export';

  if (name.endsWith('.zip') || file.type === 'application/zip') {
    onProgress?.({ phase: 'unzip', percent: 0 });
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);
    const found = await extractGoogleCsvFromZip(zip);
    if (!found) throw new Error('No Google Fit / Health Connect CSV found inside the zip.');
    onProgress?.({ phase: 'unzip', percent: 60 });
    csvText = await found.entry.async('text');
    sourceName = found.name;
    onProgress?.({ phase: 'unzip', percent: 100 });
  } else {
    onProgress?.({ phase: 'read', percent: 0 });
    csvText = await file.text();
    onProgress?.({ phase: 'read', percent: 100 });
  }

  onProgress?.({ phase: 'parse', percent: 30 });
  const { rows, detected } = parseGoogleCsv(csvText);
  if (!rows.length) {
    throw new Error('Could not find a usable Date column in the Google export.');
  }
  onProgress?.({ phase: 'parse', percent: 100, recordsParsed: rows.length, recordsKept: rows.length });

  onProgress?.({ phase: 'save', percent: 0 });
  let healthWrites = 0, weightWrites = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const patch = {};
    if (r.total != null)  patch.total_calories  = Math.round(r.total);
    if (r.active != null) patch.active_calories = Math.round(r.active);
    if (r.steps != null)  patch.steps           = Math.round(r.steps);
    if (r.weight_kg != null) patch.body_mass_kg = r.weight_kg;
    if (Object.keys(patch).length) {
      patch.source = 'google';
      await DB.upsertHealthDaily(profileId, r.date, patch);
      healthWrites++;
    }
    // A weight from Google is a real weigh-in — feed it to the log so Adaptive can use it
    if (r.weight_kg != null) {
      await DB.upsertDailyLog(profileId, r.date, { weight_kg: r.weight_kg });
      weightWrites++;
    }
    if ((i & 31) === 0) {
      onProgress?.({ phase: 'save', percent: Math.floor((i / rows.length) * 100) });
      await new Promise(res => setTimeout(res, 0));
    }
  }
  onProgress?.({ phase: 'save', percent: 100 });

  const meta = {
    lastImportAt: new Date().toISOString(),
    firstDate: rows[0].date,
    lastDate: rows[rows.length - 1].date,
    daysCovered: rows.length,
    recordsParsed: rows.length,
    recordsKept: healthWrites,
    source: 'google',
    fileName: sourceName,
    fileSizeBytes: file.size || null,
    detectedColumns: detected,
    weightsImported: weightWrites,
  };
  await DB.setSetting(`health_meta_${profileId}`, meta);
  return meta;
}

window.GoogleImport = {
  importGoogleData,
  parseGoogleCsv,
  looksLikeGoogleZip,
  extractGoogleCsvFromZip,
};
