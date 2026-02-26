const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STORAGE_KEY = "sp_schedule_v1";
const UI_KEY = "sp_ui_v1"; // store solverMode etc.

function slotsPerDay(slotMinutes) {
  return Math.floor(24 * 60 / slotMinutes);
}

function formatDayTime(idx, spd, slotMinutes) {
  const day = Math.floor(idx / spd);
  const within = idx % spd;
  const minutes = within * slotMinutes;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${DAYS[day]} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function hhmmFromWithin(within, slotMinutes) {
  const minutes = within * slotMinutes;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseCSVIndices(s) {
  const t = (s || "").trim();
  if (!t) return [];
  return t.split(",")
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .map(x => Number(x))
    .filter(x => Number.isFinite(x) && x >= 0);
}

// RNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, lo, hiInclusive) {
  return lo + Math.floor(rng() * (hiInclusive - lo + 1));
}

// Random schedule
function generateRandomAvailability({
  numPeople,
  slotMinutes,
  activeStartHour = 9,
  activeEndHour = 21,
  extraBusyBlocksPerDayMin = 0,
  extraBusyBlocksPerDayMax = 3,
  busyBlockLenSlotsMin = 1,
  busyBlockLenSlotsMax = 4,
  seed = 11
}) {
  const rng = mulberry32(seed);
  const spd = slotsPerDay(slotMinutes);
  const totalSlots = 7 * spd;
  const slotsPerHour = Math.floor(60 / slotMinutes);

  const availability = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));

  for (let d = 0; d < 7; d++) {
    const dayOffset = d * spd;
    const s = dayOffset + activeStartHour * slotsPerHour;
    const e = dayOffset + activeEndHour * slotsPerHour;
    for (let p = 0; p < numPeople; p++) {
      for (let t = s; t < e; t++) availability[p][t] = true;
    }
  }

  for (let p = 0; p < numPeople; p++) {
    for (let d = 0; d < 7; d++) {
      const dayOffset = d * spd;
      const s = dayOffset + activeStartHour * slotsPerHour;
      const e = dayOffset + activeEndHour * slotsPerHour;

      const nBlocks = randInt(rng, extraBusyBlocksPerDayMin, extraBusyBlocksPerDayMax);
      for (let k = 0; k < nBlocks; k++) {
        const blockLen = randInt(rng, busyBlockLenSlotsMin, busyBlockLenSlotsMax);
        const latestStart = e - blockLen;
        if (latestStart <= s) continue;
        const blockStart = randInt(rng, s, latestStart);
        for (let t = blockStart; t < blockStart + blockLen; t++) availability[p][t] = false;
      }
    }
  }

  return { availability, spd, totalSlots };
}

function generateRandomPreferences({
  numPeople,
  totalSlots,
  spd,
  slotMinutes,
  prefWindowSlots = 4,
  activeStartHour = 9,
  activeEndHour = 21,
  seed = 99
}) {
  const rng = mulberry32(seed);
  const slotsPerHour = Math.floor(60 / slotMinutes);
  const prefStartOk = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));

  for (let p = 0; p < numPeople; p++) {
    const d = randInt(rng, 0, 6);
    const dayOffset = d * spd;

    const sMin = dayOffset + activeStartHour * slotsPerHour;
    const sMax = dayOffset + activeEndHour * slotsPerHour - prefWindowSlots;
    const s0 = (sMax <= sMin) ? sMin : randInt(rng, sMin, sMax);

    for (let t = s0; t < s0 + prefWindowSlots; t++) prefStartOk[p][t] = true;
  }
  return prefStartOk;
}

