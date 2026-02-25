from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any

app = FastAPI(title="Meeting Optimizer API", version="0.1.0")

# ✅ CORS
# - allow_origins="*" 를 쓰려면 allow_credentials는 반드시 False여야 안전합니다.
# - 운영에서는 GitHub Pages 도메인으로 좁히는 것을 권장합니다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # 운영 시: ["https://<username>.github.io", "https://<username>.github.io/<repo>"] 로 변경 권장
    allow_credentials=False,      # ✅ 핵심: "*" 와 같이 쓰려면 False
    allow_methods=["*"],
    allow_headers=["*"],
)

# ✅ Render 헬스체크/접속 확인용
@app.get("/")
def health():
    return {"status": "ok"}

class SolveRequest(BaseModel):
    num_people: int
    slot_minutes: int
    meeting_len_slots: int
    availability: List[List[bool]]      # [P][T]
    pref_start_ok: List[List[bool]]     # [P][T] (시작시간이 선호 구간이면 True)
    weights: List[float]
    pref_bonus: float = 0.7
    late_hour: int = 20
    late_penalty_per_slot: float = 3.0

class SolveResponse(BaseModel):
    best_start: int
    best_end: int
    score: float
    attendees: List[int]
    pref_hit_people: List[int]
    meta: Dict[str, Any] = {}

def solve_with_simulated_annealing(payload: SolveRequest) -> SolveResponse:
    # 현재는 점수 최대(브루트포스)로 구현되어 있음
    # 나중에 neal(BQM) 또는 QA로 교체하려면 이 함수 내부만 바꾸면 됨
    T = len(payload.availability[0])
    max_start = T - payload.meeting_len_slots

    best_start = 0
    best_score = -1e18

    for s in range(max_start):
        score = 0.0

        # 참석 + 선호 보너스
        for p in range(payload.num_people):
            ok = True
            for t in range(s, s + payload.meeting_len_slots):
                if not payload.availability[p][t]:
                    ok = False
                    break
            if ok:
                score += payload.weights[p]
                if payload.pref_start_ok[p][s]:
                    score += payload.pref_bonus * payload.weights[p]

        # 늦은 시간 패널티
        slots_per_day = int(24 * 60 / payload.slot_minutes)
        late_slot_in_day = int(payload.late_hour * (60 / payload.slot_minutes))

        overlap = 0
        for t in range(s, s + payload.meeting_len_slots):
            if (t % slots_per_day) >= late_slot_in_day:
                overlap += 1

        score -= payload.late_penalty_per_slot * overlap

        if score > best_score:
            best_score = score
            best_start = s

    best_end = best_start + payload.meeting_len_slots

    attendees = []
    pref_hits = []
    for p in range(payload.num_people):
        ok = True
        for t in range(best_start, best_end):
            if not payload.availability[p][t]:
                ok = False
                break
        if ok:
            attendees.append(p)
            if payload.pref_start_ok[p][best_start]:
                pref_hits.append(p)

    return SolveResponse(
        best_start=best_start,
        best_end=best_end,
        score=float(best_score),
        attendees=attendees,
        pref_hit_people=pref_hits,
        meta={"solver": "python-sa-dummy"}
    )

@app.post("/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    return solve_with_simulated_annealing(req)
