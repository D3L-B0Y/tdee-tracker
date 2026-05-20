/* TDEE calculations — three modes + best-available picker. */

const CAL_PER_KG = 7700; // standard energy-density estimate for body tissue

function calculateAge(dob) {
  if (!dob) return 0;
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function computeBMR(profile, weightKg) {
  // Mifflin-St Jeor
  const age = calculateAge(profile.dob);
  const base = 10 * weightKg + 6.25 * profile.height_cm - 5 * age;
  return profile.sex === 'male' ? base + 5 : base - 161;
}

function computeStaticTDEE(profile, weightKg) {
  const bmr = computeBMR(profile, weightKg);
  return {
    available: true,
    tdee: Math.round(bmr * profile.activity_level),
    bmr: Math.round(bmr),
    multiplier: profile.activity_level,
    weightUsed: weightKg,
  };
}

function computeHealthTDEE(profile, healthRows, weightKg) {
  // BMR (no multiplier) + 7-day rolling average of active calories.
  if (!healthRows || healthRows.length === 0) {
    return { available: false, reason: 'No Apple Health data imported yet.' };
  }
  const sorted = [...healthRows].sort((a, b) => b.date.localeCompare(a.date));
  const withActive = sorted.filter(h => h.active_calories != null);
  if (withActive.length < 3) {
    return { available: false, reason: 'Need 3+ days of Apple Health active-energy data.' };
  }
  const recent = withActive.slice(0, 7);
  const avgActive = recent.reduce((s, h) => s + h.active_calories, 0) / recent.length;
  const bmr = computeBMR(profile, weightKg);
  return {
    available: true,
    tdee: Math.round(bmr + avgActive),
    bmr: Math.round(bmr),
    avgActive: Math.round(avgActive),
    days: recent.length,
    firstDate: recent[recent.length - 1].date,
    lastDate: recent[0].date,
  };
}

function computeAdaptiveTDEE(dailyLogs, windowDays) {
  // actual_TDEE = avg(intake) − (weight_change_kg × 7700) / days
  // where weight_change = endWeight − startWeight (negative if losing)
  if (!dailyLogs || dailyLogs.length === 0) {
    return { available: false, reason: `Need ${windowDays}+ days of logged calories & weight.` };
  }
  const sorted = [...dailyLogs].sort((a, b) => a.date.localeCompare(b.date));
  const latestDate = sorted[sorted.length - 1].date;
  const cutoff = isoDateMinus(latestDate, windowDays - 1);
  const inWindow = sorted.filter(l => l.date >= cutoff);

  const calorieDays = inWindow.filter(l => l.calories != null && l.calories > 0);
  const weightDays = inWindow.filter(l => l.weight_kg != null);

  const minCalorieDays = Math.ceil(windowDays * 0.5); // need ≥50% coverage
  if (calorieDays.length < minCalorieDays) {
    return {
      available: false,
      reason: `Need ≥${minCalorieDays} days of calorie logs in last ${windowDays} (have ${calorieDays.length}).`,
    };
  }
  if (weightDays.length < 2) {
    return {
      available: false,
      reason: `Need ≥2 weigh-ins in last ${windowDays} days (have ${weightDays.length}).`,
    };
  }

  const startWeight = weightDays[0].weight_kg;
  const endWeight = weightDays[weightDays.length - 1].weight_kg;
  const startDate = weightDays[0].date;
  const endDate = weightDays[weightDays.length - 1].date;
  const spanDays = daysBetween(startDate, endDate);

  if (spanDays < 7) {
    return {
      available: false,
      reason: `Weigh-ins span only ${spanDays} day(s) — need ≥7 for a meaningful trend.`,
    };
  }

  const avgCalories = calorieDays.reduce((s, l) => s + l.calories, 0) / calorieDays.length;
  const weightChange = endWeight - startWeight;
  const tdee = avgCalories - (weightChange * CAL_PER_KG) / spanDays;

  return {
    available: true,
    tdee: Math.round(tdee),
    avgCalories: Math.round(avgCalories),
    weightChange: +weightChange.toFixed(2),
    spanDays,
    calorieDays: calorieDays.length,
    weightPoints: weightDays.length,
    windowDays,
    startDate,
    endDate,
  };
}

function computeAllModes(profile, dailyLogs, healthRows) {
  // Pick "current weight": most recent weigh-in, else starting weight
  const sortedByDateDesc = [...dailyLogs].sort((a, b) => b.date.localeCompare(a.date));
  const latestWeightRow = sortedByDateDesc.find(l => l.weight_kg != null);
  const currentWeightKg = latestWeightRow ? latestWeightRow.weight_kg : profile.starting_weight_kg;

  const stat = computeStaticTDEE(profile, currentWeightKg);
  const health = computeHealthTDEE(profile, healthRows, currentWeightKg);
  const adapt14 = computeAdaptiveTDEE(dailyLogs, 14);
  const adapt28 = computeAdaptiveTDEE(dailyLogs, 28);

  let bestKey, best, explainer;
  if (adapt28.available) {
    bestKey = 'adaptive28';
    best = adapt28.tdee;
    explainer = `28-day adaptive: avg intake ${adapt28.avgCalories} cal/day, weight ${signed(adapt28.weightChange)} kg over ${adapt28.spanDays} days. This is the most accurate — based on your own results.`;
  } else if (adapt14.available) {
    bestKey = 'adaptive14';
    best = adapt14.tdee;
    explainer = `14-day adaptive: avg intake ${adapt14.avgCalories} cal/day, weight ${signed(adapt14.weightChange)} kg over ${adapt14.spanDays} days. Will get more accurate with another two weeks of data.`;
  } else if (health.available) {
    bestKey = 'health';
    best = health.tdee;
    explainer = `BMR (${health.bmr}) + ${health.days}-day avg active burn from Apple Health (${health.avgActive} cal/day). Log 14+ days of calories & weight for adaptive — that's the gold standard.`;
  } else {
    bestKey = 'static';
    best = stat.tdee;
    explainer = `Mifflin–St Jeor BMR × activity multiplier (×${stat.multiplier}). Upload Apple Health data for a watch-driven estimate, or log 14+ days for adaptive.`;
  }

  return {
    bestKey,
    best,
    explainer,
    currentWeightKg,
    targets: {
      maintenance: best,
      cut500: best - 500,
      cut1000: best - 1000,
    },
    modes: {
      static: stat,
      health,
      adaptive14: adapt14,
      adaptive28: adapt28,
    },
  };
}

function signed(n) {
  if (n > 0) return `+${n}`;
  return String(n);
}

function isoDateMinus(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - days);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function daysBetween(isoA, isoB) {
  const [ay, am, ad] = isoA.split('-').map(Number);
  const [by, bm, bd] = isoB.split('-').map(Number);
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  return Math.round((b - a) / 86400000) + 1; // inclusive
}

window.TDEE = {
  calculateAge,
  computeBMR,
  computeStaticTDEE,
  computeHealthTDEE,
  computeAdaptiveTDEE,
  computeAllModes,
};
