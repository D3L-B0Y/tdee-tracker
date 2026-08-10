/* Main app — routing, profile management, daily entry. */

const App = {
  state: {
    profiles: [],
    activeProfileId: null,
    view: 'loading',          // 'welcome' | 'profile-form' | 'dashboard'
    editingProfileId: null,
  },

  async init() {
    await DB.openDB();
    await this.refreshProfiles();
    const stored = await DB.getSetting('active_profile_id');
    if (stored && this.state.profiles.some(p => p.id === stored)) {
      this.state.activeProfileId = stored;
    } else if (this.state.profiles.length > 0) {
      this.state.activeProfileId = this.state.profiles[0].id;
      await DB.setSetting('active_profile_id', this.state.activeProfileId);
    }
    this.bindGlobal();
    this.render();
  },

  async refreshProfiles() {
    this.state.profiles = await DB.listProfiles();
    this.state.profiles.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  },

  bindGlobal() {
    document.getElementById('settings-btn').addEventListener('click', () => {
      if (this.state.activeProfileId) {
        this.state.editingProfileId = this.state.activeProfileId;
        this.state.view = 'profile-form';
        this.render();
      } else {
        this.state.view = 'profile-form';
        this.render();
      }
    });
    document.getElementById('export-btn').addEventListener('click', () => this.handleExport());
    document.getElementById('backup-btn').addEventListener('click', () => this.handleBackup());
    document.getElementById('restore-file').addEventListener('change', (e) => this.handleRestore(e.target));
  },

  async handleBackup() {
    try {
      const r = await Backup.exportBackup();
      if (r.cancelled) { toast('Backup cancelled', 'error'); return; }
      const total = Object.values(r.counts).reduce((s, v) => s + v, 0);
      const verb = r.method === 'share' ? 'shared' : 'downloaded';
      toast(`Backup ${verb} · ${total} records across ${Object.keys(r.counts).length} stores`, 'success');
    } catch (err) {
      toast(err.message || 'Backup failed', 'error');
    }
  },

  async handleRestore(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const node = document.getElementById('tpl-restore-mode').content.cloneNode(true);
    const backdrop = node.querySelector('.modal-backdrop');
    node.querySelector('[data-role="file-info"]').textContent =
      `File: ${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    const close = () => backdrop.remove();
    node.querySelector('[data-action="cancel"]').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    node.querySelectorAll('.restore-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        close();
        this._performRestore(file, mode === 'replace');
      });
    });
    document.body.appendChild(node);
  },

  async _performRestore(file, wipeFirst) {
    try {
      const r = await Backup.restoreBackup(file, { wipeFirst });
      await this.refreshProfiles();
      const active = await DB.getSetting('active_profile_id');
      if (active && this.state.profiles.some(p => p.id === active)) {
        this.state.activeProfileId = active;
        this.state.view = 'dashboard';
      } else if (this.state.profiles.length > 0) {
        this.state.activeProfileId = this.state.profiles[0].id;
        this.state.view = 'dashboard';
      } else {
        this.state.view = 'welcome';
      }
      this.render();
      const total = Object.values(r.counts).reduce((s, v) => s + v, 0);
      const skippedTotal = Object.values(r.skipped || {}).reduce((s, v) => s + v, 0);
      const action = wipeFirst ? 'Replaced' : 'Merged';
      const msg = skippedTotal > 0
        ? `${action} ${total} records (skipped ${skippedTotal} malformed)`
        : `${action} ${total} records from ${new Date(r.exportedAt).toLocaleDateString()}`;
      toast(msg, 'success');
      if (Object.keys(r.issues || {}).length) {
        console.warn('Restore issues:', r.issues);
      }
    } catch (err) {
      toast(err.message || 'Restore failed', 'error');
    }
  },

  async handleExport() {
    const profileId = this.state.activeProfileId;
    if (!profileId) {
      toast('Pick a profile first', 'error');
      return;
    }
    const profile = this.state.profiles.find(p => p.id === profileId);
    try {
      const [logs, health] = await Promise.all([
        DB.listDailyLogs(profileId, { limit: 10000 }),
        DB.listHealthDaily(profileId),
      ]);
      if (logs.length === 0 && health.length === 0) {
        toast('Nothing to export yet — log some entries or import Health data first', 'error');
        return;
      }
      const tdee = TDEE.computeAllModes(profile, logs, health);
      const result = await Exporter.exportProfileToExcel(profile, logs, health, tdee);
      toast(`Downloaded ${result.filename}`, 'success');
    } catch (err) {
      console.error(err);
      toast(err.message || 'Export failed', 'error');
    }
  },

  render() {
    this.renderProfileSwitcher();
    const main = document.getElementById('app');
    main.innerHTML = '';

    if (this.state.profiles.length === 0 && this.state.view !== 'profile-form') {
      this.state.view = 'welcome';
    }

    if (this.state.view === 'welcome') {
      const tpl = document.getElementById('tpl-welcome').content.cloneNode(true);
      tpl.querySelector('[data-action="create-first"]').addEventListener('click', () => {
        this.state.editingProfileId = null;
        this.state.view = 'profile-form';
        this.render();
      });
      main.appendChild(tpl);
      return;
    }

    if (this.state.view === 'profile-form') {
      this.renderProfileForm(main);
      return;
    }

    if (this.state.view === 'dashboard') {
      this.renderDashboard(main);
      return;
    }
  },

  renderProfileSwitcher() {
    const host = document.getElementById('profile-switcher');
    host.innerHTML = '';
    for (const p of this.state.profiles) {
      const btn = document.createElement('button');
      btn.className = 'profile-pill' + (p.id === this.state.activeProfileId ? ' active' : '');
      btn.textContent = p.name;
      btn.addEventListener('click', async () => {
        this.state.activeProfileId = p.id;
        await DB.setSetting('active_profile_id', p.id);
        this.state.view = 'dashboard';
        this.render();
      });
      host.appendChild(btn);
    }
    if (this.state.profiles.length < 2) {
      const add = document.createElement('button');
      add.className = 'profile-pill add';
      add.textContent = this.state.profiles.length === 0 ? '+ Add profile' : '+ Add second profile';
      add.addEventListener('click', () => {
        this.state.editingProfileId = null;
        this.state.view = 'profile-form';
        this.render();
      });
      host.appendChild(add);
    }
  },

  /* ============ profile form ============ */

  renderProfileForm(main) {
    const node = document.getElementById('tpl-profile-form').content.cloneNode(true);
    const form = node.querySelector('#profile-form');
    const title = node.querySelector('[data-role="title"]');
    const editing = this.state.editingProfileId
      ? this.state.profiles.find(p => p.id === this.state.editingProfileId)
      : null;

    title.textContent = editing ? `Edit ${editing.name}` : 'New profile';

    // Unit toggles
    form.querySelectorAll('input[name="height_unit"]').forEach(r => {
      r.addEventListener('change', () => {
        const unit = form.querySelector('input[name="height_unit"]:checked').value;
        form.querySelector('[data-unit="cm"]').classList.toggle('hidden', unit !== 'cm');
        form.querySelector('[data-unit="ft"]').classList.toggle('hidden', unit !== 'ft');
      });
    });

    if (editing) {
      form.name.value = editing.name;
      form.sex.value = editing.sex;
      form.dob.value = editing.dob;
      if (editing.height_unit === 'ft') {
        form.querySelector('input[name="height_unit"][value="ft"]').checked = true;
        const totalIn = (editing.height_cm / 2.54);
        const ft = Math.floor(totalIn / 12);
        const inches = +(totalIn - ft * 12).toFixed(1);
        form.height_ft.value = ft;
        form.height_in.value = inches;
        form.querySelector('[data-unit="cm"]').classList.add('hidden');
        form.querySelector('[data-unit="ft"]').classList.remove('hidden');
      } else {
        form.height_cm.value = editing.height_cm ?? '';
      }
      const wUnit = editing.weight_unit || 'kg';
      form.querySelector(`input[name="weight_unit"][value="${wUnit}"]`).checked = true;
      const fromKg = (kg) => wUnit === 'lbs' ? +(kg * 2.20462).toFixed(1) : +kg.toFixed(1);
      form.start_weight.value = editing.starting_weight_kg != null ? fromKg(editing.starting_weight_kg) : '';
      form.goal_weight.value = editing.goal_weight_kg != null ? fromKg(editing.goal_weight_kg) : '';
      form.activity_level.value = String(editing.activity_level ?? 1.55);

      // Add delete option when editing
      const actions = form.querySelector('.actions');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn danger';
      del.textContent = 'Delete profile';
      del.style.marginRight = 'auto';
      del.addEventListener('click', () => this.confirmDeleteProfile(editing));
      actions.insertBefore(del, actions.firstChild);
    }

    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      this.state.editingProfileId = null;
      this.state.view = this.state.profiles.length > 0 ? 'dashboard' : 'welcome';
      this.render();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const profile = this.serializeProfileForm(form, editing);
        await DB.saveProfile(profile);
        await this.refreshProfiles();
        this.state.activeProfileId = profile.id;
        await DB.setSetting('active_profile_id', profile.id);
        this.state.editingProfileId = null;
        this.state.view = 'dashboard';
        this.render();
        toast(editing ? 'Profile updated' : 'Profile saved', 'success');
      } catch (err) {
        toast(err.message || 'Could not save profile', 'error');
      }
    });

    main.appendChild(node);
  },

  serializeProfileForm(form, editing) {
    const name = form.name.value.trim();
    if (!name) throw new Error('Name is required');
    const sex = form.sex.value;
    if (sex !== 'male' && sex !== 'female') throw new Error('Pick a sex (used for BMR formula)');
    const dob = form.dob.value;
    if (!dob) throw new Error('Date of birth required');

    const heightUnit = form.querySelector('input[name="height_unit"]:checked').value;
    let height_cm;
    if (heightUnit === 'ft') {
      const ft = parseFloat(form.height_ft.value);
      const inches = parseFloat(form.height_in.value) || 0;
      if (!ft || ft < 3) throw new Error('Enter a valid height');
      height_cm = (ft * 12 + inches) * 2.54;
    } else {
      height_cm = parseFloat(form.height_cm.value);
      if (!height_cm || height_cm < 80) throw new Error('Enter a valid height');
    }
    height_cm = +height_cm.toFixed(1);

    const weightUnit = form.querySelector('input[name="weight_unit"]:checked').value;
    const startInput = parseFloat(form.start_weight.value);
    const goalInput = parseFloat(form.goal_weight.value);
    if (!startInput || !goalInput) throw new Error('Enter starting and goal weight');
    const toKg = (v) => weightUnit === 'lbs' ? v / 2.20462 : v;
    const starting_weight_kg = +toKg(startInput).toFixed(2);
    const goal_weight_kg = +toKg(goalInput).toFixed(2);

    const activity_level = parseFloat(form.activity_level.value);

    return {
      id: editing ? editing.id : crypto.randomUUID(),
      name,
      sex,
      dob,
      height_cm,
      height_unit: heightUnit,
      starting_weight_kg,
      goal_weight_kg,
      weight_unit: weightUnit,
      activity_level,
      created_at: editing ? editing.created_at : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  confirmDeleteProfile(profile) {
    showConfirm({
      title: `Delete ${profile.name}?`,
      body: `This permanently removes ${profile.name}'s profile and all logged data. This can't be undone.`,
      confirmLabel: 'Delete profile',
      onConfirm: async () => {
        await DB.deleteProfile(profile.id);
        await this.refreshProfiles();
        if (this.state.activeProfileId === profile.id) {
          this.state.activeProfileId = this.state.profiles[0]?.id || null;
          await DB.setSetting('active_profile_id', this.state.activeProfileId);
        }
        this.state.editingProfileId = null;
        this.state.view = this.state.profiles.length > 0 ? 'dashboard' : 'welcome';
        this.render();
        toast('Profile deleted', 'success');
      },
    });
  },

  /* ============ dashboard ============ */

  async renderDashboard(main) {
    const node = document.getElementById('tpl-dashboard').content.cloneNode(true);
    main.appendChild(node);
    await this.refreshDashboard();
    this.bindEntryForms();
    this.bindHealthCard();
    this.bindMeasurementsForm();
  },

  bindMeasurementsForm() {
    const main = document.getElementById('app');
    const form = main.querySelector('#measure-form');
    if (!form) return;
    form.date.value = todayLocalISO();
    DB.getSetting('last_measure_unit').then(u => {
      if (u) form.querySelector(`input[name="measure_unit"][value="${u}"]`).checked = true;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const profileId = this.state.activeProfileId;
      if (!profileId) return;
      const unit = form.querySelector('input[name="measure_unit"]:checked').value;
      const toCm = (v) => unit === 'in' ? v * 2.54 : v;
      const num = (n) => {
        const v = parseFloat(n);
        return Number.isFinite(v) ? v : null;
      };
      const w = num(form.waist.value);
      const c = num(form.chest.value);
      const a = num(form.arms.value);
      const l = num(form.legs.value);
      const cv = num(form.calves.value);
      if (w == null && c == null && a == null && l == null && cv == null) {
        toast('Enter at least one measurement', 'error');
        return;
      }
      await DB.upsertMeasurement(profileId, form.date.value, {
        waist_cm:  w  != null ? +toCm(w).toFixed(2)  : null,
        chest_cm:  c  != null ? +toCm(c).toFixed(2)  : null,
        arms_cm:   a  != null ? +toCm(a).toFixed(2)  : null,
        legs_cm:   l  != null ? +toCm(l).toFixed(2)  : null,
        calves_cm: cv != null ? +toCm(cv).toFixed(2) : null,
      });
      await DB.setSetting('last_measure_unit', unit);
      form.waist.value = ''; form.chest.value = ''; form.arms.value = '';
      form.legs.value = '';  form.calves.value = '';
      await this.refreshMeasurements();
      toast('Measurements saved', 'success');
    });
  },

  async refreshMeasurements() {
    const profileId = this.state.activeProfileId;
    if (!profileId) return;
    const main = document.getElementById('app');
    const list = main.querySelector('[data-role="measure-list"]');
    const countEl = main.querySelector('[data-role="measure-count"]');
    if (!list || !countEl) return;
    const rows = await DB.listMeasurements(profileId, { limit: 30 });
    const profile = this.state.profiles.find(p => p.id === profileId);
    const unit = (await DB.getSetting('last_measure_unit')) || 'cm';
    countEl.textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`;
    list.innerHTML = '';
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted small empty';
      p.textContent = 'No measurements logged yet. Pick a body site, log a baseline, repeat weekly.';
      list.appendChild(p);
      return;
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'measure-row';

      const date = document.createElement('div');
      date.className = 'date';
      date.textContent = formatHumanDate(r.date, { short: true });
      row.appendChild(date);

      const vals = document.createElement('div');
      vals.className = 'vals';
      const fmt = (cm) => {
        if (cm == null) return null;
        return unit === 'in' ? `${(cm / 2.54).toFixed(1)} in` : `${cm.toFixed(1)} cm`;
      };
      const pairs = [
        ['Waist', r.waist_cm], ['Chest', r.chest_cm], ['Arms', r.arms_cm],
        ['Legs', r.legs_cm],   ['Calves', r.calves_cm],
      ];
      for (const [label, v] of pairs) {
        if (v == null) continue;
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = `${label} ${fmt(v)}`;
        vals.appendChild(pill);
      }
      row.appendChild(vals);

      const del = document.createElement('button');
      del.className = 'delete';
      del.title = 'Delete measurement';
      del.innerHTML = '&times;';
      del.addEventListener('click', () => {
        showConfirm({
          title: `Delete measurements for ${formatHumanDate(r.date)}?`,
          body: 'Removes all body measurements logged on that date.',
          confirmLabel: 'Delete',
          onConfirm: async () => {
            await DB.deleteMeasurement(profileId, r.date);
            await this.refreshMeasurements();
            toast('Measurement deleted', 'success');
          },
        });
      });
      row.appendChild(del);
      list.appendChild(row);
    }
  },

  bindHealthCard() {
    const main = document.getElementById('app');
    const fileInput = main.querySelector('#health-file');
    const clearBtn = main.querySelector('[data-role="health-clear"]');
    const progressWrap = main.querySelector('[data-role="health-progress"]');
    const barFill = main.querySelector('[data-role="bar-fill"]');
    const progText = main.querySelector('[data-role="progress-text"]');

    fileInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const profileId = this.state.activeProfileId;
      if (!profileId) return;
      progressWrap.classList.remove('hidden');
      barFill.style.width = '0%';
      progText.textContent = 'Starting import…';
      const phaseLabels = { read: 'Reading', unzip: 'Unzipping', parse: 'Parsing records', save: 'Saving daily totals' };
      try {
        const result = await HealthImport.importHealthData(profileId, file, ({ phase, percent, recordsParsed, recordsKept }) => {
          barFill.style.width = `${percent ?? 0}%`;
          const phaseTxt = phaseLabels[phase] || phase;
          if (phase === 'parse' && recordsParsed != null) {
            progText.textContent = `${phaseTxt} · ${recordsParsed.toLocaleString()} records${recordsKept ? ` (${recordsKept.toLocaleString()} kept)` : ''}`;
          } else {
            progText.textContent = `${phaseTxt} · ${percent}%`;
          }
        });
        progText.textContent = `Done · ${result.daysCovered} days, ${result.recordsKept.toLocaleString()} records kept`;
        setTimeout(() => progressWrap.classList.add('hidden'), 2200);
        await this.refreshDashboard();
        toast(`Imported ${result.daysCovered} days of Apple Health data`, 'success');
      } catch (err) {
        console.error(err);
        progText.textContent = `Failed: ${err.message}`;
        toast(err.message || 'Import failed', 'error');
      } finally {
        fileInput.value = '';
      }
    };

    const manualBtn = main.querySelector('[data-role="manual-entry-btn"]');
    if (manualBtn) manualBtn.onclick = () => this.openManualHealthModal();

    clearBtn.onclick = () => {
      const profileId = this.state.activeProfileId;
      if (!profileId) return;
      showConfirm({
        title: 'Clear all Apple Health data?',
        body: 'Removes all imported daily totals for this profile. Your manual logs are kept.',
        confirmLabel: 'Clear health data',
        onConfirm: async () => {
          await HealthImport.clearHealthData(profileId);
          await this.refreshDashboard();
          toast('Apple Health data cleared', 'success');
        },
      });
    };
  },

  bindEntryForms() {
    const main = document.getElementById('app');
    const tabs = main.querySelectorAll('.tab');
    tabs.forEach(t => {
      t.addEventListener('click', () => {
        tabs.forEach(x => x.classList.toggle('active', x === t));
        main.querySelectorAll('[data-tab-panel]').forEach(p => {
          p.classList.toggle('hidden', p.dataset.tabPanel !== t.dataset.tab);
        });
      });
    });

    const todayStr = todayLocalISO();
    const foodForm = main.querySelector('#food-form');
    const weightForm = main.querySelector('#weight-form');
    foodForm.date.value = todayStr;
    weightForm.date.value = todayStr;

    // Remember weight unit
    DB.getSetting('last_weight_unit').then(u => {
      if (u) weightForm.weight_unit.value = u;
    });

    foodForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const profileId = this.state.activeProfileId;
      if (!profileId) return;
      const date = foodForm.date.value;
      const calories = foodForm.calories.value ? parseInt(foodForm.calories.value, 10) : null;
      const carbs = foodForm.carbs.value ? parseInt(foodForm.carbs.value, 10) : null;
      const notes = foodForm.notes.value.trim();
      if (calories == null && carbs == null && !notes) {
        toast('Enter calories, carbs, or notes', 'error');
        return;
      }
      await DB.upsertDailyLog(profileId, date, { calories, carbs, notes });
      foodForm.calories.value = '';
      foodForm.carbs.value = '';
      foodForm.notes.value = '';
      await this.refreshDashboard();
      toast('Food entry saved', 'success');
    });

    weightForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const profileId = this.state.activeProfileId;
      if (!profileId) return;
      const date = weightForm.date.value;
      const raw = parseFloat(weightForm.weight.value);
      if (!raw) { toast('Enter a weight', 'error'); return; }
      const unit = weightForm.weight_unit.value;
      const weight_kg = unit === 'lbs' ? +(raw / 2.20462).toFixed(2) : +raw.toFixed(2);
      await DB.upsertDailyLog(profileId, date, { weight_kg });
      await DB.setSetting('last_weight_unit', unit);
      weightForm.weight.value = '';
      await this.refreshDashboard();
      toast('Weight saved', 'success');
    });
  },

  async refreshDashboard() {
    const profileId = this.state.activeProfileId;
    if (!profileId) return;
    const profile = this.state.profiles.find(p => p.id === profileId);
    const main = document.getElementById('app');

    // Pull all daily logs + health rows for TDEE calc (use a wide window).
    const allLogs = await DB.listDailyLogs(profileId, { limit: 400 });
    const healthRows = await DB.listHealthDaily(profileId);
    const tdee = TDEE.computeAllModes(profile, allLogs, healthRows);

    // Selected target pref (per profile)
    const targetKey = await DB.getSetting(`target_${profileId}`) || 'cut500';

    this.renderTargets(main, tdee, targetKey);

    // Today card
    const today = todayLocalISO();
    main.querySelector('[data-role="today-date"]').textContent = formatHumanDate(today);
    const log = await DB.getDailyLog(profileId, today);
    const eaten = log?.calories ?? null;
    main.querySelector('[data-role="today-eaten"]').textContent =
      eaten != null ? `${eaten} cal` : '—';
    main.querySelector('[data-role="today-carbs"]').textContent =
      log?.carbs != null ? `${log.carbs} g` : '—';

    // Remaining vs target
    const targetCal = tdee.targets[targetKey];
    const remainingEl = main.querySelector('[data-role="today-remaining"]');
    remainingEl.classList.remove('over', 'under', 'met');
    if (eaten == null) {
      remainingEl.textContent = `${targetCal} cal target`;
    } else {
      const remaining = targetCal - eaten;
      if (remaining > 0) {
        remainingEl.textContent = `${remaining} cal left`;
        remainingEl.classList.add('under');
      } else if (remaining === 0) {
        remainingEl.textContent = `On target`;
        remainingEl.classList.add('met');
      } else {
        remainingEl.textContent = `${Math.abs(remaining)} over`;
        remainingEl.classList.add('over');
      }
    }

    // Latest weight
    const lastWeight = allLogs.find(r => r.weight_kg != null);
    if (lastWeight) {
      const unit = profile?.weight_unit || 'kg';
      const value = unit === 'lbs'
        ? `${(lastWeight.weight_kg * 2.20462).toFixed(1)} lbs`
        : `${lastWeight.weight_kg.toFixed(1)} kg`;
      main.querySelector('[data-role="today-weight"]').textContent =
        `${value} · ${formatHumanDate(lastWeight.date)}`;
    } else {
      main.querySelector('[data-role="today-weight"]').textContent = '—';
    }

    this.renderHistory(allLogs.slice(0, 60), profile);
    await this.refreshHealthCard(profileId, healthRows);
    await this.refreshCheatDay(profile, allLogs, healthRows, tdee, targetKey);
    await this.refreshCharts(profile, allLogs, healthRows, tdee);
    await this.refreshMeasurements();
  },

  async refreshCheatDay(profile, allLogs, healthRows, tdee, targetKey) {
    const main = document.getElementById('app');
    const profileId = profile.id;
    const today = todayLocalISO();

    // Per-profile cheat day setting (default Saturday = 6, -1 = none)
    let cheatDay = await DB.getSetting(`cheat_day_${profileId}`);
    if (cheatDay == null) cheatDay = 6;

    const select = main.querySelector('[data-role="cheat-day-select"]');
    select.value = String(cheatDay);
    select.onchange = async () => {
      await DB.setSetting(`cheat_day_${profileId}`, parseInt(select.value, 10));
      await this.refreshDashboard();
    };

    const result = CheatDay.computeCheatBudget(profile, allLogs, healthRows, tdee, {
      targetKey, cheatDay, today,
    });

    // Header range
    main.querySelector('[data-role="cheat-week-range"]').textContent =
      `Week of ${formatHumanDate(result.weekStart)} → ${formatHumanDate(result.weekEnd)}`;

    // Headline
    const headlineLabel = main.querySelector('[data-role="cheat-headline-label"]');
    const headlineValue = main.querySelector('[data-role="cheat-headline-value"]');
    const headlineSub   = main.querySelector('[data-role="cheat-headline-sub"]');
    headlineValue.classList.remove('over');

    if (result.cheatDayDate) {
      headlineLabel.textContent = `${result.cheatDayLabel} available`;
      const v = result.cheatDayAvailable;
      headlineValue.textContent = `${v.toLocaleString()} cal`;
      if (v < 0) headlineValue.classList.add('over');
      const cheatLog = result.days.find(d => d.isCheat);
      if (cheatLog?.eaten != null) {
        const remaining = v;
        headlineSub.textContent = remaining >= 0
          ? `Eaten ${cheatLog.eaten.toLocaleString()} on cheat day — ${remaining.toLocaleString()} cal still in budget.`
          : `Eaten ${cheatLog.eaten.toLocaleString()} on cheat day — ${Math.abs(remaining).toLocaleString()} over your weekly plan.`;
      } else {
        headlineSub.textContent =
          `Weekly target ${result.totalWeeklyBudget.toLocaleString()} − spent ${result.spentNonCheat.toLocaleString()} − reserved ${result.reservedNonCheat.toLocaleString()} for ${result.remainingNonCheatDays} non-cheat day${result.remainingNonCheatDays===1?'':'s'}.`;
      }
    } else {
      headlineLabel.textContent = 'Available this week';
      const v = result.totalAvailableThisWeek;
      headlineValue.textContent = `${v.toLocaleString()} cal`;
      if (v < 0) headlineValue.classList.add('over');
      headlineSub.textContent = `${result.totalWeeklyBudget.toLocaleString()} weekly cap minus ${(result.spentNonCheat + result.spentCheat).toLocaleString()} eaten so far.`;
    }

    // Stat grid
    main.querySelector('[data-role="cheat-day-target"]').textContent = `${result.dayTarget.toLocaleString()} cal`;
    main.querySelector('[data-role="cheat-deficit-label"]').textContent =
      result.deficit === 0 ? 'maintenance' : `−${result.deficit} deficit`;
    main.querySelector('[data-role="cheat-weekly-budget"]').textContent =
      `${result.weeklyBaseBudget.toLocaleString()} cal`;
    main.querySelector('[data-role="cheat-exercise-bonus"]').textContent =
      `+${result.weeklyExerciseBonus.toLocaleString()} cal`;
    main.querySelector('[data-role="cheat-baseline"]').textContent =
      result.baselineActive > 0
        ? `above ${result.baselineActive} cal baseline`
        : 'no Apple Health baseline yet';
    const totalEaten = result.spentNonCheat + result.spentCheat;
    main.querySelector('[data-role="cheat-eaten"]').textContent = `${totalEaten.toLocaleString()} cal`;
    main.querySelector('[data-role="cheat-eaten-detail"]').textContent =
      `${result.loggedNonCheatDays} normal day${result.loggedNonCheatDays===1?'':'s'} logged`;

    // Day strip
    const strip = main.querySelector('[data-role="cheat-day-strip"]');
    strip.innerHTML = '';
    for (const d of result.days) {
      const cell = document.createElement('div');
      cell.className = 'cheat-day-cell';
      if (d.isToday)  cell.classList.add('today');
      if (d.isCheat)  cell.classList.add('cheat');
      if (d.isFuture && !d.isToday) cell.classList.add('future');
      if (d.eaten != null && !d.isCheat) {
        if (d.eaten > d.target) cell.classList.add('over');
        else cell.classList.add('under');
      }
      const dow = document.createElement('div');
      dow.className = 'dow';
      dow.textContent = d.label;
      const val = document.createElement('div');
      val.className = 'val';
      val.textContent = d.eaten != null ? d.eaten.toLocaleString() : '—';
      const delta = document.createElement('div');
      delta.className = 'delta';
      if (d.isCheat) {
        delta.textContent = 'cheat';
      } else if (d.eaten != null) {
        const diff = d.eaten - d.target;
        delta.textContent = diff > 0 ? `+${diff}` : `${diff}`;
      } else if (d.target != null) {
        delta.textContent = `tgt ${d.target}`;
      }
      cell.appendChild(dow);
      cell.appendChild(val);
      cell.appendChild(delta);
      strip.appendChild(cell);
    }
  },

  async refreshCharts(profile, allLogs, healthRows, tdee) {
    const main = document.getElementById('app');
    const weightCanvas = main.querySelector('[data-role="weight-canvas"]');
    const caloriesCanvas = main.querySelector('[data-role="calories-canvas"]');
    if (!weightCanvas || !caloriesCanvas) return;

    const weightCount = allLogs.filter(l => l.weight_kg != null).length;
    const calCount = allLogs.filter(l => l.calories != null).length;

    main.querySelector('[data-role="weight-chart-meta"]').textContent =
      weightCount ? `${weightCount} weigh-in${weightCount === 1 ? '' : 's'}` : '';
    main.querySelector('[data-role="cal-chart-meta"]').textContent =
      calCount ? `${calCount} day${calCount === 1 ? '' : 's'} logged · TDEE ${tdee.best}` : '';

    const weightEmpty = main.querySelector('[data-role="weight-empty"]');
    const calEmpty = main.querySelector('[data-role="cal-empty"]');
    weightEmpty.classList.toggle('hidden', weightCount > 0);
    calEmpty.classList.toggle('hidden', calCount > 0);
    weightCanvas.parentElement.style.display = weightCount > 0 ? '' : 'none';
    caloriesCanvas.parentElement.style.display = calCount > 0 ? '' : 'none';

    try {
      if (weightCount > 0) await Charts.renderWeightChart(weightCanvas, allLogs, profile);
      if (calCount > 0)    await Charts.renderCaloriesChart(caloriesCanvas, allLogs, tdee.best);
    } catch (err) {
      console.error('Chart render failed:', err);
      toast('Could not load charts (CDN blocked?)', 'error');
    }

    this.renderSpikes(profile, allLogs, healthRows);
  },

  renderSpikes(profile, allLogs, healthRows) {
    const main = document.getElementById('app');
    const host = main.querySelector('[data-role="spikes"]');
    host.innerHTML = '';
    const spikes = Charts.detectSpikes(allLogs, healthRows, profile);
    if (spikes.length === 0) return;
    const unit = profile.weight_unit || 'kg';
    // Show the 3 most recent
    for (const s of spikes.slice(0, 3)) {
      const item = document.createElement('div');
      item.className = 'spike';
      const head = document.createElement('div');
      head.className = 'spike-head';
      const left = document.createElement('span');
      left.textContent = formatHumanDate(s.date);
      const right = document.createElement('span');
      right.className = 'spike-delta';
      const deltaDisplay = unit === 'lbs'
        ? `+${(s.delta_kg * 2.20462).toFixed(1)} lbs vs 7-day avg`
        : `+${s.delta_kg.toFixed(2)} kg vs 7-day avg`;
      right.textContent = deltaDisplay;
      head.appendChild(left);
      head.appendChild(right);
      const msg = document.createElement('div');
      msg.className = 'spike-msg';
      msg.textContent = s.message;
      item.appendChild(head);
      item.appendChild(msg);
      host.appendChild(item);
    }
  },

  openManualHealthModal() {
    const profileId = this.state.activeProfileId;
    if (!profileId) return;
    const node = document.getElementById('tpl-manual-health').content.cloneNode(true);
    const backdrop = node.querySelector('.modal-backdrop');
    const form = node.querySelector('#manual-health-form');
    const rowsHost = node.querySelector('[data-role="manual-rows"]');

    // Build 7 rows for Mon→Sun of the current week, prefilled if data exists
    const today = todayLocalISO();
    const week = CheatDay.mondayWeekRange(today);
    DB.listHealthDaily(profileId).then(existing => {
      const byDate = new Map(existing.map(h => [h.date, h]));
      // Header row
      const head = document.createElement('div');
      head.className = 'manual-row';
      const lbl1 = document.createElement('div'); lbl1.className = 'dow'; lbl1.textContent = 'Day';
      const lbl2 = document.createElement('div'); lbl2.className = 'field-label'; lbl2.textContent = 'Active cal';
      const lbl3 = document.createElement('div'); lbl3.className = 'field-label'; lbl3.textContent = 'Steps (opt)';
      head.appendChild(lbl1); head.appendChild(lbl2); head.appendChild(lbl3);
      rowsHost.appendChild(head);

      for (const date of week) {
        const row = document.createElement('div');
        row.className = 'manual-row';
        const dow = document.createElement('div');
        dow.className = 'dow';
        dow.textContent = formatHumanDate(date, { short: true });
        const aIn = document.createElement('input');
        aIn.type = 'number';
        aIn.placeholder = 'cal';
        aIn.inputMode = 'numeric';
        aIn.min = 0; aIn.step = 1;
        aIn.dataset.date = date;
        aIn.dataset.field = 'active_calories';
        const existing = byDate.get(date);
        if (existing?.active_calories != null) aIn.value = existing.active_calories;
        const sIn = document.createElement('input');
        sIn.type = 'number';
        sIn.placeholder = 'steps';
        sIn.inputMode = 'numeric';
        sIn.min = 0; sIn.step = 1;
        sIn.dataset.date = date;
        sIn.dataset.field = 'steps';
        if (existing?.steps != null) sIn.value = existing.steps;
        row.appendChild(dow);
        row.appendChild(aIn);
        row.appendChild(sIn);
        rowsHost.appendChild(row);
      }
    });

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    form.querySelector('[data-action="cancel"]').addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const inputs = form.querySelectorAll('input[type="number"]');
      const byDate = new Map();
      for (const inp of inputs) {
        if (!inp.value) continue;
        const date = inp.dataset.date;
        const field = inp.dataset.field;
        const val = parseInt(inp.value, 10);
        if (!Number.isFinite(val)) continue;
        if (!byDate.has(date)) byDate.set(date, { date });
        byDate.get(date)[field] = val;
      }
      const rows = Array.from(byDate.values());
      if (rows.length === 0) {
        toast('Nothing entered', 'error');
        return;
      }
      try {
        await HealthImport.manualHealthEntry(profileId, rows);
        close();
        await this.refreshDashboard();
        toast(`Saved ${rows.length} day${rows.length === 1 ? '' : 's'}`, 'success');
      } catch (err) {
        toast(err.message || 'Save failed', 'error');
      }
    });
    document.body.appendChild(node);
  },

  async refreshHealthCard(profileId, healthRows) {
    const main = document.getElementById('app');
    const meta = await DB.getSetting(`health_meta_${profileId}`);
    const statusEl = main.querySelector('[data-role="health-status"]');
    const daysEl = main.querySelector('[data-role="health-days"]');
    const avgEl = main.querySelector('[data-role="health-avg-active"]');
    const importEl = main.querySelector('[data-role="health-last-import"]');
    const rangeEl = main.querySelector('[data-role="health-range"]');
    const clearBtn = main.querySelector('[data-role="health-clear"]');

    const validActive = healthRows.filter(h => h.active_calories != null);
    if (!meta || validActive.length === 0) {
      statusEl.textContent = 'No data imported';
      daysEl.textContent = '—';
      avgEl.textContent = '—';
      importEl.textContent = '—';
      rangeEl.textContent = '';
      clearBtn.classList.add('hidden');
      return;
    }

    const recent7 = [...validActive].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 7);
    const avg = Math.round(recent7.reduce((s, r) => s + r.active_calories, 0) / recent7.length);

    statusEl.textContent = 'Imported';
    daysEl.textContent = `${validActive.length}`;
    avgEl.textContent = `${avg} cal`;

    const importedAt = new Date(meta.lastImportAt);
    const ago = humanAgo(importedAt);
    importEl.textContent = ago;
    importEl.title = importedAt.toLocaleString();

    rangeEl.textContent = `Covers ${formatHumanDate(meta.firstDate)} → ${formatHumanDate(meta.lastDate)} · ${meta.recordsKept?.toLocaleString() || '—'} records`;
    clearBtn.classList.remove('hidden');
  },

  renderTargets(main, tdee, targetKey) {
    main.querySelector('[data-role="maintenance"]').textContent = `${tdee.targets.maintenance}`;
    main.querySelector('[data-role="cut500"]').textContent = `${tdee.targets.cut500}`;
    main.querySelector('[data-role="cut1000"]').textContent = `${tdee.targets.cut1000}`;

    // Method badge
    const badge = main.querySelector('[data-role="method-badge"]');
    const labels = {
      static: 'Static',
      health: 'Apple Health',
      adaptive14: 'Adaptive · 14d',
      adaptive28: 'Adaptive · 28d',
    };
    badge.textContent = labels[tdee.bestKey] || tdee.bestKey;
    badge.classList.toggle('live', tdee.bestKey.startsWith('adaptive') || tdee.bestKey === 'health');

    // Explainer
    main.querySelector('[data-role="method-explainer"]').textContent = tdee.explainer;

    // Selected pick highlight + click handler (onclick replaces any prior handler)
    main.querySelectorAll('.target-pick').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.target === targetKey);
      btn.onclick = async () => {
        await DB.setSetting(`target_${this.state.activeProfileId}`, btn.dataset.target);
        await this.refreshDashboard();
      };
    });

    // Method breakdown row
    const breakdown = main.querySelector('[data-role="method-breakdown"]');
    breakdown.innerHTML = '';
    const order = [
      ['adaptive28', 'Adaptive 28d'],
      ['adaptive14', 'Adaptive 14d'],
      ['health', 'Apple Health'],
      ['static', 'Static'],
    ];
    for (const [key, label] of order) {
      const mode = tdee.modes[key];
      const row = document.createElement('div');
      row.className = 'method-row' + (key === tdee.bestKey ? ' active' : '') + (mode.available ? '' : ' unavailable');
      const labelEl = document.createElement('span');
      labelEl.className = 'm-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'm-value';
      valueEl.textContent = mode.available ? `${mode.tdee} cal` : '—';
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      if (!mode.available && mode.reason) {
        const reason = document.createElement('span');
        reason.className = 'm-reason';
        reason.textContent = mode.reason;
        row.appendChild(reason);
      }
      breakdown.appendChild(row);
    }
  },

  renderHistory(rows, profile) {
    const main = document.getElementById('app');
    const list = main.querySelector('[data-role="history-list"]');
    const countEl = main.querySelector('[data-role="history-count"]');
    const entries = rows.filter(r =>
      r.calories != null || r.carbs != null || r.weight_kg != null || (r.notes && r.notes.length)
    );
    countEl.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;

    list.innerHTML = '';
    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted small empty';
      p.textContent = 'No entries yet — log your first meal or weight above.';
      list.appendChild(p);
      return;
    }

    const unit = profile?.weight_unit || 'kg';
    for (const r of entries.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'history-row';

      const dateEl = document.createElement('div');
      dateEl.className = 'date';
      dateEl.textContent = formatHumanDate(r.date, { short: true });
      row.appendChild(dateEl);

      const details = document.createElement('div');
      details.className = 'details';

      if (r.calories != null) {
        details.appendChild(chip(`${r.calories} cal`));
      }
      if (r.carbs != null) {
        details.appendChild(chip(`${r.carbs}g carbs`));
      }
      if (r.weight_kg != null) {
        const w = unit === 'lbs' ? `${(r.weight_kg * 2.20462).toFixed(1)} lbs` : `${r.weight_kg.toFixed(1)} kg`;
        details.appendChild(chip(w, 'weight'));
      }
      if (r.notes) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = r.notes;
        details.appendChild(note);
      }
      row.appendChild(details);

      const del = document.createElement('button');
      del.className = 'delete';
      del.title = 'Delete entry';
      del.innerHTML = '&times;';
      del.addEventListener('click', () => {
        showConfirm({
          title: `Delete entry for ${formatHumanDate(r.date)}?`,
          body: 'Removes calories, carbs, weight, and notes for that day.',
          confirmLabel: 'Delete',
          onConfirm: async () => {
            await DB.deleteDailyLog(this.state.activeProfileId, r.date);
            await this.refreshDashboard();
            toast('Entry deleted', 'success');
          },
        });
      });
      row.appendChild(del);

      list.appendChild(row);
    }
  },
};

