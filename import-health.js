/* Apple Health import — XML or .zip (streamed) or CSV. Streams to handle huge files. */

const HEALTH_TYPE_MAP = {
  'HKQuantityTypeIdentifierActiveEnergyBurned': 'active_calories',
  'HKQuantityTypeIdentifierBasalEnergyBurned':  'basal_calories',
  'HKQuantityTypeIdentifierBodyMass':           'body_mass_kg',
  'HKQuantityTypeIdentifierStepCount':          'steps',
};

const JSZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

let _jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (_jszipPromise) return _jszipPromise;
  _jszipPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSZIP_CDN;
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => reject(new Error('Could not load JSZip from CDN — check your network.'));
    document.head.appendChild(s);
  });
  return _jszipPromise;
}

function dateOnly(s) {
  if (!s) return null;
  return s.slice(0, 10);
}

function isoFromAny(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already ISO-ish?
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/yyyy or mm/dd/yyyy or dd-mm-yyyy
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(s);
  if (m) {
    // Ambiguous — assume dd/mm/yyyy (Apple regional default). Apps that produce mm/dd
    // are usually US English; we can revisit if it bites.
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  // Date parse fallback
  const d = new Date(s);
  if (!isNaN(d)) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }
  return null;
}

/* ============================================================
   STREAMING XML PARSER — chunked so huge exports don't OOM
   ============================================================ */

function makeAccumulator() {
  return {
    days: new Map(),
    recordsParsed: 0,
    recordsKept: 0,
  };
}

function processXMLChunk(acc, text) {
  const recordRegex = /<Record\b([^>]*?)\/?>/g;
  let match;
  while ((match = recordRegex.exec(text)) !== null) {
    acc.recordsParsed++;
    const attrStr = match[1];

    const typeMatch = /\btype="([^"]+)"/.exec(attrStr);
    if (!typeMatch) continue;
    const field = HEALTH_TYPE_MAP[typeMatch[1]];
    if (!field) continue;

    const startMatch = /\bstartDate="([^"]+)"/.exec(attrStr);
    const valueMatch = /\bvalue="([^"]+)"/.exec(attrStr);
    if (!startMatch || !valueMatch) continue;
    const date = dateOnly(startMatch[1]);
    const value = parseFloat(valueMatch[1]);
    if (!date || !Number.isFinite(value)) continue;
    const unitMatch = /\bunit="([^"]+)"/.exec(attrStr);
    const unit = unitMatch ? unitMatch[1].toLowerCase() : '';

    let bucket = acc.days.get(date);
    if (!bucket) {
      bucket = {
        active_kcal: 0, basal_kcal: 0, steps: 0,
        body_mass_kg_sum: 0, body_mass_count: 0,
      };
      acc.days.set(date, bucket);
    }

    if (field === 'active_calories') {
      bucket.active_kcal += (unit === 'kj') ? value / 4.184 : value;
    } else if (field === 'basal_calories') {
      bucket.basal_kcal += (unit === 'kj') ? value / 4.184 : value;
    } else if (field === 'steps') {
      bucket.steps += value;
    } else if (field === 'body_mass_kg') {
      let kg = value;
      if (unit.includes('lb')) kg = value / 2.20462;
      else if (unit === 'g')   kg = value / 1000;
      bucket.body_mass_kg_sum += kg;
      bucket.body_mass_count += 1;
    }
    acc.recordsKept++;
  }
}

function finalizeAccumulator(acc) {
  const dailyRows = [];
  let firstDate = null, lastDate = null;
  for (const [date, b] of acc.days) {
    dailyRows.push({
      date,
      active_calories: b.active_kcal > 0 ? Math.round(b.active_kcal) : null,
      basal_calories:  b.basal_kcal  > 0 ? Math.round(b.basal_kcal)  : null,
      body_mass_kg:    b.body_mass_count > 0 ? +(b.body_mass_kg_sum / b.body_mass_count).toFixed(2) : null,
      steps:           b.steps > 0 ? Math.round(b.steps) : null,
    });
    if (!firstDate || date < firstDate) firstDate = date;
    if (!lastDate  || date > lastDate)  lastDate  = date;
  }
  dailyRows.sort((a, b) => a.date.localeCompare(b.date));
  return {
    dailyRows,
    recordsParsed: acc.recordsParsed,
    recordsKept: acc.recordsKept,
    daysCovered: dailyRows.length,
    firstDate,
    lastDate,
  };
}