// Score for TopK display
function computeScores({
  availability,
  prefStartOk,
  meetingLenSlots,
  spd,
  slotMinutes,
  weights,
  prefBonus,
  lateHour,
  latePenaltyPerSlot
}) {
  const numPeople = availability.length;
  const totalSlots = availability[0].length;
  const maxStart = totalSlots - meetingLenSlots;

  const scores = Array(maxStart).fill(0);
  const counts = Array(maxStart).fill(0);
  const wAtt = Array(maxStart).fill(0);
  const wPref = Array(maxStart).fill(0);
  const lateOverlap = Array(maxStart).fill(0);

  const slotsPerHour = Math.floor(60 / slotMinutes);
  const lateSlotInDay = lateHour * slotsPerHour;

  for (let s = 0; s < maxStart; s++) {
    let count = 0;
    let weightedAttend = 0;
    let weightedPref = 0;

    for (let p = 0; p < numPeople; p++) {
      let ok = true;
      for (let t = s; t < s + meetingLenSlots; t++) {
        if (!availability[p][t]) { ok = false; break; }
      }
      if (ok) {
        count += 1;
        weightedAttend += weights[p];
        if (prefStartOk[p][s]) weightedPref += weights[p];
      }
    }

    let overlap = 0;
    for (let t = s; t < s + meetingLenSlots; t++) {
      const tod = t % spd;
      if (tod >= lateSlotInDay) overlap += 1;
    }

    counts[s] = count;
    wAtt[s] = weightedAttend;
    wPref[s] = weightedPref;
    lateOverlap[s] = overlap;

    scores[s] = weightedAttend + prefBonus * weightedPref - latePenaltyPerSlot * overlap;
  }

  return { scores, counts, wAtt, wPref, lateOverlap };
}

