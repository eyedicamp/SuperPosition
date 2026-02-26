# Super Position

**Super Position**는 주간(월–일) 시간표에서 **회의 가능한 최적의 시간 구간**을 찾는 웹 앱입니다.  
프론트엔드(정적 페이지)에서 데이터를 생성/업로드하고, 백엔드(FastAPI)가 **Simulated Annealing(SA)** 또는 **Quantum Annealing(QA, D-Wave QPU)**로 최적 시작 시간을 계산합니다.

---

## Demo (GitHub Pages)

- 레포 루트의 `index.html`은 접속 시 `./frontend/`로 리다이렉트하도록 구성되어 있습니다.
- 프론트에서 “Backend API Base URL” 값을 백엔드 주소로 설정해 호출합니다(기본값 예시 포함).

---

## Features

- **랜덤 스케줄 생성**(사람 수/슬롯 크기/시드 기반)
- **CSV 업로드/다운로드**
  - 템플릿 CSV 다운로드
  - 로드한 스케줄을 타임테이블 페이지에서 시각화 및 CSV 재다운로드
- **최적화 실행**
  - Solver: **SA (neal)** / **QA (D-Wave QPU)**
  - Top-K 후보 목록 + 주간 그리드 시각화(랭크 오버랩 표시)
- **중요 인원 가중치**, 선호 구간 보너스, 늦은 시간 페널티 등 파라미터 제공

---

## Project Structure

```
.
├─ index.html              # /frontend로 리다이렉트
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

- 프론트 메인 UI: `frontend/index.html`  
- 타임테이블 UI: `frontend/timetable.html`  
- 리다이렉트: 루트 `index.html`

---

## Backend Dependencies

`backend/requirements.txt` 주요 의존성:

- `fastapi`, `uvicorn[standard]`, `pydantic`
- `dwave-neal`(SA), `dwave-system`(D-Wave 연동)

---

## API Contract (Frontend 기준)

프론트엔드는 아래 엔드포인트를 호출합니다.

### `POST /solve`

- Request payload 예시(프론트에서 전송):
  - `num_people`
  - `slot_minutes`
  - `meeting_len_slots`
  - `availability` (P x T boolean matrix)
  - `pref_start_ok` (P x T boolean matrix)
  - `weights` (length P)
  - `pref_bonus`
  - `late_hour`
  - `late_penalty_per_slot`
  - `solver_mode`: `"sa"` or `"qa"`
  - `dwave_token`, `dwave_solver` (QA일 때)

- Response에서 프론트가 사용하는 필드:
  - `best_start`, `best_end`, `score`
  - `attendees` (참석 가능한 사람 index 목록)
  - `pref_hit_people` (선호 시작 슬롯 만족한 사람 index 목록)
  - `meta` (옵션)

### `POST /dwave/solvers`

- QA 모드에서 토큰으로 사용 가능한 QPU 목록을 로드합니다.

---

## CSV Format

프론트가 사용하는 CSV 헤더/스키마:

```
slot_minutes,person_id,weight,day,time,available,pref
```

- `day`: `Mon,Tue,Wed,Thu,Fri,Sat,Sun`
- `time`: `HH:MM`
- `available`: 1(가능) / 0(불가)
- `pref`: 1(선호 시작 슬롯) / 0(아님)

---

## Optimization Objective (Frontend scoring)

프론트에서 Top-K 후보 표시/시각화를 위해 다음 형태의 스코어를 계산합니다.

- `score = weighted_attend + pref_bonus * weighted_pref - late_penalty_per_slot * late_overlap`
  - `weighted_attend`: 회의 구간 전체에 참석 가능한 사람들의 가중치 합
  - `weighted_pref`: “시작 슬롯이 선호(pref_start_ok)”인 사람들의 가중치 합
  - `late_overlap`: 회의 구간이 `late_hour` 이후 시간 슬롯과 겹치는 개수

(백엔드는 동일/유사한 목적함수로 최적 시작 슬롯을 반환하는 형태를 전제로 프론트가 동작합니다.)

---

## Run Locally

### 1) Backend

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

> `app:app`는 `backend/app.py`에 FastAPI 인스턴스 이름이 `app`인 구성을 가정합니다.

### 2) Frontend

정적 파일이라 로컬 서버로 띄우면 됩니다.

```bash
cd frontend
python -m http.server 5173
```

- 접속: `http://localhost:5173/`
- “Backend API Base URL”을 `http://localhost:8000`로 설정 후 실행

---

## Deploy Notes

- **Frontend**: GitHub Pages로 `/<repo>/` 접근 시 루트 `index.html`이 `./frontend/`로 리다이렉트되도록 되어 있습니다.
- **Backend**: Render/Fly.io/etc.에 FastAPI 배포 후, 프론트의 “Backend API Base URL”에 배포 URL을 입력하면 됩니다.

---

## UI Pages

- `/frontend/index.html`: 데이터 생성/업로드 + 최적화 + Top-K 시각화
- `/frontend/timetable.html`: 요일 탭 기반 개인별 시간표 시각화 + CSV 다운로드
