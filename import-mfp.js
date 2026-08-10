/* MyFitnessPal export importer (.zip containing 3 CSVs, or individual CSVs).
   Aggregates per day: calories + carbs (from Nutrition-Summary), active calories +
   steps (from Exercise-Summary), and optionally weight (from Measurement-Summary). */

/* Reuse JSZip loader from import-health.js — it's already global. */

function splitMFPCsvLine(line) {
  // Handles double-quoted fields; MFP wraps exercise names in extra quotes.
  const out = [];
  let cur = '';
  let inQuote = false;
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

function parseMFPCsv(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.length);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = splitMFPCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitMFPCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (values[j] ?? '').trim();
    rows.push(row);
  }
  return { headers, rows };
}

function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function parseMFPZip(file, onProgress) {
  onProgress?.({ phase: 'unzip', percent: 0 });
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  onProgress?.({ phase: 'unzip', percent: 50 });

  const findByPattern = (regex) => {
    const matches = zip.file(regex);
    return matches && matches.length ? matches[0] : null;
  };
  const nutritionEntry   = findByPattern(/Nutrition-Summary/i);
  const exerciseEntry    = findByPattern(/Exercise-Summary/i);
  const measurementEntry = findByPattern(/Measurement-Summary/i);

  if (!nutritionEntry && !exerciseEntry && !measurementEntry) {
    throw new Error('Zip does not contain MyFitnessPal CSVs.');
  }

  const [nutritionText, exerciseText, measurementText] = await Promise.all([
    nutritionEntry   ? nutritionEntry.async('text')   : Promise.resolve(null),
    exerciseEntry    ? exerciseEntry.async('text')    : Promise.resolve(null),
    measurementEntry ? measurementEntry.async('text') : Promise.resolve(null),
  ]);
  onProgress?.({ phase: 'unzip', percent: 100 });
  return { nutritionText, exerciseText, measurementText };
}

async function aggregateMFPData({ nutritionText, exerciseText, measurementText }, onProgress) {
  // date -> aggregate for daily_logs and health_daily
  const byDate = new Map();
  const bump = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        cal_sum: 0, cal_count: 0,
        carb_sum: 0, carb_count: 0,
        protein_sum: 0, protein_count: 0,
        fat_sum: 0, fat_count: 0,
        fiber_sum: 0, fiber_count: 0,
        active_sum: 0, active_count: 0,
        steps_sum: 0, steps_count: 0,
        weight_kg: null,
      });
    }
    return byDate.get(date);
  };

  let stats = { nutrition_rows: 0, exercise_rows: 0, measurement_rows: 0 };

  if (nutritionText) {
    onProgress?.({ phase: 'parse', percent: 20, note: 'Nutrition summary' });
    const { rows } = parseMFPCsv(nutritionText);
    for (const r of rows) {
      const date = r.Date;
      if (!date) continue;
      const b = bump(date);
      const cal = num(r.Calories);
      if (cal != null) { b.cal_sum += cal; b.cal_count++; }
      const carb = num(r['Carbohydrates (g)']);
      if (carb != null) { b.carb_sum += carb; b.carb_count++; }
      const protein = num(r['Protein (g)']);
      if (protein != null) { b.protein_sum += protein; b.protein_count++; }
      const fat = num(r['Fat (g)']);
      if (fat != null) { b.fat_sum += fat; b.fat_count++; }
      const fiber = num(r.Fiber);
      if (fiber != null) { b.fiber_sum += fiber; b.fiber_count++; }
      stats.nutrition_rows++;
    }
  }

  if (exerciseText) {
    onProgress?.({ phase: 'parse', percent: 60, note: 'Exercise summary' });
    const { rows } = parseMFPCsv(exerciseText);
    for (const r of rows) {
      const date = r.Date;
      if (!date) continue;
      const b = bump(date);
      const cal = num(r['Exercise Calories']);
      if (cal != null) { b.active_sum += cal; b.active_count++; }
      const steps = num(r.Steps);
      if (steps != null && steps > 0) { b.steps_sum += steps; b.steps_count++; }
      stats.exercise_rows++;
    }
  }

  if (measurementText) {
    onProgress?.({ phase: 'parse', percent: 85, note: 'Measurement summary' });
    const { headers, rows } = parseMFPCsv(measurementText);
    // MFP measurement CSVs have varying columns depending on what user tracks.
    // Look for a Weight or Weight (kg)/(lb) column.
    const weightHeader = headers.find(h => /^weight/i.test(h));
    if (weightHeader) {
      const unitIsLb = /lb/i.test(weightHeader);
      for (const r of rows) {
        const date = r.Date;
        if (!date) continue;
        const w = num(r[weightHeader]);
        if (w != null && w > 0) {
          const b = bump(date);
          b.weight_kg = unitIsLb ? +(w / 2.20462).toFixed(2) : +w.toFixed(2);
          stats.measurement_rows++;
        }
      }
    }
  }

  onProgress?.({ phase: 'parse', percent: 100 });
  return { byDate, stats };
}