// Backend
function getApiBase() {
  const raw = (document.getElementById("apiBase")?.value || "").trim();
  return raw ? raw.replace(/\/+$/, "") : "";
}
async function callSolveAPI(apiBase, payload) {
  const res = await fetch(`${apiBase}/solve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return await res.json();
}

// CSV (upload/download)
function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  return hh * 60 + mm;
}
function parseCsvText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) throw new Error("CSV is empty.");

  const header = lines[0].split(",").map(s => s.trim());
  const required = ["slot_minutes", "person_id", "weight", "day", "time", "available", "pref"];
  for (const col of required) {
    if (!header.includes(col)) throw new Error(`Missing column in header: '${col}'.`);
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map(s => s.trim());
    if (parts.length !== header.length) continue;
    rows.push({
      slot_minutes: Number(parts[idx.slot_minutes]),
      person_id: Number(parts[idx.person_id]),
      weight: Number(parts[idx.weight]),
      day: parts[idx.day],
      time: parts[idx.time],
      available: Number(parts[idx.available]),
      pref: Number(parts[idx.pref]),
    });
  }
  if (rows.length === 0) throw new Error("No data rows parsed.");
  return rows;
}
function buildScheduleFromRows(rows) {
  const slotMinutes = rows[0].slot_minutes;
  if (!Number.isFinite(slotMinutes) || slotMinutes <= 0) throw new Error("Invalid slot_minutes.");

  const personSet = new Set(rows.map(r => r.person_id));
  const people = Array.from(personSet).sort((a, b) => a - b);
  const numPeople = people.length;

  const spd = slotsPerDay(slotMinutes);
  const totalSlots = 7 * spd;

  const pIndex = new Map(people.map((pid, i) => [pid, i]));
  const availability = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));
  const prefStartOk = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));
  const weights = Array(numPeople).fill(1.0);

  const dayIndex = new Map(DAYS.map((d, i) => [d, i]));

  for (const r of rows) {
    if (r.slot_minutes !== slotMinutes) throw new Error("slot_minutes must be a single value (not mixed).");
    if (!dayIndex.has(r.day)) continue;
    const di = dayIndex.get(r.day);

    const mins = hhmmToMinutes(r.time);
    if (mins === null) continue;

    const within = Math.floor(mins / slotMinutes);
    if (within < 0 || within >= spd) continue;

    const t = di * spd + within;
    const pi = pIndex.get(r.person_id);
    if (pi === undefined) continue;

    availability[pi][t] = (r.available === 1);
    prefStartOk[pi][t] = (r.pref === 1);

    if (Number.isFinite(r.weight) && r.weight > 0) weights[pi] = r.weight;
  }

  return { slotMinutes, numPeople, spd, totalSlots, availability, prefStartOk, weights, people };
}
function scheduleToCsv({ slotMinutes, people, weights, availability, prefStartOk }) {
  const spd = slotsPerDay(slotMinutes);
  const header = "slot_minutes,person_id,weight,day,time,available,pref";
  const lines = [header];

  for (let pi = 0; pi < people.length; pi++) {
    const personId = people[pi];
    const w = weights?.[pi] ?? 1.0;

    for (let di = 0; di < 7; di++) {
      for (let within = 0; within < spd; within++) {
        const t = di * spd + within;
        const time = hhmmFromWithin(within, slotMinutes);
        const a = availability[pi][t] ? 1 : 0;
        const p = prefStartOk[pi][t] ? 1 : 0;
        lines.push(`${slotMinutes},${personId},${w},${DAYS[di]},${time},${a},${p}`);
      }
    }
  }
  return lines.join("\n");
}
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// UI helpers
function renderResult(text, muted = false) {
  const el = document.getElementById("result");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("muted", muted);
}
function renderTopCandidates(text, muted = false) {
  const el = document.getElementById("topCandidates");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("muted", muted);
}
function setDataSummary(text, muted = false) {
  const el = document.getElementById("dataSummary");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("muted", muted);
}
function enableDataButtons(enabled) {
  const opt = document.getElementById("btnOptimize");
  const tt = document.getElementById("btnViewTimetable");
  if (opt) opt.disabled = !enabled;
  if (tt) tt.disabled = !enabled;
}
function setVizLegend(text, muted = false) {
  const el = document.getElementById("vizLegend");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("muted", muted);
}
function clearAndAppendViz(node, muted = false) {
  const wrap = document.getElementById("topViz");
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.appendChild(node);
  wrap.classList.toggle("muted", muted);
}

// Validation + params
function validateMinutesDivisible(minutes, slotMinutes, label) {
  if (minutes % slotMinutes !== 0) throw new Error(`${label} (${minutes}) must be divisible by slot size (${slotMinutes}).`);
}

function loadUIState() {
  const raw = localStorage.getItem(UI_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function saveUIState(patch) {
  const cur = loadUIState();
  const next = { ...cur, ...patch };
  localStorage.setItem(UI_KEY, JSON.stringify(next));
}

function getParams() {
  const ui = loadUIState();
  return {
    apiBase: getApiBase(),
    numPeople: Number(document.getElementById("numPeople").value),
    slotMinutes: Number(document.getElementById("slotMinutes").value),
    seed: Number(document.getElementById("seed").value),
    meetingMinutes: Number(document.getElementById("meetingMinutes").value),
    prefWindowMinutes: Number(document.getElementById("prefWindowMinutes").value),
    prefBonus: Number(document.getElementById("prefBonus").value),
    lateHour: Number(document.getElementById("lateHour").value),
    latePenalty: Number(document.getElementById("latePenalty").value),
    importantPeople: parseCSVIndices(document.getElementById("importantPeople").value),
    importantWeight: Number(document.getElementById("importantWeight").value),
    topK: Number(document.getElementById("topK").value),

    solverMode: (document.getElementById("solverMode")?.value || ui.solverMode || "sa"),
    dwaveToken: (document.getElementById("dwaveToken")?.value || ""),
    dwaveSolver: (document.getElementById("dwaveSolver")?.value || ""),
  };
}

// State
let state = {
  slotMinutes: null,
  people: null,
  availability: null,
  prefStartOk: null,
  weightsBase: null,
  spd: null,
  totalSlots: null,
};

function summarizeSchedule() {
  const totalSlots = state.totalSlots;
  const numPeople = state.people.length;

  let freeRatioSum = 0;
  for (let p = 0; p < numPeople; p++) {
    let free = 0;
    for (let t = 0; t < totalSlots; t++) if (state.availability[p][t]) free++;
    freeRatioSum += free / totalSlots;
  }
  const avgFree = freeRatioSum / numPeople;

  let prefCount = 0;
  for (let p = 0; p < numPeople; p++) {
    for (let t = 0; t < totalSlots; t++) if (state.prefStartOk[p][t]) prefCount++;
  }

  return [
    `People: ${numPeople}`,
    `Slot minutes: ${state.slotMinutes}`,
    `Total slots (week): ${totalSlots} (= 7 * ${state.spd})`,
    `Avg availability ratio: ${(avgFree * 100).toFixed(1)}%`,
    `Preferred slots (total): ${prefCount}`
  ].join("\n");
}

function persistSchedule(extra = {}) {
  const payload = {
    version: 1,
    saved_at: new Date().toISOString(),
    slotMinutes: state.slotMinutes,
    people: state.people,
    weights: extra.weights ?? state.weightsBase,
    availability: state.availability,
    prefStartOk: state.prefStartOk,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadPersistedSchedule() {
  const raw = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function restoreFromPersistedSchedule(sched) {
  state.slotMinutes = sched.slotMinutes;
  state.people = sched.people;
  state.availability = sched.availability;
  state.prefStartOk = sched.prefStartOk;
  state.weightsBase = sched.weights || Array(sched.people.length).fill(1.0);
  state.spd = slotsPerDay(sched.slotMinutes);
  state.totalSlots = 7 * state.spd;

  const slotEl = document.getElementById("slotMinutes");
  const numEl = document.getElementById("numPeople");
  if (slotEl) slotEl.value = String(state.slotMinutes);
  if (numEl) numEl.value = String(state.people.length);

  setDataSummary(summarizeSchedule(), false);
  enableDataButtons(true);

  renderResult("A saved schedule was loaded. You can view the timetable or run optimization.", true);
  renderTopCandidates("-", true);

  setVizLegend("Run optimization to display the Top-K meeting windows on a weekly grid (Mon–Sun × time slots).", true);
  const ph = document.createElement("div");
  ph.className = "mono muted";
  ph.textContent = "-";
  clearAndAppendViz(ph, true);
}

/* ===== Top-K Visualization (DOM renderer) ===== */
function buildTopKMatrix(idxs, meetingLenSlots, spd) {
  const matrix = Array.from({ length: spd }, () => Array.from({ length: 7 }, () => []));
  idxs.forEach((x, r) => {
    const rank = r + 1;
    const start = x.i;
    const end = start + meetingLenSlots;
    for (let t = start; t < end; t++) {
      const day = Math.floor(t / spd);
      const within = t % spd;
      if (day >= 0 && day < 7 && within >= 0 && within < spd) {
        matrix[within][day].push(rank);
      }
    }
  });
  for (let within = 0; within < spd; within++) {
    for (let day = 0; day < 7; day++) {
      matrix[within][day].sort((a, b) => a - b);
    }
  }
  return matrix;
}

function rankToAlpha(rank, K) {
  const strength = (K - (rank - 1)) / K;
  return 0.12 + 0.70 * strength;
}

function buildVizGridDOM(idxs, meetingLenSlots, slotMinutes, spd) {
  const K = idxs.length;
  const matrix = buildTopKMatrix(idxs, meetingLenSlots, spd);

  const grid = document.createElement("div");
  grid.className = "viz-grid";
  grid.style.gridTemplateColumns = "130px repeat(7, 1fr)";

  const hTime = document.createElement("div");
  hTime.className = "viz-cell viz-head viz-time";
  hTime.textContent = "Time";
  grid.appendChild(hTime);

  for (let d = 0; d < 7; d++) {
    const h = document.createElement("div");
    h.className = "viz-cell viz-head";
    h.textContent = DAYS[d];
    grid.appendChild(h);
  }

  for (let within = 0; within < spd; within++) {
    const timeCell = document.createElement("div");
    timeCell.className = "viz-cell viz-time";
    timeCell.textContent = hhmmFromWithin(within, slotMinutes);
    grid.appendChild(timeCell);

    for (let d = 0; d < 7; d++) {
      const cell = document.createElement("div");
      cell.className = "viz-cell";
      const ranks = matrix[within][d];

      if (ranks.length > 0) {
        const best = ranks[0];
        const alpha = rankToAlpha(best, K);
        cell.textContent = String(best);
        cell.title = `Ranks: ${ranks.join(", ")} (best=${best})`;
        cell.style.background = `rgba(255,191,26,${alpha.toFixed(3)})`;
        cell.style.fontWeight = "900";
        cell.style.color = "rgba(27,27,31,.9)";
      }
      grid.appendChild(cell);
    }
  }

  return grid;
}

// Solver UI toggle (class-based)
function toggleDwaveUI() {
  const mode = document.getElementById("solverMode")?.value || "sa";
  const tokenLabel = document.getElementById("dwaveTokenLabel");
  const solverLabel = document.getElementById("dwaveSolverLabel");
  const show = (mode === "qa");

  if (tokenLabel) tokenLabel.classList.toggle("hidden", !show);
  if (solverLabel) solverLabel.classList.toggle("hidden", !show);

  saveUIState({ solverMode: mode });
}

// Load solver list
async function fetchDwaveSolvers(apiBase, token) {
  const res = await fetch(`${apiBase}/dwave/solvers`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ token })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load solvers (${res.status}): ${text}`);
  }
  return await res.json(); // {solvers:[...]}
}

