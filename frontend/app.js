// =========================
// Shared constants / storage
// =========================
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STORAGE_KEY = "sp_schedule_v1";

// =========================
// Time utilities
// =========================
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

function parseCSVIndices(s) {
  const t = (s || "").trim();
  if (!t) return [];
  return t.split(",")
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .map(x => Number(x))
    .filter(x => Number.isFinite(x) && x >= 0);
}

// =========================
// Simple RNG (seeded)
// =========================
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

// =========================
// Random availability + preferences
// - availability[p][t] = true/false
// - prefStartOk[p][t] = true/false  (start time t within preferred window)
// =========================
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

  // base availability true for 09:00~21:00 daily
  for (let d = 0; d < 7; d++) {
    const dayOffset = d * spd;
    const s = dayOffset + activeStartHour * slotsPerHour;
    const e = dayOffset + activeEndHour * slotsPerHour;
    for (let p = 0; p < numPeople; p++) {
      for (let t = s; t < e; t++) availability[p][t] = true;
    }
  }

  // insert random busy blocks per person per day
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

// =========================
// Score computation (Top-K display)
// =========================
function computeScores({
  availability,
  prefStartOk,
  meetingLenSlots,
  spd,
  slotMinutes,
  weights,
  prefBonus,
  lateHour = 20,
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

// =========================
// Backend API
// =========================
function getApiBase() {
  const raw = (document.getElementById("apiBase")?.value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
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

// =========================
// CSV parsing / generation
// Columns: slot_minutes,person_id,weight,day,time,available,pref
// day: Mon..Sun, time: HH:MM
// =========================
function parseCsvText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) throw new Error("CSV 내용이 비어있습니다.");

  const header = lines[0].split(",").map(s => s.trim());
  const required = ["slot_minutes", "person_id", "weight", "day", "time", "available", "pref"];
  for (const col of required) {
    if (!header.includes(col)) throw new Error(`CSV 헤더에 '${col}' 컬럼이 필요합니다.`);
  }

  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map(s => s.trim());
    if (parts.length !== header.length) continue; // 방어적으로 스킵
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

  if (rows.length === 0) throw new Error("CSV 데이터 행을 읽지 못했습니다.");
  return rows;
}

function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  return hh * 60 + mm;
}

function buildScheduleFromRows(rows) {
  const slotMinutes = rows[0].slot_minutes;
  if (!Number.isFinite(slotMinutes) || slotMinutes <= 0) throw new Error("slot_minutes가 올바르지 않습니다.");

  // unique persons
  const personSet = new Set(rows.map(r => r.person_id));
  const people = Array.from(personSet).sort((a, b) => a - b);
  const numPeople = people.length;

  const spd = slotsPerDay(slotMinutes);
  const totalSlots = 7 * spd;

  // maps person_id -> row index
  const pIndex = new Map(people.map((pid, i) => [pid, i]));

  const availability = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));
  const prefStartOk = Array.from({ length: numPeople }, () => Array(totalSlots).fill(false));
  const weights = Array(numPeople).fill(1.0);

  const dayIndex = new Map(DAYS.map((d, i) => [d, i]));

  for (const r of rows) {
    if (r.slot_minutes !== slotMinutes) throw new Error("CSV 내 slot_minutes 값이 섞여있습니다(단일 값이어야 함).");
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

    if (Number.isFinite(r.weight) && r.weight > 0) {
      weights[pi] = r.weight;
    }
  }

  return { slotMinutes, numPeople, spd, totalSlots, availability, prefStartOk, weights, people };
}

function scheduleToCsv({
  slotMinutes,
  people,
  weights,
  availability,
  prefStartOk
}) {
  const spd = slotsPerDay(slotMinutes);
  const header = "slot_minutes,person_id,weight,day,time,available,pref";
  const lines = [header];

  for (let pi = 0; pi < people.length; pi++) {
    const personId = people[pi];
    const w = weights[pi] ?? 1.0;

    for (let di = 0; di < 7; di++) {
      for (let within = 0; within < spd; within++) {
        const t = di * spd + within;
        const minutes = within * slotMinutes;
        const hh = Math.floor(minutes / 60);
        const mm = minutes % 60;
        const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        const a = availability[pi][t] ? 1 : 0;
        const p = prefStartOk[pi][t] ? 1 : 0;
        lines.push(`${slotMinutes},${personId},${w},${DAYS[di]},${time},${a},${p}`);
      }
    }
  }

  return lines.join("\n");
}

