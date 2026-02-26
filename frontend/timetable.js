const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STORAGE_KEY = "sp_schedule_v1";

function slotsPerDay(slotMinutes) {
  return Math.floor(24 * 60 / slotMinutes);
}

function hhmm(minutes) {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object") return null;

  const slotMinutes = raw.slotMinutes ?? raw.slot_minutes;
  const availabilityRaw = raw.availability ?? raw.availability_matrix ?? raw.avail;
  const prefRaw = raw.prefStartOk ?? raw.pref_start_ok ?? raw.pref;
  const peopleRaw = raw.people;
  const weightsRaw = raw.weights;

  if (!slotMinutes || !availabilityRaw || !prefRaw) return null;

  const P = availabilityRaw.length;
  const T = availabilityRaw[0]?.length;
  if (!P || !T) return null;

  const people = Array.isArray(peopleRaw) ? peopleRaw.map(Number) : Array.from({ length: P }, (_, i) => i);
  const weights = Array.isArray(weightsRaw) ? weightsRaw.map(Number) : Array.from({ length: P }, () => 1.0);

  const availability = Array.from({ length: P }, (_, p) =>
    Array.from({ length: T }, (_, t) => !!availabilityRaw[p][t])
  );
  const prefStartOk = Array.from({ length: P }, (_, p) =>
    Array.from({ length: T }, (_, t) => !!prefRaw[p][t])
  );

  return {
    slotMinutes: Number(slotMinutes),
    people,
    weights,
    availability,
    prefStartOk,
  };
}

function loadSchedule() {
  const rawStr = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
  if (!rawStr) return null;
  try {
    const raw = JSON.parse(rawStr);
    return normalizeSchedule(raw);
  } catch {
    return null;
  }
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
        const time = hhmm(within * slotMinutes);
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

function renderTabs(container, onSelect) {
  container.innerHTML = "";
  DAYS.forEach((d, i) => {
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.textContent = d;
    btn.addEventListener("click", () => onSelect(i));
    container.appendChild(btn);
  });
}

function setActiveTab(container, idx) {
  const buttons = Array.from(container.querySelectorAll(".tab"));
  buttons.forEach((b, i) => b.classList.toggle("active", i === idx));
}

function renderGrid(gridWrap, sched, dayIdx) {
  const slotMinutes = sched.slotMinutes;
  const spd = slotsPerDay(slotMinutes);
  const cols = spd;

  const people = sched.people;
  const availability = sched.availability;
  const pref = sched.prefStartOk;
  const weights = sched.weights || [];

  const times = Array.from({ length: cols }, (_, k) => hhmm(k * slotMinutes));
  const colTemplate = `220px repeat(${cols}, 46px)`;

  gridWrap.innerHTML = "";

  const header = document.createElement("div");
  header.className = "gridrow header";
  header.style.gridTemplateColumns = colTemplate;

  const h0 = document.createElement("div");
  h0.className = "cell sticky headcell";
  h0.textContent = "Person";
  header.appendChild(h0);

  times.forEach(t => {
    const c = document.createElement("div");
    c.className = "cell headcell";
    c.textContent = t;
    header.appendChild(c);
  });
  gridWrap.appendChild(header);

  for (let pi = 0; pi < people.length; pi++) {
    const row = document.createElement("div");
    row.className = "gridrow";
    row.style.gridTemplateColumns = colTemplate;

    const label = document.createElement("div");
    label.className = "cell sticky personcell";
    const w = weights[pi] ?? 1.0;
    label.textContent = `#${pi} (id:${people[pi]})${w > 1 ? ` ★x${w}` : ""}`;
    row.appendChild(label);

    for (let within = 0; within < cols; within++) {
      const tGlobal = dayIdx * spd + within;

      const cell = document.createElement("div");
      cell.className = "cell slotcell";

      const isAvail = !!availability[pi][tGlobal];
      const isPref = !!pref[pi][tGlobal];

      if (!isAvail) cell.classList.add("busy");
      if (isPref) cell.classList.add("pref");

      row.appendChild(cell);
    }

    gridWrap.appendChild(row);
  }
}

// main
const sched = loadSchedule();

const btnBack = document.getElementById("btnBack");
btnBack.addEventListener("click", () => {
  window.location.href = "./";
});

const btnDownload = document.getElementById("btnDownload");
const dayTabs = document.getElementById("dayTabs");
const gridWrap = document.getElementById("gridWrap");
const emptyState = document.getElementById("emptyState");

if (!sched) {
  emptyState.style.display = "block";
  gridWrap.style.display = "none";
  btnDownload.disabled = true;
} else {
  emptyState.style.display = "none";
  gridWrap.style.display = "block";
  btnDownload.disabled = false;

  let currentDay = 0;
  renderTabs(dayTabs, (idx) => {
    currentDay = idx;
    setActiveTab(dayTabs, currentDay);
    renderGrid(gridWrap, sched, currentDay);
  });

  setActiveTab(dayTabs, currentDay);
  renderGrid(gridWrap, sched, currentDay);

  btnDownload.addEventListener("click", () => {
    const csv = scheduleToCsv({
      slotMinutes: sched.slotMinutes,
      people: sched.people,
      weights: sched.weights,
      availability: sched.availability,
      prefStartOk: sched.prefStartOk
    });
    downloadTextFile(`super_position_timetable_slot${sched.slotMinutes}.csv`, csv);
  });
}
