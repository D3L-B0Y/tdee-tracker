/* Chart.js renderers + spike detection with plain-English explanations. */

const CHART_JS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

let _chartJsPromise = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (_chartJsPromise) return _chartJsPromise;
  _chartJsPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = CHART_JS_CDN;
    s.onload = () => res(window.Chart);
    s.onerror = () => rej(new Error('Could not load Chart.js from CDN'));
    document.head.appendChild(s);
  });
  return _chartJsPromise;
}

function rollingAverage(values, windowSize) {
  return values.map((_, i) => {
    const start = Math.max(0, i - windowSize + 1);
    const slice = values.slice(start, i + 1).filter(v => v != null);
    if (!slice.length) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

function kgToDisplay(kg, unit) {
  if (kg == null) return null;
  return unit === 'lbs' ? +(kg * 2.20462).toFixed(1) : +kg.toFixed(1);
}

async function renderWeightChart(canvas, logs, profile) {
  await loadChartJs();
  const weighted = [...logs].filter(l => l.weight_kg != null).sort((a, b) => a.date.localeCompare(b.date));
  if (canvas._chart) { canvas._chart.destroy(); canvas._chart = null; }
  if (weighted.length === 0) return null;

  const unit = profile.weight_unit || 'kg';
  const dates = weighted.map(r => r.date);
  const values = weighted.map(r => kgToDisplay(r.weight_kg, unit));
  const ma7 = rollingAverage(values, 7).map(v => v == null ? null : +v.toFixed(2));
  const goal = profile.goal_weight_kg ? kgToDisplay(profile.goal_weight_kg, unit) : null;

  const datasets = [
    {
      label: `Weight (${unit})`,
      data: values,
      borderColor: '#4f8cff',
      backgroundColor: 'rgba(79, 140, 255, 0.12)',
      pointRadius: 3,
      pointHoverRadius: 5,
      tension: 0.25,
      borderWidth: 2,
      fill: false,
    },
    {
      label: '7-day average',
      data: ma7,
      borderColor: '#6ee7b7',
      borderDash: [5, 4],
      pointRadius: 0,
      tension: 0.35,
      borderWidth: 2,
      fill: false,
    },
  ];
  if (goal != null) {
    datasets.push({
      label: `Goal (${goal})`,
      data: dates.map(() => goal),
      borderColor: 'rgba(239, 68, 68, 0.65)',
      borderDash: [2, 4],
      pointRadius: 0,
      borderWidth: 1.5,
      fill: false,
    });
  }

  canvas._chart = new Chart(canvas, {
    type: 'line',
    data: { labels: dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#e6edf7', boxWidth: 14, font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: {
          ticks: { color: '#9aa7bd', maxTicksLimit: 8, font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          ticks: { color: '#9aa7bd', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
  return canvas._chart;
}

async function renderCaloriesChart(canvas, logs, tdeeBest) {
  await loadChartJs();
  if (canvas._chart) { canvas._chart.destroy(); canvas._chart = null; }
  const withCals = [...logs].filter(l => l.calories != null).sort((a, b) => a.date.localeCompare(b.date));
  if (withCals.length === 0) return null;
  const recent = withCals.slice(-60);
  const dates = recent.map(r => r.date);
  const cals = recent.map(r => r.calories);
  const tdeeLine = recent.map(() => tdeeBest);

  canvas._chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'Calories eaten',
          data: cals,
          backgroundColor: cals.map(c =>
            c > tdeeBest ? 'rgba(239, 68, 68, 0.55)' : 'rgba(110, 231, 183, 0.45)'
          ),
          borderColor: cals.map(c =>
            c > tdeeBest ? 'rgba(239, 68, 68, 0.9)' : 'rgba(110, 231, 183, 0.9)'
          ),
          borderWidth: 1,
        },
        {
          type: 'line',
          label: `TDEE (${tdeeBest})`,
          data: tdeeLine,
          borderColor: '#f59e0b',
          borderDash: [4, 4],
          pointRadius: 0,
          borderWidth: 1.8,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#e6edf7', boxWidth: 14, font: { size: 11 } } },
      },
      scales: {
        x: {
          ticks: { color: '#9aa7bd', maxTicksLimit: 8, font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          ticks: { color: '#9aa7bd', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
  return canvas._chart;
}

/* ============ Spike detection ============ */

function isoMinus(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - n);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function detectSpikes(dailyLogs, healthRows, profile, threshold = 0.5) {
  const weighted = [...dailyLogs].filter(l => l.weight_kg != null).sort((a, b) => a.date.localeCompare(b.date));
  if (weighted.length < 4) return [];

  const logsByDate = new Map(dailyLogs.map(l => [l.date, l]));
  const healthByDate = new Map(healthRows.map(h => [h.date, h]));

  const spikes = [];
  for (let i = 3; i < weighted.length; i++) {
    const todayRow = weighted[i];
    const prior = weighted.slice(Math.max(0, i - 7), i);
    if (prior.length < 3) continue;
    const avgPrior = prior.reduce((s, r) => s + r.weight_kg, 0) / prior.length;
    const delta = todayRow.weight_kg - avgPrior;
    if (delta > threshold) {
      const explanation = explainSpike(
        todayRow.date, delta, logsByDate, healthByDate, profile
      );
      spikes.push({
        date: todayRow.date,
        weight_kg: todayRow.weight_kg,
        delta_kg: +delta.toFixed(2),
        avg_prior_kg: +avgPrior.toFixed(2),
        message: explanation,
      });
    }
  }
  spikes.reverse();
  return spikes;
}

function explainSpike(date, deltaKg, logsByDate, healthByDate, profile) {
  const y = logsByDate.get(isoMinus(date, 1));
  const yMinus1 = logsByDate.get(isoMinus(date, 2));

  // Trailing 14-day baselines (excluding today)
  let totCals = 0, nCals = 0, totCarbs = 0, nCarbs = 0;
  for (let i = 1; i <= 14; i++) {
    const r = logsByDate.get(isoMinus(date, i));
    if (!r) continue;
    if (r.calories != null) { totCals += r.calories; nCals++; }
    if (r.carbs != null) { totCarbs += r.carbs; nCarbs++; }
  }
  const avgCals = nCals ? totCals / nCals : null;
  const avgCarbs = nCarbs ? totCarbs / nCarbs : null;

  // Health-side baselines
  let totAct = 0, nAct = 0;
  for (let i = 1; i <= 14; i++) {
    const h = healthByDate.get(isoMinus(date, i));
    if (h?.active_calories != null) { totAct += h.active_calories; nAct++; }
  }
  const avgActive = nAct ? totAct / nAct : null;
  const yHealth = healthByDate.get(isoMinus(date, 1));
  const yMinus1Health = healthByDate.get(isoMinus(date, 2));

  // 1. Carbs jump → glycogen + water
  if (y?.carbs != null && avgCarbs != null && y.carbs > avgCarbs + 80) {
    return `Carbs were ${Math.round(y.carbs - avgCarbs)}g above your average yesterday (${y.carbs}g vs ${Math.round(avgCarbs)}g avg) — 1g of carbs holds ~3g water, so this is likely glycogen + water, not fat.`;
  }

  // 2. Calorie spike but weekly deficit → sodium / water
  if (y?.calories != null && avgCals != null && y.calories > avgCals + 300) {
    const weeklyTrend = avgCals < (profile._tdeeBest || avgCals + 1); // proxy: avg < TDEE means deficit
    return `Eaten calories spiked yesterday (${y.calories} vs ${Math.round(avgCals)} avg)${weeklyTrend ? ", but you're still in a weekly deficit" : ''} — sodium-driven water retention is the most likely cause and usually resolves in 1–2 days.`;
  }

  // 3. Hard workouts in last 2 days
  if (yHealth?.active_calories != null && yMinus1Health?.active_calories != null && avgActive != null) {
    const recentBurn = (yHealth.active_calories + yMinus1Health.active_calories) / 2;
    if (recentBurn > avgActive + 200) {
      return `Hard workouts in the last 2 days (~${Math.round(recentBurn)} active cal vs ${Math.round(avgActive)} typical) — muscle inflammation holds onto water and can add 0.5–1kg temporarily.`;
    }
  }

  // 4. Female profile → hormonal hint
  if (profile.sex === 'female') {
    return `No clear dietary cause from your recent logs. Hormonal cycle, hydration, or bowel content can swing daily weight 1–2kg — the 7-day average is what to watch.`;
  }

  // 5. Generic
  return `No clear dietary cause from your recent logs. Bowel content, hydration, or sodium load can swing daily weight 1–2kg — trust the 7-day average over any single number.`;
}

window.Charts = {
  loadChartJs,
  renderWeightChart,
  renderCaloriesChart,
  detectSpikes,
};