async function importMFPExport(profileId, file, onProgress) {
  const sources = await parseMFPZip(file, onProgress);
  const { byDate, stats } = await aggregateMFPData(sources, onProgress);

  const dates = Array.from(byDate.keys()).sort();
  if (dates.length === 0) {
    throw new Error('MFP export contained no dated rows.');
  }

  onProgress?.({ phase: 'save', percent: 0 });
  let dailyWrites = 0, healthWrites = 0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const d = byDate.get(date);

    // Nutrition → daily_logs
    const dailyPatch = {};
    if (d.cal_count > 0)  dailyPatch.calories = Math.round(d.cal_sum);
    if (d.carb_count > 0) dailyPatch.carbs = Math.round(d.carb_sum);
    if (d.weight_kg != null) dailyPatch.weight_kg = d.weight_kg;
    if (Object.keys(dailyPatch).length > 0) {
      await DB.upsertDailyLog(profileId, date, dailyPatch);
      dailyWrites++;
    }

    // Exercise → health_daily
    const healthPatch = {};
    if (d.active_count > 0) healthPatch.active_calories = Math.round(d.active_sum);
    if (d.steps_count > 0)  healthPatch.steps = Math.round(d.steps_sum);
    if (Object.keys(healthPatch).length > 0) {
      // MFP's "Exercise Calories" is logged workouts only — NOT all-day movement
      // like Apple's active energy. Tagged so the TDEE calc uses the right formula.
      healthPatch.source = 'myfitnesspal';
      await DB.upsertHealthDaily(profileId, date, healthPatch);
      healthWrites++;
    }

    if ((i & 15) === 0) {
      onProgress?.({ phase: 'save', percent: Math.floor((i / dates.length) * 100) });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  onProgress?.({ phase: 'save', percent: 100 });

  const meta = {
    lastImportAt: new Date().toISOString(),
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    daysCovered: dates.length,
    recordsParsed: stats.nutrition_rows + stats.exercise_rows + stats.measurement_rows,
    recordsKept: dailyWrites + healthWrites,
    source: 'myfitnesspal',
    fileName: file.name || 'MyFitnessPal export',
    fileSizeBytes: file.size || null,
    breakdown: {
      nutrition_rows: stats.nutrition_rows,
      exercise_rows: stats.exercise_rows,
      measurement_rows: stats.measurement_rows,
      daily_logs_written: dailyWrites,
      health_daily_written: healthWrites,
    },
  };
  await DB.setSetting(`health_meta_${profileId}`, meta);
  return meta;
}

/* Detect if a zip looks like an MFP export by checking file names.
   Called from import-health.js's dispatcher — returns true if any of the three
   MFP CSVs are present. */
async function detectMFPZip(file) {
  if (!/\.zip$/i.test(file.name || '') && file.type !== 'application/zip') return false;
  try {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);
    return !!(
      zip.file(/Nutrition-Summary/i)?.length ||
      zip.file(/Exercise-Summary/i)?.length ||
      zip.file(/Measurement-Summary/i)?.length
    );
  } catch (err) {
    return false;
  }
}

window.MFPImport = { importMFPExport, detectMFPZip, parseMFPCsv };
