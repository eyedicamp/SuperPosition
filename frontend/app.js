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
  return `${DAYS[day]} ${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
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
  return function() {
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

  // init all false
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
// Score computation
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
      // a_{p,s}: can attend all slots in window
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

    // lateOverlap(s): how many slots in meeting window are >= 20:00 (within each day)
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
// Simulated Annealing over discrete start index
// We maximize score, equivalently minimize E = -score
// =========================
function optimizeSA(scores, {
  seed = 123,
  steps = 12000,
  t0 = 2.0,
  tEnd = 0.02,
  neighborRadius = 24
} = {}) {
  const rng = mulberry32(seed);
  const n = scores.length;

  // start from a random state
  let x = randInt(rng, 0, n - 1);
  let bestX = x;
  let bestScore = scores[x];

  for (let i = 0; i < steps; i++) {
    // exponential cooling
    const frac = i / Math.max(1, steps - 1);
    const T = t0 * Math.pow(tEnd / t0, frac);

    // propose neighbor
    const delta = randInt(rng, -neighborRadius, neighborRadius);
    let y = x + delta;
    if (y < 0) y = 0;
    if (y >= n) y = n - 1;

    const sX = scores[x];
    const sY = scores[y];
    const dE = -(sY - sX); // E=-score => dE = E(y)-E(x)=-(sY-sX)

    // accept if better or with probability exp(-dE/T)
    if (dE <= 0) {
      x = y;
    } else {
      const prob = Math.exp(-dE / Math.max(1e-9, T));
      if (rng() < prob) x = y;
    }

    const sNow = scores[x];
    if (sNow > bestScore) {
      bestScore = sNow;
      bestX = x;
    }
  }

  return { bestStart: bestX, bestScore };
}

// =========================
// UI wiring
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
    numPeople, slotMinutes, meetingMinutes, prefWindowMinutes,
    prefBonus, latePenalty, importantPeople, importantWeight,
    seed, topK
  };
}

function summarizeData(params) {
  const { numPeople, slotMinutes, meetingMinutes, prefWindowMinutes, importantPeople, importantWeight } = params;
  const spd = state.spd;

  // rough stats: average free ratio per person
  const totalSlots = state.totalSlots;
  let freeRatioSum = 0;
  for (let p = 0; p < numPeople; p++) {
    let free = 0;
    for (let t = 0; t < totalSlots; t++) if (state.availability[p][t]) free++;
    freeRatioSum += free / totalSlots;
  }
  const avgFree = freeRatioSum / numPeople;

  // show preferred start sample
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
    `Avg free ratio (random data): ${(avgFree*100).toFixed(1)}%`,
    `Preference start samples: ${prefSamples.join(" | ")}`
  ].join("\n");
}

function computeAndRender() {
  const params = readParams();
  if (!state.availability || !state.prefStartOk) return;

  const spd = state.spd;
  const totalSlots = state.totalSlots;

  const meetingLenSlots = Math.floor(params.meetingMinutes / params.slotMinutes);
  const prefWindowSlots = Math.floor(params.prefWindowMinutes / params.slotMinutes);

  if (meetingLenSlots <= 0) {
    renderResult("meetingMinutes가 slotMinutes보다 작습니다.");
    return;
  }
  if (meetingLenSlots >= totalSlots) {
    renderResult("meeting length가 전체 주간 슬롯보다 큽니다.");
    return;
  }
  if (prefWindowSlots <= 0) {
    renderResult("prefWindowMinutes가 slotMinutes보다 작습니다.");
    return;
  }

  // weights
  const weights = Array(params.numPeople).fill(1.0);
  for (const p of params.importantPeople) {
    if (p >= 0 && p < params.numPeople) weights[p] = params.importantWeight;
  }
  state.weights = weights;

  const { scores, counts, wAtt, wPref, lateOverlap } = computeScores({
    availability: state.availability,
    prefStartOk: state.prefStartOk,
    meetingLenSlots,
    spd,
    slotMinutes: params.slotMinutes,
    weights,
    prefBonus: params.prefBonus,
    latePenaltyPerSlot: params.latePenalty
  });

  // SA
  const sa = optimizeSA(scores, {
    seed: params.seed + 1000,
    steps: 14000,
    t0: 2.0,
    tEnd: 0.02,
    neighborRadius: Math.max(6, Math.floor(spd / 4))
  });

  const bestStart = sa.bestStart;
  const bestEnd = bestStart + meetingLenSlots;

  // attendees + pref hits
  const attendees = [];
  const prefHits = [];
  for (let p = 0; p < params.numPeople; p++) {
    let ok = true;
    for (let t = bestStart; t < bestEnd; t++) {
      if (!state.availability[p][t]) { ok = false; break; }
    }
    if (ok) {
      attendees.push(p);
      if (state.prefStartOk[p][bestStart]) prefHits.push(p);
    }
  }

  const resultText = [
    "===== Best Meeting Time (SA) =====",
    `Start: ${formatDayTime(bestStart, spd, params.slotMinutes)}`,
    `End  : ${formatDayTime(bestEnd, spd, params.slotMinutes)}`,
    `Score: ${scores[bestStart].toFixed(2)}`,
    `Unweighted attendees: ${counts[bestStart]}/${params.numPeople}`,
    `Weighted attendance : ${wAtt[bestStart].toFixed(2)}`,
    `Weighted pref hits  : ${wPref[bestStart].toFixed(2)} (people: [${prefHits.join(", ")}])`,
    `Late overlap slots  : ${lateOverlap[bestStart]} (>=20:00)`,
    `Attendees           : [${attendees.join(", ")}]`
  ].join("\n");

  renderResult(resultText);

  // TopK
  const idxs = scores.map((v, i) => ({ i, v }))
    .sort((a,b) => b.v - a.v)
    .slice(0, Math.max(3, params.topK));

  const topText = idxs.map((x, r) => {
    const s = x.i;
    const e = s + meetingLenSlots;
    return [
      `${String(r+1).padStart(2," ")}. ${formatDayTime(s, spd, params.slotMinutes)} ~ ${formatDayTime(e, spd, params.slotMinutes)}`,
      `    score=${scores[s].toFixed(2)}, attend=${counts[s]}/${params.numPeople}, w_att=${wAtt[s].toFixed(2)}, w_pref=${wPref[s].toFixed(2)}, late=${lateOverlap[s]}`
    ].join("\n");
  }).join("\n");

  document.getElementById("topCandidates").textContent = topText;
}

function renderResult(text) {
  const el = document.getElementById("result");
  el.classList.remove("muted");
  el.textContent = text;
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

  document.getElementById("result").textContent = "데이터 생성 완료. “최적화 실행 (SA)”을 눌러주세요.";
  document.getElementById("result").classList.add("muted");
  document.getElementById("topCandidates").textContent = "-";
  document.getElementById("topCandidates").classList.add("muted");
});

document.getElementById("btnOptimize").addEventListener("click", () => {
  document.getElementById("topCandidates").classList.remove("muted");
  computeAndRender();
});