// Optimize backend
async function optimizeBackend() {
  if (!state.availability) {
    renderResult("No data. Generate random data or load a CSV first.", false);
    return;
  }

  const params = getParams();
  if (!params.apiBase) {
    renderResult("Backend API Base URL is empty.", false);
    return;
  }

  if (!Number.isFinite(params.lateHour) || params.lateHour < 0 || params.lateHour > 23) {
    renderResult("Late cutoff hour must be between 0 and 23.", false);
    return;
  }

  if (params.solverMode === "qa" && !params.dwaveToken) {
    renderResult("Quantum Annealing selected, but D-Wave API Token is empty.", false);
    return;
  }

  try {
    validateMinutesDivisible(params.meetingMinutes, state.slotMinutes, "Meeting length (minutes)");
    validateMinutesDivisible(params.prefWindowMinutes, state.slotMinutes, "Preference window length (minutes)");
  } catch (e) {
    renderResult(String(e.message || e), false);
    return;
  }

  const meetingLenSlots = params.meetingMinutes / state.slotMinutes;

  const weights = Array(state.people.length).fill(1.0);
  for (let i = 0; i < weights.length; i++) weights[i] = (state.weightsBase?.[i] ?? 1.0);
  for (const p of params.importantPeople) {
    if (p >= 0 && p < weights.length) weights[p] = params.importantWeight;
  }

  const { scores, counts, wAtt, wPref, lateOverlap } = computeScores({
    availability: state.availability,
    prefStartOk: state.prefStartOk,
    meetingLenSlots,
    spd: state.spd,
    slotMinutes: state.slotMinutes,
    weights,
    prefBonus: params.prefBonus,
    lateHour: params.lateHour,
    latePenaltyPerSlot: params.latePenalty
  });

  const payload = {
    num_people: state.people.length,
    slot_minutes: state.slotMinutes,
    meeting_len_slots: meetingLenSlots,
    availability: state.availability,
    pref_start_ok: state.prefStartOk,
    weights: weights,
    pref_bonus: params.prefBonus,
    late_hour: params.lateHour,
    late_penalty_per_slot: params.latePenalty,

    solver_mode: params.solverMode,
    dwave_token: params.solverMode === "qa" ? params.dwaveToken : null,
    dwave_solver: params.solverMode === "qa" ? (params.dwaveSolver || null) : null
  };

  renderResult(`Running... (solver_mode=${params.solverMode})`, true);
  renderTopCandidates("-", true);
  setVizLegend("Running optimization…", true);

  const ph = document.createElement("div");
  ph.className = "mono muted";
  ph.textContent = "-";
  clearAndAppendViz(ph, true);

  let resp;
  try {
    resp = await callSolveAPI(params.apiBase, payload);
  } catch (e) {
    renderResult(`Backend request failed: ${String(e.message || e)}`, false);
    setVizLegend("Optimization failed.", false);
    return;
  }

  const bestStart = resp.best_start;
  const bestEnd = resp.best_end;
  const attendees = resp.attendees || [];
  const prefHits = resp.pref_hit_people || [];

  renderResult(
    [
      `Best Start : ${formatDayTime(bestStart, state.spd, state.slotMinutes)}`,
      `Best End   : ${formatDayTime(bestEnd, state.spd, state.slotMinutes)}`,
      `Score      : ${Number(resp.score).toFixed(2)}`,
      `Attendees  : ${attendees.length}/${state.people.length}  [${attendees.join(", ")}]`,
      prefHits.length ? `Pref hits  : [${prefHits.join(", ")}]` : `Pref hits  : -`,
      resp.meta ? `Meta       : ${JSON.stringify(resp.meta)}` : ""
    ].filter(Boolean).join("\n"),
    false
  );

  const topK = Math.max(3, params.topK);
  const idxs = scores.map((v, i) => ({ i, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, topK);

  renderTopCandidates(
    idxs.map((x, r) => {
      const s = x.i;
      const e = s + meetingLenSlots;
      return [
        `${String(r + 1).padStart(2, " ")}. ${formatDayTime(s, state.spd, state.slotMinutes)} ~ ${formatDayTime(e, state.spd, state.slotMinutes)}`,
        `    score=${scores[s].toFixed(2)}, attend=${counts[s]}/${state.people.length}, w_att=${wAtt[s].toFixed(2)}, w_pref=${wPref[s].toFixed(2)}, late=${lateOverlap[s]}`
      ].join("\n");
    }).join("\n"),
    false
  );

  try {
    setVizLegend(
      "Numbers indicate the best (lowest) rank covering that slot. Hover a cell to see all overlapping ranks.",
      false
    );
    const grid = buildVizGridDOM(idxs, meetingLenSlots, state.slotMinutes, state.spd);
    clearAndAppendViz(grid, false);
  } catch (err) {
    setVizLegend("Top-K visualization failed (see below).", false);
    const box = document.createElement("pre");
    box.className = "mono";
    box.textContent = String(err?.stack || err?.message || err);
    clearAndAppendViz(box, false);
  }

  persistSchedule({ weights });
}

// CSV template download
function buildTemplateSchedule(numPeople, slotMinutes) {
  const spd = slotsPerDay(slotMinutes);
  const totalSlots = 7 * spd;
  const slotsPerHour = Math.floor(60 / slotMinutes);

  const availability = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));
  const prefStartOk = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));
  const people = Array.from({ length: numPeople }, (_, i) => i);
  const weights = Array(numPeople).fill(1.0);

  const startHour = 9;
  const endHour = 21;
  for (let d = 0; d < 7; d++) {
    const dayOffset = d * spd;
    const s = dayOffset + startHour * slotsPerHour;
    const e = dayOffset + endHour * slotsPerHour;
    for (let p = 0; p < numPeople; p++) {
      for (let t = s; t < e; t++) availability[p][t] = true;
    }
  }

  return { people, weights, availability, prefStartOk };
}