// =========================
// UI state + helpers
// =========================
let state = {
  slotMinutes: null,
  people: null,          // 실제 person_id 배열(업로드 대비)
  availability: null,
  prefStartOk: null,
  weightsBase: null,     // CSV 로드 시 weight(또는 1)
  spd: null,
  totalSlots: null,
};

function renderResult(text, muted = false) {
  const el = document.getElementById("result");
  el.textContent = text;
  el.classList.toggle("muted", muted);
}

function renderTopCandidates(text, muted = false) {
  const el = document.getElementById("topCandidates");
  el.textContent = text;
  el.classList.toggle("muted", muted);
}

function setDataSummary(text, muted = false) {
  const el = document.getElementById("dataSummary");
  el.textContent = text;
  el.classList.toggle("muted", muted);
}

function enableDataButtons(enabled) {
  document.getElementById("btnOptimize").disabled = !enabled;
  document.getElementById("btnViewTimetable").disabled = !enabled;
}

function validateMinutesDivisible(minutes, slotMinutes, label) {
  if (minutes % slotMinutes !== 0) {
    throw new Error(`${label}(${minutes})는 슬롯(${slotMinutes})으로 나누어 떨어져야 합니다.`);
  }
}

function getParams() {
  const apiBase = getApiBase();

  const numPeople = Number(document.getElementById("numPeople").value);
  const slotMinutes = Number(document.getElementById("slotMinutes").value);
  const seed = Number(document.getElementById("seed").value);

  const meetingMinutes = Number(document.getElementById("meetingMinutes").value);
  const prefWindowMinutes = Number(document.getElementById("prefWindowMinutes").value);

  const prefBonus = Number(document.getElementById("prefBonus").value);
  const latePenalty = Number(document.getElementById("latePenalty").value);

  const importantPeople = parseCSVIndices(document.getElementById("importantPeople").value);
  const importantWeight = Number(document.getElementById("importantWeight").value);

  const topK = Number(document.getElementById("topK").value);

  return {
    apiBase,
    numPeople,
    slotMinutes,
    seed,
    meetingMinutes,
    prefWindowMinutes,
    prefBonus,
    latePenalty,
    importantPeople,
    importantWeight,
    topK
  };
}

function summarizeSchedule() {
  const slotMinutes = state.slotMinutes;
  const spd = state.spd;
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
    `Slot minutes: ${slotMinutes}`,
    `Total slots (week): ${totalSlots} (= 7 * ${spd})`,
    `Avg availability ratio: ${(avgFree * 100).toFixed(1)}%`,
    `Preferred slots (total): ${prefCount}`
  ].join("\n");
}

