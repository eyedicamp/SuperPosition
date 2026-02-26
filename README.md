<p align="center">
  <img src="assets/superposition-preview.png" alt="Super Position — screenshot" width="900" />
</p>

<h1 align="center">🍟 Super Position</h1>

<p align="center">
  <b>Quantum Annealing-based Meeting Scheduler</b><br/>
  Find the best meeting time across a weekly timetable using <b>SA</b> / <b>QA (D‑Wave)</b>.
</p>

<p align="center">
  🌐 <b>Live Demo</b>: https://eyedicamp.github.io/SuperPosition/frontend/
</p>

---

## ✨ What it does

- 🗓️ Build / upload a weekly timetable (Mon–Sun)
- 🧩 Set meeting length + preference window
- ⚖️ Add attendee weights (important people matter more)
- 🚀 Run optimization:
  - 🧊 **SA** (Simulated Annealing, `dwave-neal`)
  - ⚛️ **QA** (Quantum Annealing on D‑Wave QPU)
- 🥇 Get the best start time + Top‑K candidates with a visual timetable overlay

---

## 🧱 Project Structure

```
.
├─ index.html              # redirects to /frontend
├─ backend/
│  ├─ app.py
│  ├─ Dockerfile
│  └─ requirements.txt
└─ frontend/
   ├─ index.html
   ├─ app.js
   ├─ styles.css
   ├─ timetable.html
   └─ timetable.js
```

- 🎛️ Main UI: `frontend/index.html`
- 🧾 Timetable viewer: `frontend/timetable.html`
- ↪️ Redirect: root `index.html`

---

## 📦 Backend Dependencies

`backend/requirements.txt` includes (high-level):

- ⚡ `fastapi`, `uvicorn[standard]`, `pydantic`
- 🧊 `dwave-neal` (SA)
- ⚛️ `dwave-system` (QA / D‑Wave)

---

## 🔌 API (as used by the frontend)

### `POST /solve`

Frontend sends fields like:

- `num_people`
- `slot_minutes`
- `meeting_len_slots`
- `availability` (P × T boolean matrix)
- `pref_start_ok` (P × T boolean matrix)
- `weights` (length P)
- `pref_bonus`
- `late_hour`
- `late_penalty_per_slot`
- `solver_mode`: `"sa"` or `"qa"`
- `dwave_token`, `dwave_solver` (QA only)

Response fields expected by the frontend:

- `best_start`, `best_end`, `score`
- `attendees` (indices who can attend the whole meeting)
- `pref_hit_people` (indices whose preference-start is satisfied)
- `meta` (optional)

### `POST /dwave/solvers`

- QA mode: lists available solvers for a given D‑Wave token.

---

## 🧾 CSV Format

Header:

```
slot_minutes,person_id,weight,day,time,available,pref
```

- `day`: `Mon,Tue,Wed,Thu,Fri,Sat,Sun`
- `time`: `HH:MM`
- `available`: 1 / 0
- `pref`: 1 / 0 (preference start-slot hint)

---

## 🧠 Scoring (frontend view)

For Top‑K visualization, the frontend evaluates candidates with a score shaped like:

- `score = weighted_attend + pref_bonus * weighted_pref - late_penalty_per_slot * late_overlap`

Where:

- ✅ `weighted_attend`: sum of weights of people who can attend
- ⭐ `weighted_pref`: sum of weights whose preferred start is satisfied
- 🌙 `late_overlap`: number of meeting slots after `late_hour`

---

## 🚀 Run Locally

### 1) Backend (FastAPI)

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

> Assumes the FastAPI instance in `backend/app.py` is named `app`.

### 2) Frontend (static)

```bash
cd frontend
python -m http.server 5173
```

- Open: `http://localhost:5173/`
- Set “Backend API Base URL” to `http://localhost:8000`

---

## 🌈 Deploy Notes

- 🧁 **Frontend**: GitHub Pages (root redirects → `/frontend`)
- 🛠️ **Backend**: Render / Fly.io / any FastAPI hosting
- 🔗 In the UI, set “Backend API Base URL” to your deployed backend URL

---

## 🖼️ Screenshot setup (IMPORTANT)

To make the screenshot render on GitHub:

1. Create a folder `assets/` at the repo root
2. Add the image as:
   - `assets/superposition-preview.png`
3. Commit & push

✅ Then the top image in this README will display automatically.

---

## 📜 License

Add a license if you plan to share/extend this project publicly.