// Wire events
document.getElementById("btnGenerate").addEventListener("click", () => {
  const params = getParams();

  const gen = generateRandomAvailability({
    numPeople: params.numPeople,
    slotMinutes: params.slotMinutes,
    seed: params.seed
  });

  const prefWindowSlots = Math.max(1, Math.floor(params.prefWindowMinutes / params.slotMinutes));
  const prefStartOk = generateRandomPreferences({
    numPeople: params.numPeople,
    totalSlots: gen.totalSlots,
    spd: gen.spd,
    slotMinutes: params.slotMinutes,
    prefWindowSlots,
    seed: params.seed + 88
  });

  state.slotMinutes = params.slotMinutes;
  state.spd = gen.spd;
  state.totalSlots = gen.totalSlots;
  state.people = Array.from({ length: params.numPeople }, (_, i) => i);
  state.availability = gen.availability;
  state.prefStartOk = prefStartOk;
  state.weightsBase = Array(params.numPeople).fill(1.0);

  setDataSummary(summarizeSchedule(), false);
  enableDataButtons(true);

  renderResult("Random schedule generated. You can view the timetable or run optimization.", true);
  renderTopCandidates("-", true);
  setVizLegend("Run optimization to display the Top-K meeting windows on a weekly grid (Mon–Sun × time slots).", true);

  const ph = document.createElement("div");
  ph.className = "mono muted";
  ph.textContent = "-";
  clearAndAppendViz(ph, true);

  persistSchedule();
});

