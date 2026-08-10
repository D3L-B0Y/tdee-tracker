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
    return { available: false, reason: 'No activity data imported yet.' };
  }
  const sorted = [...healthRows].sort((a, b) => b.date.localeCompare(a.date));
  const bmr = computeBMR(profile, weightKg);

  // Different trackers mean different things by "calories", so the formula has to
  // match the source. The NEWEST rows decide, otherwise an old export from a
  // tracker you've stopped using keeps overriding your current one.
  //
  //   apple  -> active energy is all-day movement       => BMR + active
  //   google -> already a total daily burn              => total as-is
  //   mfp    -> logged workouts only, not daily movement => BMR x multiplier + exercise
  //
  // Rows imported before sources were tagged are inferred: a total_calories value
  // could only have come from a Google-style export; anything else is Apple-style.
  const rowSource = (h) => h.source || (h.total_calories != null ? 'google' : 'apple');

  const newest = sorted.find(h => h.total_calories != null || h.active_calories != null);
  if (!newest) {
    return { available: false, reason: 'Need 3+ days of imported activity data.' };
  }
  const inferredSource = rowSource(newest);

  // Only average rows from the SAME source. Mixing them would blend numbers that
  // mean different things — e.g. straddling an Apple->MFP switch would silently
  // produce an average of two incompatible measurements.
  const sameSource = sorted.filter(h => rowSource(h) === inferredSource);

  if (inferredSource === 'google') {
    const withTotal = sameSource.filter(h => h.total_calories != null);
    if (withTotal.length >= 3) {
      const recent = withTotal.slice(0, 7);
      const avgTotal = recent.reduce((s, h) => s + h.total_calories, 0) / recent.length;
      return {
        available: true,
        basis: 'total',
        source: 'google',
        tdee: Math.round(avgTotal),
        bmr: Math.round(bmr),
        avgTotal: Math.round(avgTotal),
        avgActive: Math.round(Math.max(0, avgTotal - bmr)),
        days: recent.length,
        firstDate: recent[recent.length - 1].date,
        lastDate: recent[0].date,
      };
    }
  }

  const withActive = sameSource.filter(h => h.active_calories != null);
  if (withActive.length < 3) {
    return {
      available: false,
      reason: `Need 3+ days from your current source (have ${withActive.length}). Upload another export.`,
    };
  }
  const recent = withActive.slice(0, 7);
  const avgActive = recent.reduce((s, h) => s + h.active_calories, 0) / recent.length;

  if (inferredSource === 'myfitnesspal') {
    // MFP exercise calories are a supplement to your baseline, not a replacement
    // for it — the activity multiplier already covers everyday movement.
    const base = bmr * profile.activity_level;
    return {
      available: true,
      basis: 'exercise-on-base',
      source: 'myfitnesspal',
      tdee: Math.round(base + avgActive),
      bmr: Math.round(bmr),
      base: Math.round(base),
      multiplier: profile.activity_level,
      avgExercise: Math.round(avgActive),
      avgActive: Math.round(avgActive),
      days: recent.length,
      firstDate: recent[recent.length - 1].date,
      lastDate: recent[0].date,
    };
  }

  return {
    available: true,
    basis: 'active',
    source: 'apple',
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
    if (health.basis === 'total') {
      explainer = `${health.days}-day avg total daily burn from Google data (${health.avgTotal} cal/day — BMR already included). Log 14+ days of calories & weight for adaptive — that's the gold standard.`;
    } else if (health.basis === 'exercise-on-base') {
      explainer = `Baseline ${health.base} (BMR ${health.bmr} × ${health.multiplier} activity) + ${health.days}-day avg logged exercise from MyFitnessPal (${health.avgExercise} cal/day). MFP only counts logged workouts, so your activity level setting matters here — check it's honest. Log 14+ days of calories & weight for adaptive.`;
    } else {
      explainer = `BMR (${health.bmr}) + ${health.days}-day avg active burn from Apple Health (${health.avgActive} cal/day). Log 14+ days of calories & weight for adaptive — that's the gold standard.`;
    }
  } else {
    bestKey = 'static';
    best = stat.tdee;
    explainer = `Mifflin–St Jeor BMR × activity multiplier (×${stat.multiplier}). Import Apple Health, MyFitnessPal or Google Fit data for a tracker-driven estimate, or log 14+ days for adaptive.`;
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
