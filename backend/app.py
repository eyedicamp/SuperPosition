from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

app = FastAPI()

# GitHub Pages에서 호출할 것이므로 CORS 허용 필요
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 운영에서는 GitHub Pages 도메인만 넣는 것을 권장
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SolveRequest(BaseModel):
    # 예시: 실제로는 당신이 만든 프론트 입력 스키마에 맞춰 확정
    num_people: int
    slot_minutes: int
    meeting_len_slots: int
    availability: List[List[bool]]          # [P][T]
    pref_start_ok: List[List[bool]]         # [P][T] (시작시간이 선호 구간이면 True)
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
    # TODO: 여기에 지금 Colab에서 만든 SA(또는 neal 기반 BQM)를 그대로 이식
    # 지금은 형태만 맞춘 더미 예시
    T = len(payload.availability[0])
    max_start = T - payload.meeting_len_slots
    best_start = 0
    best_score = -1e18

    # 여기만 나중에 QA로 쉽게 교체 가능하게 "solver" 함수로 분리해두는 게 핵심
    for s in range(max_start):
        # score 계산(간단 버전)
        score = 0.0
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

        # late penalty
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