from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any

import dimod
from neal import SimulatedAnnealingSampler

app = FastAPI(title="Meeting Optimizer API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def health():
    return {"status": "ok"}

class SolveRequest(BaseModel):
    num_people: int
    slot_minutes: int
    meeting_len_slots: int
    availability: List[List[bool]]      # [P][T]
    pref_start_ok: List[List[bool]]     # [P][T]
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

def _compute_scores(payload: SolveRequest) -> List[float]:
    P = payload.num_people
    T = len(payload.availability[0])
    L = payload.meeting_len_slots
    max_start = T - L

    slots_per_day = int(24 * 60 / payload.slot_minutes)
    late_slot_in_day = int(payload.late_hour * (60 / payload.slot_minutes))

    scores = [0.0] * max_start

    for s in range(max_start):
        score = 0.0

        # weighted attendance + preference bonus
        for p in range(P):
            ok = True
            for t in range(s, s + L):
                if not payload.availability[p][t]:
                    ok = False
                    break
            if ok:
                w = payload.weights[p]
                score += w
                if payload.pref_start_ok[p][s]:
                    score += payload.pref_bonus * w

        # late penalty
        overlap = 0
        for t in range(s, s + L):
            if (t % slots_per_day) >= late_slot_in_day:
                overlap += 1
        score -= payload.late_penalty_per_slot * overlap

        scores[s] = score

    return scores

def _build_onehot_bqm(scores: List[float], A: float) -> dimod.BinaryQuadraticModel:
    """
    Variables: y_s in {0,1}  (choose start time s)
    Energy to minimize:
        E = -sum_s scores[s]*y_s + A*(sum_s y_s - 1)^2
    """
    n = len(scores)
    linear = {}
    quadratic = {}
    offset = 0.0

    # Expand penalty:
    # A*(S-1)^2 = A*(-sum y_i + 2*sum_{i<j} y_i y_j + 1)
    # => linear add -A, quadratic add 2A, offset add A
    for i in range(n):
        linear[f"y_{i}"] = float(-scores[i] - A)

    for i in range(n):
        vi = f"y_{i}"
        for j in range(i + 1, n):
            vj = f"y_{j}"
            quadratic[(vi, vj)] = float(2.0 * A)

    offset += float(A)
    return dimod.BinaryQuadraticModel(linear, quadratic, offset, vartype=dimod.BINARY)

def _decode_best_start(sample: dict, scores: List[float]) -> int:
    chosen = [int(k.split("_")[1]) for k, v in sample.items() if v == 1 and k.startswith("y_")]
    if len(chosen) == 1:
        return chosen[0]
    # fallback if constraint violated
    return int(max(range(len(scores)), key=lambda i: scores[i]))

def solve_with_neal_sa(payload: SolveRequest) -> SolveResponse:
    scores = _compute_scores(payload)
    if not scores:
        return SolveResponse(
            best_start=0,
            best_end=payload.meeting_len_slots,
            score=0.0,
            attendees=[],
            pref_hit_people=[],
            meta={"solver": "python-neal-sa", "note": "no feasible start times"}
        )

    # Choose penalty A large enough so that one-hot constraint dominates
    smax = max(scores)
    smin = min(scores)
    scale = max(abs(smax), abs(smin), 1.0)
    A = max(50.0, 10.0 * scale + 10.0)

    bqm = _build_onehot_bqm(scores, A=A)

    sampler = SimulatedAnnealingSampler()
    num_reads = 200
    num_sweeps = 4000
    beta_range = (0.1, 4.0)

    sampleset = sampler.sample(
        bqm,
        num_reads=num_reads,
        num_sweeps=num_sweeps,
        beta_range=beta_range
    )

    best = sampleset.first
    best_start = _decode_best_start(best.sample, scores)
    best_end = best_start + payload.meeting_len_slots

    # attendees / pref hits
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
        score=float(scores[best_start]),
        attendees=attendees,
        pref_hit_people=pref_hits,
        meta={
            "solver": "python-neal-sa",
            "A": A,
            "num_reads": num_reads,
            "num_sweeps": num_sweeps,
            "beta_range": list(beta_range),
        }
    )

@app.post("/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    return solve_with_neal_sa(req)
