/* Cheat-day calorie bank: weekly budget at chosen deficit, plus exercise bonus
   from Apple Health active calories above baseline. */

const DAY_OF_WEEK_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function mondayWeekRange(todayIso) {
  const [y, m, d] = todayIso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay() || 7; // Mon=1..Sun=7
  dt.setDate(dt.getDate() - (dow - 1));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const di = new Date(dt);
    di.setDate(dt.getDate() + i);
    const ny = di.getFullYear();
    const nm = String(di.getMonth() + 1).padStart(2, '0');
    const nd = String(di.getDate()).padStart(2, '0');
    days.push(`${ny}-${nm}-${nd}`);
  }
  return days;
}

function dowOfIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function computeCheatBudget(profile, dailyLogs, healthRows, tdee, opts) {
  const { targetKey = 'cut500', cheatDay = 6, today } = opts;
  const deficit = targetKey === 'maintenance' ? 0
                : targetKey === 'cut500'      ? 500
                : 1000;
  const dayTarget = Math.max(1000, tdee.best - deficit); // sanity floor
  const weekDays = mondayWeekRange(today);
  const cheatDayDate = (cheatDay >= 0 && cheatDay <= 6)
    ? weekDays.find(d => dowOfIso(d) === cheatDay) || null
    : null;

  // Baseline active calories: avg over up to 14 days BEFORE this week
  const weekSet = new Set(weekDays);
  const baselineSrc = healthRows
    .filter(h => h.active_calories != null && !weekSet.has(h.date) && h.date < weekDays[0])
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 14);
  const baselineActive = baselineSrc.length
    ? baselineSrc.reduce((s, h) => s + h.active_calories, 0) / baselineSrc.length
    : 0;

  const logMap = new Map(dailyLogs.map(l => [l.date, l]));
  const healthMap = new Map(healthRows.map(h => [h.date, h]));

  const days = weekDays.map(date => {
    const log = logMap.get(date);
    const h = healthMap.get(date);
    const eaten = log?.calories ?? null;
    const active = h?.active_calories ?? null;
    const exerciseBonus = active != null ? Math.max(0, Math.round(active - baselineActive)) : 0;
    return {
      date,
      dow: dowOfIso(date),
      label: DAY_OF_WEEK_LABELS[dowOfIso(date)],
      isCheat: cheatDayDate === date,
      isToday: date === today,
      isPast: date < today,
      isFuture: date > today,
      eaten,
      active,
      exerciseBonus,
      target: cheatDayDate === date ? null : dayTarget,
    };
  });

  const weeklyBaseBudget = dayTarget * 7; // ignore-cheat baseline (we redistribute below)
  const weeklyExerciseBonus = days.reduce((s, d) => s + d.exerciseBonus, 0);
  const totalWeeklyBudget = weeklyBaseBudget + weeklyExerciseBonus;

  // Track what's been eaten on cheat vs non-cheat days
  let spentNonCheat = 0;
  let spentCheat = 0;
  let loggedNonCheatDays = 0;
  for (const d of days) {
    if (d.eaten == null) continue;
    if (d.isCheat) spentCheat += d.eaten;
    else { spentNonCheat += d.eaten; loggedNonCheatDays++; }
  }

  // Non-cheat days that haven't been logged yet (we "reserve" their normal target)
  const remainingNonCheatDays = days.filter(d => !d.isCheat && d.eaten == null).length;
  const reservedNonCheat = remainingNonCheatDays * dayTarget;

  // What's left for the cheat day (after subtracting non-cheat past + non-cheat reserved + cheat-already-eaten)
  let cheatDayAvailable = null;
  if (cheatDayDate) {
    cheatDayAvailable = totalWeeklyBudget - spentNonCheat - reservedNonCheat - spentCheat;
  }

  // Total cal still available this week (used when no cheat day, or as a sanity check)
  const totalAvailableThisWeek = totalWeeklyBudget - spentNonCheat - spentCheat;

  // "Bank": how much your non-cheat days are under/over their targets so far
  let bankFromUndereating = 0;
  for (const d of days) {
    if (d.isCheat || d.eaten == null) continue;
    bankFromUndereating += (dayTarget - d.eaten); // positive if under target
  }

  return {
    weekStart: weekDays[0],
    weekEnd: weekDays[6],
    cheatDayDate,
    cheatDayLabel: cheatDayDate ? DAY_OF_WEEK_LABELS[dowOfIso(cheatDayDate)] : null,
    deficit,
    dayTarget: Math.round(dayTarget),
    weeklyBaseBudget: Math.round(weeklyBaseBudget),
    weeklyExerciseBonus: Math.round(weeklyExerciseBonus),
    totalWeeklyBudget: Math.round(totalWeeklyBudget),
    baselineActive: Math.round(baselineActive),
    spentNonCheat: Math.round(spentNonCheat),
    spentCheat: Math.round(spentCheat),
    loggedNonCheatDays,
    remainingNonCheatDays,
    reservedNonCheat: Math.round(reservedNonCheat),
    cheatDayAvailable: cheatDayAvailable != null ? Math.round(cheatDayAvailable) : null,
    totalAvailableThisWeek: Math.round(totalAvailableThisWeek),
    bankFromUndereating: Math.round(bankFromUndereating),
    days,
  };
}

window.CheatDay = { computeCheatBudget, mondayWeekRange, DAY_OF_WEEK_LABELS };