document.getElementById("btnLoadCsv").addEventListener("click", async () => {
  const file = document.getElementById("csvFile").files?.[0];
  if (!file) {
    renderResult("Please choose a CSV file first.", false);
    return;
  }

  try {
    const text = await file.text();
    const rows = parseCsvText(text);
    const built = buildScheduleFromRows(rows);

    document.getElementById("slotMinutes").value = String(built.slotMinutes);
    document.getElementById("numPeople").value = String(built.numPeople);

    state.slotMinutes = built.slotMinutes;
    state.spd = built.spd;
    state.totalSlots = built.totalSlots;
    state.people = built.people;
    state.availability = built.availability;
    state.prefStartOk = built.prefStartOk;
    state.weightsBase = built.weights;

    setDataSummary(summarizeSchedule(), false);
    enableDataButtons(true);

    renderResult("CSV loaded. You can view the timetable or run optimization.", true);
    renderTopCandidates("-", true);
    setVizLegend("Run optimization to display the Top-K meeting windows on a weekly grid (Mon–Sun × time slots).", true);

    const ph = document.createElement("div");
    ph.className = "mono muted";
    ph.textContent = "-";
    clearAndAppendViz(ph, true);

    persistSchedule({ weights: built.weights });
  } catch (e) {
    renderResult(`CSV load failed: ${String(e.message || e)}`, false);
  }
});