/* ============ helpers ============ */

function chip(text, variant = '') {
  const el = document.createElement('span');
  el.className = 'chip' + (variant ? ' ' + variant : '');
  el.textContent = text;
  return el;
}

function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function humanAgo(date) {
  const diffMs = Date.now() - date.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return date.toLocaleDateString();
}

function formatHumanDate(iso, { short = false } = {}) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = short
    ? { month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' };
  return dt.toLocaleDateString(undefined, opts);
}

function toast(message, variant = '') {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = 'toast' + (variant ? ' ' + variant : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 1800);
}

function showConfirm({ title, body, confirmLabel = 'Confirm', onConfirm }) {
  const node = document.getElementById('tpl-confirm').content.cloneNode(true);
  const backdrop = node.querySelector('.modal-backdrop');
  node.querySelector('[data-role="title"]').textContent = title;
  node.querySelector('[data-role="body"]').textContent = body;
  const confirmBtn = node.querySelector('[data-action="confirm"]');
  confirmBtn.textContent = confirmLabel;
  const close = () => backdrop.remove();
  node.querySelector('[data-action="cancel"]').addEventListener('click', close);
  confirmBtn.addEventListener('click', async () => {
    close();
    try { await onConfirm(); } catch (e) { toast(e.message || 'Failed', 'error'); }
  });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(node);
}

window.addEventListener('DOMContentLoaded', () => App.init());
