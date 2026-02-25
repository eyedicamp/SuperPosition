// =========================
// Time utilities
// =========================
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
// Score computation (for Top-K display only)
// (Backend도 동일한 스코어를 사용한다고 가정)
// score[s] = Σ w_p * a_{p,s} + prefBonus*Σ w_p*a_{p,s}*b_{p,s} - latePenaltyPerSlot*lateOverlap(s)
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
  return raw.replace(/\/+$/, ""); // trailing slash 제거
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
// UI state
// =========================
let state = {
  availability: null,
  prefStartOk: null,
  spd: null,
  totalSlots: null,
  weights: null,
  lastParams: null
};

function readParams() {
  const apiBase = getApiBase();

  const numPeople = Number(document.getElementById("numPeople").value);
  const slotMinutes = Number(document.getElementById("slotMinutes").value);

  const meetingMinutes = Number(document.getElementById("meetingMinutes").value);
  const prefWindowMinutes = Number(document.getElementById("prefWindowMinutes").value);

  const prefBonus = Number(document.getElementById("prefBonus").value);
  const latePenalty = Number(document.getElementById("latePenalty").value);

  const importantPeople = parseCSVIndices(document.getElementById("importantPeople").value);
  const importantWeight = Number(document.getElementById("importantWeight").value);

  const seed = Number(document.getElementById("seed").value);
  const topK = Number(document.getElementById("topK").value);

  return {
    apiBase,
    numPeople, slotMinutes, meetingMinutes, prefWindowMinutes,
    prefBonus, latePenalty, importantPeople, importantWeight,
    seed, topK
  };
}

function summarizeData(params) {
  const { numPeople, slotMinutes, meetingMinutes, prefWindowMinutes, importantPeople, importantWeight } = params;
  const spd = state.spd;

  const totalSlots = state.totalSlots;
  let freeRatioSum = 0;
  for (let p = 0; p < numPeople; p++) {
    let free = 0;
    for (let t = 0; t < totalSlots; t++) if (state.availability[p][t]) free++;
    freeRatioSum += free / totalSlots;
  }
  const avgFree = freeRatioSum / numPeople;

  const prefSamples = [];
  for (let p = 0; p < Math.min(numPeople, 6); p++) {
    const idx = state.prefStartOk[p].findIndex(v => v);
    prefSamples.push(`${p}: ${idx >= 0 ? formatDayTime(idx, spd, slotMinutes) : "-"}`);
  }

  return [
    `People: ${numPeople}`,
    `Slot minutes: ${slotMinutes}`,
    `Meeting length: ${meetingMinutes} min`,
    `Preferred window length: ${prefWindowMinutes} min`,
    `Important people: [${importantPeople.join(", ")}], important_weight=${importantWeight}`,
    `Avg free ratio (random data): ${(avgFree * 100).toFixed(1)}%`,
    `Preference start samples: ${prefSamples.join(" | ")}`
  ].join("\n");
}

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

function validateMinutesDivisible(minutes, slotMinutes, label) {
  if (minutes % slotMinutes !== 0) {
    throw new Error(`${label}(${minutes})는 슬롯(${slotMinutes})으로 나누어 떨어져야 합니다.`);
  }
}