document.getElementById("btnOptimize").addEventListener("click", async () => {
  await optimizeBackend();
});

document.getElementById("btnViewTimetable").addEventListener("click", () => {
  if (!state.availability) return;
  persistSchedule();
  window.location.href = "./timetable.html";
});

document.getElementById("btnDownloadCsvTemplate").addEventListener("click", () => {
  const params = getParams();
  const tpl = buildTemplateSchedule(params.numPeople, params.slotMinutes);

  const csv = scheduleToCsv({
    slotMinutes: params.slotMinutes,
    people: tpl.people,
    weights: tpl.weights,
    availability: tpl.availability,
    prefStartOk: tpl.prefStartOk
  });

  downloadTextFile(`super_position_csv_template_${params.numPeople}p_${params.slotMinutes}m.csv`, csv);
});

// solver UI events
document.getElementById("solverMode")?.addEventListener("change", toggleDwaveUI);

document.getElementById("btnLoadSolvers")?.addEventListener("click", async () => {
  try {
    const params = getParams();
    if (!params.apiBase) throw new Error("Backend API Base URL is empty.");
    if (!params.dwaveToken) throw new Error("Please paste your D-Wave token first.");

    const out = await fetchDwaveSolvers(params.apiBase, params.dwaveToken);
    const sel = document.getElementById("dwaveSolver");
    if (!sel) return;

    sel.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Auto (any online QPU)";
    sel.appendChild(opt0);

    (out.solvers || []).forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  } catch (e) {
    alert(String(e.message || e));
  }
});

// init
enableDataButtons(false);
setDataSummary("No data yet. Generate random data or load a CSV.", true);
renderResult("Not run yet.", true);
renderTopCandidates("-", true);
setVizLegend("Run optimization to display the Top-K meeting windows on a weekly grid (Mon–Sun × time slots).", true);

const ph = document.createElement("div");
ph.className = "mono muted";
ph.textContent = "-";
clearAndAppendViz(ph, true);

// restore saved schedule
const saved = loadPersistedSchedule();
if (saved && saved.availability && saved.prefStartOk && saved.people && saved.slotMinutes) {
  restoreFromPersistedSchedule(saved);
}

// restore solverMode selection + apply toggle
{
  const ui = loadUIState();
  if (ui.solverMode) {
    const sel = document.getElementById("solverMode");
    if (sel) sel.value = ui.solverMode;
  }
  toggleDwaveUI();
}
