/* Excel export via SheetJS — three sheets: Daily Log, Weekly Summary, Profile Settings. */

const SHEETJS_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

let _sheetJsPromise = null;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_sheetJsPromise) return _sheetJsPromise;
  _sheetJsPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = SHEETJS_CDN;
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error('Could not load SheetJS from CDN'));
    document.head.appendChild(s);
  });
  return _sheetJsPromise;
}

function weekStartISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  // ISO week: Monday = 1, Sunday = 7
  const day = dt.getDay() === 0 ? 7 : dt.getDay();
  dt.setDate(dt.getDate() - (day - 1));
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

async function exportProfileToExcel(profile, dailyLogs, healthRows, tdee) {
  const XLSX = await loadSheetJS();
  const unit = profile.weight_unit || 'kg';
  const showWeight = (kg) => kg == null ? null : (unit === 'lbs' ? +(kg * 2.20462).toFixed(2) : +kg.toFixed(2));

  const logsByDate = new Map(dailyLogs.map(l => [l.date, l]));
  const healthByDate = new Map(healthRows.map(h => [h.date, h]));

  /* ----- Daily Log sheet ----- */
  const allDates = new Set([...dailyLogs.map(l => l.date), ...healthRows.map(h => h.date)]);
  const dates = Array.from(allDates).sort();
  const dailyRows = dates.map(date => {
    const l = logsByDate.get(date) || {};
    const h = healthByDate.get(date) || {};
    return {
      Date: date,
      [`Weight (${unit})`]: showWeight(l.weight_kg),
      'Calories eaten': l.calories ?? null,
      'Carbs (g)': l.carbs ?? null,
      'Active calories (Health)': h.active_calories ?? null,
      'Basal calories (Health)': h.basal_calories ?? null,
      'Steps (Health)': h.steps ?? null,
      [`Body mass from Health (${unit})`]: showWeight(h.body_mass_kg),
      'Notes': l.notes || '',
    };
  });

  /* ----- Weekly Summary sheet ----- */
  const weekGroups = new Map();
  for (const date of dates) {
    const wk = weekStartISO(date);
    if (!weekGroups.has(wk)) weekGroups.set(wk, []);
    weekGroups.get(wk).push(date);
  }
  const weeklyRows = [];
  const weekKeys = [...weekGroups.keys()].sort();
  for (const weekKey of weekKeys) {
    const ds = weekGroups.get(weekKey);
    const ls = ds.map(d => logsByDate.get(d) || {});
    const hs = ds.map(d => healthByDate.get(d) || {});
    const weights = ls.map(x => x.weight_kg).filter(v => v != null);
    const cals    = ls.map(x => x.calories).filter(v => v != null);
    const carbs   = ls.map(x => x.carbs).filter(v => v != null);
    const actives = hs.map(x => x.active_calories).filter(v => v != null);
    const steps   = hs.map(x => x.steps).filter(v => v != null);

    weeklyRows.push({
      'Week start (Mon)': weekKey,
      'Days with data': ls.filter(x => x.calories != null || x.weight_kg != null).length,
      [`Avg weight (${unit})`]: weights.length ? showWeight(avg(weights)) : null,
      'Avg calories': cals.length ? Math.round(avg(cals)) : null,
      'Avg carbs (g)': carbs.length ? Math.round(avg(carbs)) : null,
      'Avg active cal': actives.length ? Math.round(avg(actives)) : null,
      'Total active cal': actives.length ? Math.round(actives.reduce((a,b)=>a+b,0)) : null,
      'Avg steps': steps.length ? Math.round(avg(steps)) : null,
    });
  }
  // Add weight delta and implied TDEE row-over-row
  for (let i = 0; i < weeklyRows.length; i++) {
    const r = weeklyRows[i];
    const cur = r[`Avg weight (${unit})`];
    const prev = i > 0 ? weeklyRows[i - 1][`Avg weight (${unit})`] : null;
    if (cur != null && prev != null) {
      const dispDelta = +(cur - prev).toFixed(2);
      r[`Weight Δ vs prev wk (${unit})`] = dispDelta;
      const deltaKg = unit === 'lbs' ? dispDelta / 2.20462 : dispDelta;
      if (r['Avg calories'] != null) {
        // implied weekly TDEE = avg eaten − (Δkg × 7700) / 7 days
        r['Implied weekly TDEE'] = Math.round(r['Avg calories'] - (deltaKg * 7700) / 7);
      } else {
        r['Implied weekly TDEE'] = null;
      }
    } else {
      r[`Weight Δ vs prev wk (${unit})`] = null;
      r['Implied weekly TDEE'] = null;
    }
  }

  /* ----- Profile Settings sheet (incl. current TDEE estimates) ----- */
  const age = TDEE.calculateAge(profile.dob);
  const profileRows = [
    { Field: 'Name',                       Value: profile.name },
    { Field: 'Sex',                        Value: profile.sex },
    { Field: 'Date of birth',              Value: profile.dob },
    { Field: 'Age (years)',                Value: age },
    { Field: 'Height (cm)',                Value: profile.height_cm },
    { Field: 'Starting weight (kg)',       Value: profile.starting_weight_kg },
    { Field: 'Goal weight (kg)',           Value: profile.goal_weight_kg },
    { Field: 'Activity level multiplier',  Value: profile.activity_level },
    { Field: 'Weight unit preference',     Value: unit },
    { Field: 'Height unit preference',     Value: profile.height_unit || 'cm' },
    { Field: 'Profile created',            Value: profile.created_at },
    { Field: '',                           Value: '' },
    { Field: 'TDEE — current estimates',   Value: '' },
    { Field: 'Active method',              Value: tdee.bestKey },
    { Field: 'Best TDEE (cal/day)',        Value: tdee.best },
    { Field: 'Static TDEE',                Value: tdee.modes.static.tdee },
    { Field: 'Health TDEE',                Value: tdee.modes.health.available    ? tdee.modes.health.tdee    : 'not available' },
    { Field: 'Adaptive 14-day',            Value: tdee.modes.adaptive14.available ? tdee.modes.adaptive14.tdee : 'not available' },
    { Field: 'Adaptive 28-day',            Value: tdee.modes.adaptive28.available ? tdee.modes.adaptive28.tdee : 'not available' },
    { Field: 'Reasoning',                  Value: tdee.explainer },
    { Field: '',                           Value: '' },
    { Field: 'Exported at',                Value: new Date().toISOString() },
  ];

  /* ----- Build workbook ----- */
  const wb = XLSX.utils.book_new();
  const sDaily   = XLSX.utils.json_to_sheet(dailyRows);
  const sWeekly  = XLSX.utils.json_to_sheet(weeklyRows);
  const sProfile = XLSX.utils.json_to_sheet(profileRows);
  sDaily['!cols']   = [{wch:12},{wch:14},{wch:16},{wch:12},{wch:24},{wch:24},{wch:14},{wch:24},{wch:40}];
  sWeekly['!cols']  = [{wch:18},{wch:14},{wch:18},{wch:14},{wch:14},{wch:16},{wch:18},{wch:12},{wch:24},{wch:20}];
  sProfile['!cols'] = [{wch:32},{wch:40}];
  XLSX.utils.book_append_sheet(wb, sDaily,   'Daily Log');
  XLSX.utils.book_append_sheet(wb, sWeekly,  'Weekly Summary');
  XLSX.utils.book_append_sheet(wb, sProfile, 'Profile Settings');

  /* ----- Filename + download ----- */
  const safeName = (profile.name || 'profile').replace(/[^a-zA-Z0-9_-]/g, '_');
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${safeName}_tdee_log_${today}.xlsx`;
  XLSX.writeFile(wb, filename);

  return { filename, dailyRowCount: dailyRows.length, weeklyRowCount: weeklyRows.length };
}

/* Test-only: build the workbook without downloading */
async function buildWorkbookForTest(profile, dailyLogs, healthRows, tdee) {
  const XLSX = await loadSheetJS();
  // Just call the body without writeFile — refactor would be cleaner, but mock writeFile
  const orig = XLSX.writeFile;
  let captured = null;
  XLSX.writeFile = (wb, fn) => { captured = { wb, fn }; };
  try {
    const meta = await exportProfileToExcel(profile, dailyLogs, healthRows, tdee);
    return { meta, wb: captured?.wb, filename: captured?.fn };
  } finally {
    XLSX.writeFile = orig;
  }
}

window.Exporter = { exportProfileToExcel, buildWorkbookForTest, loadSheetJS };