function persistToLocalStorage(extra = {}) {
  const payload = {
    version: 1,
    saved_at: new Date().toISOString(),
    slotMinutes: state.slotMinutes,
    people: state.people,
    weights: extra.weights ?? state.weightsBase,
    availability: state.availability,
    prefStartOk: state.prefStartOk,
    ...extra,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

// =========================
// Main: Optimize (Backend) + TopK display
// =========================
async function optimizeBackend() {
  if (!state.availability) {
    renderResult("데이터가 없습니다. 랜덤 생성 또는 CSV 로드를 해주세요.", false);
    return;
  }

  const params = getParams();
  if (!params.apiBase) {
    renderResult("백엔드 API Base URL이 비어있습니다.", false);
    return;
  }

  try {
    validateMinutesDivisible(params.meetingMinutes, state.slotMinutes, "모임 길이(분)");
    validateMinutesDivisible(params.prefWindowMinutes, state.slotMinutes, "선호 구간 길이(분)");
  } catch (e) {
    renderResult(String(e.message || e), false);
    return;
  }

  const meetingLenSlots = params.meetingMinutes / state.slotMinutes;

  // weights: base + override(important)
  const weights = Array(state.people.length).fill(1.0);
  for (let i = 0; i < weights.length; i++) weights[i] = (state.weightsBase?.[i] ?? 1.0);

  for (const p of params.importantPeople) {
    // importantPeople는 "사람 인덱스" 기준(현재 UI는 0..N-1로 사용)
    if (p >= 0 && p < weights.length) weights[p] = params.importantWeight;
  }

  // Top-K(표시용 로컬 스코어)
  const { scores, counts, wAtt, wPref, lateOverlap } = computeScores({
    availability: state.availability,
    prefStartOk: state.prefStartOk,
    meetingLenSlots,
    spd: state.spd,
    slotMinutes: state.slotMinutes,
    weights,
    prefBonus: params.prefBonus,
    latePenaltyPerSlot: params.latePenalty,
    lateHour: 20
  });

  // Backend payload
  const payload = {
    num_people: state.people.length,
    slot_minutes: state.slotMinutes,
    meeting_len_slots: meetingLenSlots,
    availability: state.availability,
    pref_start_ok: state.prefStartOk,
    weights: weights,
    pref_bonus: params.prefBonus,
    late_hour: 20,
    late_penalty_per_slot: params.latePenalty
  };

  renderResult("계산 중...", true);
  renderTopCandidates("-", true);

  let resp;
  try {
    resp = await callSolveAPI(params.apiBase, payload);
  } catch (e) {
    renderResult(`백엔드 호출 실패: ${String(e.message || e)}`, false);
    return;
  }

  const bestStart = resp.best_start;
  const bestEnd = resp.best_end;

  const attendees = resp.attendees || [];
  const prefHits = resp.pref_hit_people || [];

  const resultText = [
    `Best Start: ${formatDayTime(bestStart, state.spd, state.slotMinutes)}`,
    `Best End  : ${formatDayTime(bestEnd, state.spd, state.slotMinutes)}`,
    `Score     : ${Number(resp.score).toFixed(2)}`,
    `Attendees : ${attendees.length}/${state.people.length}  [${attendees.join(", ")}]`,
    prefHits.length ? `Pref hits : [${prefHits.join(", ")}]` : `Pref hits : -`,
    resp.meta ? `Meta      : ${JSON.stringify(resp.meta)}` : ""
  ].filter(Boolean).join("\n");

  renderResult(resultText, false);

  // TopK 후보 표시
  const topK = Math.max(3, params.topK);
  const idxs = scores.map((v, i) => ({ i, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, topK);

  const topText = idxs.map((x, r) => {
    const s = x.i;
    const e = s + meetingLenSlots;
    return [
      `${String(r + 1).padStart(2, " ")}. ${formatDayTime(s, state.spd, state.slotMinutes)} ~ ${formatDayTime(e, state.spd, state.slotMinutes)}`,
      `    score=${scores[s].toFixed(2)}, attend=${counts[s]}/${state.people.length}, w_att=${wAtt[s].toFixed(2)}, w_pref=${wPref[s].toFixed(2)}, late=${lateOverlap[s]}`
    ].join("\n");
  }).join("\n");

  renderTopCandidates(topText, false);

  // 저장(시간표 페이지에서 사용 + 다운로드에 weights 반영)
  persistToLocalStorage({ weights });
}

// =========================
// Events
// =========================
document.getElementById("btnGenerate").addEventListener("click", () => {
  const params = getParams();

  // 랜덤 생성 시: person_id는 0..N-1
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

  renderResult("데이터 준비 완료. 최적화를 실행하세요.", true);
  renderTopCandidates("-", true);

  persistToLocalStorage();
});

document.getElementById("btnLoadCsv").addEventListener("click", async () => {
  const fileInput = document.getElementById("csvFile");
  const file = fileInput.files?.[0];
  if (!file) {
    renderResult("CSV 파일을 선택해주세요.", false);
    return;
  }

  const text = await file.text();
  try {
    const rows = parseCsvText(text);
    const built = buildScheduleFromRows(rows);

    // UI 반영
    document.getElementById("slotMinutes").value = String(built.slotMinutes);
    document.getElementById("numPeople").value = String(built.numPeople);

    state.slotMinutes = built.slotMinutes;
    state.spd = built.spd;
    state.totalSlots = built.totalSlots;
    state.people = built.people;                 // person_id 목록
    state.availability = built.availability;
    state.prefStartOk = built.prefStartOk;
    state.weightsBase = built.weights;

    setDataSummary(summarizeSchedule(), false);
    enableDataButtons(true);

    renderResult("CSV 로드 완료. 최적화를 실행하세요.", true);
    renderTopCandidates("-", true);

    persistToLocalStorage({ weights: built.weights });
  } catch (e) {
    renderResult(`CSV 로드 실패: ${String(e.message || e)}`, false);
  }
});

document.getElementById("btnOptimize").addEventListener("click", async () => {
  await optimizeBackend();
});

document.getElementById("btnViewTimetable").addEventListener("click", () => {
  if (!state.availability) return;
  persistToLocalStorage();
  window.location.href = "./timetable.html";
});

// 초기 상태
enableDataButtons(false);
setDataSummary("아직 데이터가 없습니다. 랜덤 생성 또는 CSV 로드를 해주세요.", true);
renderResult("아직 실행 전입니다.", true);
renderTopCandidates("-", true);
