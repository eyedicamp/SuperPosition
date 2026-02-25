from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple

import dimod
from neal import SimulatedAnnealingSampler

app = FastAPI(title="Meeting Optimizer API", version="0.3.0")

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
    L = int(payload.meeting_len_slots)

    if P <= 0 or L <= 0:
        return []

    T = len(payload.availability[0])
    max_start = T - L
    if max_start <= 0:
        return []

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
                w = float(payload.weights[p])
                score += w
                if payload.pref_start_ok[p][s]:
                    score += float(payload.pref_bonus) * w

        # late penalty
        overlap = 0
        for t in range(s, s + L):
            if (t % slots_per_day) >= late_slot_in_day:
                overlap += 1
        score -= float(payload.late_penalty_per_slot) * overlap

        scores[s] = score

    return scores

def _build_domain_wall_bqm(scores: List[float], A: float) -> dimod.BinaryQuadraticModel:
    """
    Domain-wall encoding to choose an index k in {0..n-1} using z_0..z_{n-2}.
    Representation:
      - k = number of leading 1s (sum z_i) when monotone: 1...1 0...0
      - Constraint (monotone): forbid 0->1 transitions, i.e. z_i >= z_{i+1}
        penalty per i: A * z_{i+1} * (1 - z_i) = A*z_{i+1} - A*z_i*z_{i+1}

    Objective:
      maximize Score(k), where k is chosen index.
      Score(k) can be written as:
        Score = score[0] + sum_{j=0..n-2} (score[j+1] - score[j]) * z_j
      So minimizing energy E = -Score is:
        linear[z_j] += -(score[j+1]-score[j])
        offset += -score[0]
    """
    n = len(scores)
    if n <= 1:
        return dimod.BinaryQuadraticModel({}, {}, 0.0, vartype=dimod.BINARY)

    linear: Dict[str, float] = {}
    quadratic: Dict[Tuple[str, str], float] = {}
    offset = -float(scores[0])

    # objective linear terms
    for j in range(n - 1):
        delta = float(scores[j + 1] - scores[j])
        linear[f"z_{j}"] = linear.get(f"z_{j}", 0.0) - delta

    # monotone constraint penalties (chain couplers)
    # for i=0..n-3: A*z_{i+1} - A*z_i*z_{i+1}
    for i in range(n - 2):
        zi = f"z_{i}"
        zj = f"z_{i+1}"
        linear[zj] = linear.get(zj, 0.0) + float(A)
        quadratic[(zi, zj)] = quadratic.get((zi, zj), 0.0) - float(A)

    return dimod.BinaryQuadraticModel(linear, quadratic, offset, vartype=dimod.BINARY)

def _repair_and_decode_k(sample: Dict[str, int], n: int) -> int:
    """
    Read z_0..z_{n-2}, repair to monotone 1...10...0 by enforcing:
      z_{i} <= z_{i-1} for i>=1 (so no 0->1)
    Then decode k = sum z_i (k in [0..n-1]).
    """
    if n <= 1:
        return 0

    z = []
    for i in range(n - 1):
        v = sample.get(f"z_{i}", 0)
        z.append(1 if int(v) == 1 else 0)

    # repair: once 0 appears, everything after becomes 0
    for i in range(1, n - 1):
        if z[i - 1] == 0:
            z[i] = 0

    k = sum(z)
    if k < 0:
        k = 0
    if k > n - 1:
        k = n - 1
    return k

def solve_with_neal_sa(payload: SolveRequest) -> SolveResponse:
    scores = _compute_scores(payload)
    n = len(scores)

    if n == 0:
        return SolveResponse(
            best_start=0,
            best_end=int(payload.meeting_len_slots),
            score=0.0,
            attendees=[],
            pref_hit_people=[],
            meta={"solver": "python-neal-sa-domainwall", "note": "no feasible start times"}
        )

    # penalty scale based on score differences (keeps constraint strong but not blocking moves)
    if n >= 2:
        deltas = [abs(scores[i + 1] - scores[i]) for i in range(n - 1)]
        max_delta = max(deltas) if deltas else 1.0
    else:
        max_delta = 1.0

    A = max(5.0, 5.0 * float(max_delta) + 1.0)

    bqm = _build_domain_wall_bqm(scores, A=A)

    sampler = SimulatedAnnealingSampler()
    num_reads = 400
    num_sweeps = 6000
    beta_range = (0.01, 6.0)

    sampleset = sampler.sample(
        bqm,
        num_reads=num_reads,
        num_sweeps=num_sweeps,
        beta_range=beta_range
    )

    # pick best by decoded score (robust even if some samples violate monotonicity)
    best_k = 0
    best_score = scores[0]
    for datum in sampleset.data(fields=["sample"]):
        k = _repair_and_decode_k(datum.sample, n)
        sc = scores[k]
        if sc > best_score:
            best_score = sc
            best_k = k

    # safety: ensure we never return worse than true argmax(scores)
    exact_k = max(range(n), key=lambda i: scores[i])
    exact_score = scores[exact_k]
    used_exact_fallback = False
    if best_score < exact_score:
        best_k = exact_k
        best_score = exact_score
        used_exact_fallback = True

    best_start = best_k
    best_end = best_start + int(payload.meeting_len_slots)

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
        meta={
            "solver": "python-neal-sa-domainwall",
            "A": A,
            "num_reads": num_reads,
            "num_sweeps": num_sweeps,
            "beta_range": list(beta_range),
            "used_exact_fallback": used_exact_fallback,
        }
    )

@app.post("/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    return solve_with_neal_sa(req)