// Stream-parse an XML file inside a JSZip ZipObject. Never builds the whole text.
function parseHealthXMLFromZipEntry(zipEntry, totalBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const acc = makeAccumulator();
    const decoder = new TextDecoder('utf-8');
    let carryover = '';
    let bytesProcessed = 0;
    let lastReportedPct = -1;
    const TAIL_MIN = 1024; // hold at least 1KB tail to avoid splitting a record

    const stream = zipEntry.internalStream('uint8array');
    stream.on('data', (chunk) => {
      bytesProcessed += chunk.length;
      const piece = decoder.decode(chunk, { stream: true });
      const text = carryover + piece;
      // Cut at the last '>' so we never feed a partial record into the regex.
      const lastClose = text.lastIndexOf('>');
      if (lastClose < 0 || text.length - lastClose - 1 > 64 * 1024) {
        // No close found, or carryover growing unreasonably — bail safely
        carryover = text.slice(-Math.min(text.length, 64 * 1024));
      } else {
        const processable = text.slice(0, lastClose + 1);
        carryover = text.slice(lastClose + 1);
        processXMLChunk(acc, processable);
      }
      if (totalBytes > 0) {
        const pct = Math.min(99, Math.floor((bytesProcessed / totalBytes) * 100));
        if (pct > lastReportedPct) {
          onProgress?.({ phase: 'parse', percent: pct, recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
          lastReportedPct = pct;
        }
      } else {
        onProgress?.({ phase: 'parse', percent: 0, recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
      }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      const tail = carryover + decoder.decode();
      if (tail) processXMLChunk(acc, tail);
      onProgress?.({ phase: 'parse', percent: 100, recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
      resolve(finalizeAccumulator(acc));
    });
    stream.resume();
  });
}

// Stream-parse an XML Blob/File directly (no zip).
async function parseHealthXMLFromBlob(file, onProgress) {
  const acc = makeAccumulator();
  const decoder = new TextDecoder('utf-8');
  let carryover = '';
  let bytesProcessed = 0;
  let lastReportedPct = -1;
  const totalBytes = file.size || 0;
  const reader = file.stream().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesProcessed += value.length;
    const piece = decoder.decode(value, { stream: true });
    const text = carryover + piece;
    const lastClose = text.lastIndexOf('>');
    if (lastClose < 0 || text.length - lastClose - 1 > 64 * 1024) {
      carryover = text.slice(-Math.min(text.length, 64 * 1024));
    } else {
      const processable = text.slice(0, lastClose + 1);
      carryover = text.slice(lastClose + 1);
      processXMLChunk(acc, processable);
    }
    if (totalBytes > 0) {
      const pct = Math.min(99, Math.floor((bytesProcessed / totalBytes) * 100));
      if (pct > lastReportedPct) {
        onProgress?.({ phase: 'parse', percent: pct, recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
        lastReportedPct = pct;
      }
    }
  }
  const tail = carryover + decoder.decode();
  if (tail) processXMLChunk(acc, tail);
  onProgress?.({ phase: 'parse', percent: 100, recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
  return finalizeAccumulator(acc);
}

/* Small helper used by tests; parses an in-memory XML string. */
function parseHealthXML(xmlText, onProgress) {
  const acc = makeAccumulator();
  processXMLChunk(acc, xmlText);
  onProgress?.({ phase: 'parse', percent: 100, recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
  return finalizeAccumulator(acc);
}

/* ============================================================
   CSV PARSER — flexible column detection
   ============================================================ */

function splitCSVLine(line) {
  // Handles quoted fields with embedded commas
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

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')   // drop "(kcal)" etc.
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function detectColumns(headers) {
  const norm = headers.map(normalizeHeader);
  const find = (...candidates) => {
    for (const cand of candidates) {
      const i = norm.findIndex(h => h === cand);
      if (i >= 0) return i;
    }
    // partial match
    for (const cand of candidates) {
      const i = norm.findIndex(h => h.includes(cand));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    date:     find('date', 'day', 'start_date', 'startdate', 'start'),
    active:   find('active_energy', 'activeenergy', 'active_calories', 'active_kcal', 'active_cal', 'active'),
    basal:    find('basal_energy', 'basalenergy', 'basal_calories', 'resting_energy', 'restingenergy', 'basal'),
    steps:    find('step_count', 'stepcount', 'steps'),
    body:     find('body_mass', 'bodymass', 'weight', 'mass'),
    unit:     find('unit', 'units'),
  };
}

function detectUnitFromHeader(header) {
  if (!header) return null;
  const h = String(header).toLowerCase();
  if (h.includes('kj') && !h.includes('kcal')) return 'kj';
  if (h.includes('lb')) return 'lb';
  if (h.includes('kg')) return 'kg';
  return null;
}

function parseHealthCSV(text, onProgress) {
  const acc = makeAccumulator();
  // Normalize newlines
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.length);
  if (lines.length < 2) {
    return finalizeAccumulator(acc);
  }
  const headers = splitCSVLine(lines[0]);
  const cols = detectColumns(headers);
  if (cols.date < 0) {
    throw new Error('CSV needs a date column (e.g. "Date" or "Start"). Header row: ' + headers.join(', '));
  }
  // Detect units from header strings (used when there's no per-row unit column)
  const activeUnit = cols.active >= 0 ? detectUnitFromHeader(headers[cols.active]) : null;
  const bodyUnit   = cols.body   >= 0 ? detectUnitFromHeader(headers[cols.body])   : null;

  let processed = 0;
  const total = lines.length - 1;

  for (let i = 1; i < lines.length; i++) {
    const fields = splitCSVLine(lines[i]);
    acc.recordsParsed++;
    const date = isoFromAny(fields[cols.date]);
    if (!date) continue;

    let bucket = acc.days.get(date);
    if (!bucket) {
      bucket = { active_kcal: 0, basal_kcal: 0, steps: 0, body_mass_kg_sum: 0, body_mass_count: 0 };
      acc.days.set(date, bucket);
    }

    const valNum = (i) => {
      if (i < 0) return null;
      const v = parseFloat(String(fields[i] ?? '').replace(/,/g, ''));
      return Number.isFinite(v) ? v : null;
    };
    const a = valNum(cols.active);
    const b = valNum(cols.basal);
    const s = valNum(cols.steps);
    const w = valNum(cols.body);
    let kept = false;
    if (a != null) { bucket.active_kcal += (activeUnit === 'kj') ? a / 4.184 : a; kept = true; }
    if (b != null) { bucket.basal_kcal  += (activeUnit === 'kj') ? b / 4.184 : b; kept = true; }
    if (s != null) { bucket.steps += s; kept = true; }
    if (w != null) {
      let kg = w;
      if (bodyUnit === 'lb') kg = w / 2.20462;
      bucket.body_mass_kg_sum += kg;
      bucket.body_mass_count += 1;
      kept = true;
    }
    if (kept) acc.recordsKept++;
    processed++;
    if ((processed & 1023) === 0 && total > 0) {
      onProgress?.({ phase: 'parse', percent: Math.floor((processed / total) * 100), recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
    }
  }
  onProgress?.({ phase: 'parse', percent: 100, recordsParsed: acc.recordsParsed, recordsKept: acc.recordsKept });
  const result = finalizeAccumulator(acc);
  result.detectedColumns = { date: headers[cols.date], active: headers[cols.active], basal: headers[cols.basal], steps: headers[cols.steps], body: headers[cols.body] };
  return result;
}

/* ============================================================
   DISPATCH + SAVE
   ============================================================ */

async function parseAnyHealthFile(file, onProgress) {
  const name = (file.name || '').toLowerCase();
  const isZip = name.endsWith('.zip') || file.type === 'application/zip';
  const isCSV = name.endsWith('.csv') || file.type === 'text/csv';

  if (isZip) {
    onProgress?.({ phase: 'unzip', percent: 0 });
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);

    // Is this an Apple Health export?
    let xmlEntry = zip.file('apple_health_export/export.xml');
    if (!xmlEntry) {
      const matches = zip.file(/export\.xml$/i);
      if (matches && matches.length) xmlEntry = matches[0];
    }
    if (xmlEntry) {
      onProgress?.({ phase: 'unzip', percent: 100 });
      const uncompressed = xmlEntry._data?.uncompressedSize || 0;
      return { kind: 'apple', result: await parseHealthXMLFromZipEntry(xmlEntry, uncompressed, onProgress) };
    }

    // Is this a MyFitnessPal export?
    const hasMFP = !!(
      zip.file(/Nutrition-Summary/i)?.length ||
      zip.file(/Exercise-Summary/i)?.length ||
      zip.file(/Measurement-Summary/i)?.length
    );
    if (hasMFP) {
      // Signal to caller: they should use MFPImport instead
      return { kind: 'mfp-detected' };
    }

    // Is this a Google Takeout / Fit / Health Connect export?
    if (typeof GoogleImport !== 'undefined' && GoogleImport.looksLikeGoogleZip(zip)) {
      return { kind: 'google-detected' };
    }

    throw new Error('Zip does not look like an Apple Health, MyFitnessPal or Google export.');
  }
  if (isCSV) {
    onProgress?.({ phase: 'read', percent: 0 });
    const text = await file.text();
    onProgress?.({ phase: 'read', percent: 100 });
    // Google Fit CSVs report a plain total "Calories (kcal)" column and no
    // active-energy column — route those to the Google parser so BMR isn't
    // double-counted.
    const header = (text.split(/\r\n|\n|\r/)[0] || '').toLowerCase();
    const hasActiveCol = /active[\s_]*(energy|calorie)/.test(header);
    const hasPlainCalories = /calorie|kcal/.test(header);
    if (!hasActiveCol && hasPlainCalories) {
      return { kind: 'google-detected' };
    }
    return { kind: 'apple', result: parseHealthCSV(text, onProgress) };
  }
  // Default: treat as XML, stream it
  return { kind: 'apple', result: await parseHealthXMLFromBlob(file, onProgress) };
}

async function importHealthData(profileId, file, onProgress) {
  const dispatch = await parseAnyHealthFile(file, onProgress);

  // MyFitnessPal path — hand off to the dedicated importer
  if (dispatch.kind === 'mfp-detected') {
    const meta = await MFPImport.importMFPExport(profileId, file, onProgress);
    return { source: 'myfitnesspal', meta, daysCovered: meta.daysCovered, recordsKept: meta.recordsKept };
  }

  // Google Fit / Health Connect / Takeout path
  if (dispatch.kind === 'google-detected') {
    const meta = await GoogleImport.importGoogleData(profileId, file, onProgress);
    return { source: 'google', meta, daysCovered: meta.daysCovered, recordsKept: meta.recordsKept };
  }

  const result = dispatch.result;
  onProgress?.({ phase: 'save', percent: 0 });
  for (let i = 0; i < result.dailyRows.length; i++) {
    const r = result.dailyRows[i];
    await DB.upsertHealthDaily(profileId, r.date, {
      active_calories: r.active_calories,
      basal_calories:  r.basal_calories,
      body_mass_kg:    r.body_mass_kg,
      steps:           r.steps,
      source:          'apple',
    });
    if ((i & 31) === 0) {
      onProgress?.({ phase: 'save', percent: Math.floor((i / result.dailyRows.length) * 100) });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  onProgress?.({ phase: 'save', percent: 100 });

  const meta = {
    lastImportAt: new Date().toISOString(),
    firstDate: result.firstDate,
    lastDate: result.lastDate,
    recordsParsed: result.recordsParsed,
    recordsKept: result.recordsKept,
    daysCovered: result.daysCovered,
    fileName: file.name || null,
    fileSizeBytes: file.size || null,
    detectedColumns: result.detectedColumns || null,
    source: 'apple',
  };
  await DB.setSetting(`health_meta_${profileId}`, meta);
  return { ...result, meta };
}

async function manualHealthEntry(profileId, rows) {
  // rows: [{ date: 'YYYY-MM-DD', active_calories: number }]
  for (const r of rows) {
    if (!r.date) continue;
    const patch = {};
    if (r.active_calories != null) patch.active_calories = +r.active_calories;
    if (r.basal_calories  != null) patch.basal_calories  = +r.basal_calories;
    if (r.steps           != null) patch.steps           = +r.steps;
    if (r.body_mass_kg    != null) patch.body_mass_kg    = +r.body_mass_kg;
    await DB.upsertHealthDaily(profileId, r.date, patch);
  }
  const allRows = await DB.listHealthDaily(profileId);
  const dates = allRows.map(r => r.date).sort();
  const meta = {
    lastImportAt: new Date().toISOString(),
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    recordsParsed: rows.length,
    recordsKept: rows.length,
    daysCovered: allRows.filter(r => r.active_calories != null).length,
    fileName: 'manual entry',
    fileSizeBytes: null,
  };
  await DB.setSetting(`health_meta_${profileId}`, meta);
  return meta;
}

async function clearHealthData(profileId) {
  const db = await DB.openDB();
  const t = db.transaction('health_daily', 'readwrite');
  const idx = t.objectStore('health_daily').index('by_profile');
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(profileId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
  await DB.setSetting(`health_meta_${profileId}`, null);
}

window.HealthImport = {
  parseHealthXML,            // small in-memory XML (kept for tests)
  parseHealthCSV,
  parseAnyHealthFile,
  importHealthData,
  manualHealthEntry,
  clearHealthData,
};