// =========================
// Main: generate + optimize
// =========================
async function computeAndRender() {
  const params = readParams();
  if (!params.apiBase) {
    renderResult("백엔드 API Base URL이 비어있습니다.", false);
    return;
  }
  if (!state.availability || !state.prefStartOk) return;

  const spd = state.spd;
  const totalSlots = state.totalSlots;

  try {
    validateMinutesDivisible(params.meetingMinutes, params.slotMinutes, "모임 길이(분)");
    validateMinutesDivisible(params.prefWindowMinutes, params.slotMinutes, "선호 구간 길이(분)");
  } catch (e) {
    renderResult(String(e.message || e), false);
    return;
  }

  const meetingLenSlots = params.meetingMinutes / params.slotMinutes;
  const prefWindowSlots = params.prefWindowMinutes / params.slotMinutes;

  if (meetingLenSlots <= 0) {
    renderResult("meetingMinutes가 slotMinutes보다 작습니다.", false);
    return;
  }
  if (meetingLenSlots >= totalSlots) {
    renderResult("meeting length가 전체 주간 슬롯보다 큽니다.", false);
    return;
  }
  if (prefWindowSlots <= 0) {
    renderResult("prefWindowMinutes가 slotMinutes보다 작습니다.", false);
    return;
  }

  // weights
  const weights = Array(params.numPeople).fill(1.0);
  for (const p of params.importantPeople) {
    if (p >= 0 && p < params.numPeople) weights[p] = params.importantWeight;
  }
  state.weights = weights;

  // (Top-K 표시용) 로컬에서 동일 score 계산
  const { scores, counts, wAtt, wPref, lateOverlap } = computeScores({
    availability: state.availability,
    prefStartOk: state.prefStartOk,
    meetingLenSlots,
    spd,
    slotMinutes: params.slotMinutes,
    weights,
    prefBonus: params.prefBonus,
    latePenaltyPerSlot: params.latePenalty,
    lateHour: 20
  });

  // Backend payload (FastAPI SolveRequest와 동일 키로 구성)
  const payload = {
    num_people: params.numPeople,
    slot_minutes: params.slotMinutes,
    meeting_len_slots: meetingLenSlots,
    availability: state.availability,
    pref_start_ok: state.prefStartOk,
    weights: weights,
    pref_bonus: params.prefBonus,
    late_hour: 20,
    late_penalty_per_slot: params.latePenalty
  };

  renderResult("백엔드 계산 중...", true);

  let resp;
  try {
    resp = await callSolveAPI(params.apiBase, payload);
  } catch (e) {
    renderResult(`백엔드 호출 실패: ${String(e.message || e)}`, false);
    return;
  }

  const bestStart = resp.best_start;
  const bestEnd = resp.best_end;

  // attendees/prefHits는 백엔드 결과 사용
  const attendees = resp.attendees || [];
  const prefHits = resp.pref_hit_people || [];

  // local arrays 범위 체크 (혹시 응답이 범위 밖이면 방어)
  const localScore = (bestStart >= 0 && bestStart < scores.length) ? scores[bestStart] : null;
  const localCount = (bestStart >= 0 && bestStart < counts.length) ? counts[bestStart] : null;
  const localWAtt = (bestStart >= 0 && bestStart < wAtt.length) ? wAtt[bestStart] : null;
  const localWPref = (bestStart >= 0 && bestStart < wPref.length) ? wPref[bestStart] : null;
  const localLate = (bestStart >= 0 && bestStart < lateOverlap.length) ? lateOverlap[bestStart] : null;

  const resultText = [
    "===== Best Meeting Time (Backend) =====",
    `Start: ${formatDayTime(bestStart, spd, params.slotMinutes)}`,
    `End  : ${formatDayTime(bestEnd, spd, params.slotMinutes)}`,
    `Score (backend): ${Number(resp.score).toFixed(2)}`,
    localScore !== null ? `Score (local check): ${localScore.toFixed(2)}` : `Score (local check): -`,
    localCount !== null ? `Unweighted attendees: ${localCount}/${params.numPeople}` : `Unweighted attendees: -`,
    localWAtt !== null ? `Weighted attendance : ${localWAtt.toFixed(2)}` : `Weighted attendance : -`,
    localWPref !== null ? `Weighted pref hits  : ${localWPref.toFixed(2)} (people: [${prefHits.join(", ")}])` : `Weighted pref hits  : -`,
    localLate !== null ? `Late overlap slots  : ${localLate} (>=20:00)` : `Late overlap slots  : -`,
    `Attendees           : [${attendees.join(", ")}]`,
    resp.meta ? `Meta: ${JSON.stringify(resp.meta)}` : ""
  ].filter(line => line !== "").join("\n");

  renderResult(resultText, false);

  // TopK 후보 표시
  const idxs = scores.map((v, i) => ({ i, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, Math.max(3, params.topK));

  const topText = idxs.map((x, r) => {
    const s = x.i;
    const e = s + meetingLenSlots;
    return [
      `${String(r + 1).padStart(2, " ")}. ${formatDayTime(s, spd, params.slotMinutes)} ~ ${formatDayTime(e, spd, params.slotMinutes)}`,
      `    score=${scores[s].toFixed(2)}, attend=${counts[s]}/${params.numPeople}, w_att=${wAtt[s].toFixed(2)}, w_pref=${wPref[s].toFixed(2)}, late=${lateOverlap[s]}`
    ].join("\n");
  }).join("\n");

  renderTopCandidates(topText, false);
}

// =========================
// Buttons
// =========================
document.getElementById("btnGenerate").addEventListener("click", () => {
  const params = readParams();

  const gen = generateRandomAvailability({
    numPeople: params.numPeople,
    slotMinutes: params.slotMinutes,
    seed: params.seed
  });

  state.availability = gen.availability;
  state.spd = gen.spd;
  state.totalSlots = gen.totalSlots;

  const prefWindowSlots = Math.max(1, Math.floor(params.prefWindowMinutes / params.slotMinutes));
  state.prefStartOk = generateRandomPreferences({
    numPeople: params.numPeople,
    totalSlots: gen.totalSlots,
    spd: gen.spd,
    slotMinutes: params.slotMinutes,
    prefWindowSlots,
    seed: params.seed + 88
  });

  state.lastParams = params;

  document.getElementById("dataSummary").classList.remove("muted");
  document.getElementById("dataSummary").textContent = summarizeData(params);

  document.getElementById("btnOptimize").disabled = false;

  renderResult("데이터 생성 완료. “최적화 실행 (Backend)”을 눌러주세요.", true);
  renderTopCandidates("-", true);
});

document.getElementById("btnOptimize").addEventListener("click", async () => {
  renderTopCandidates("-", true);
  await computeAndRender();
});
