from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional, Tuple

import dimod
from neal import SimulatedAnnealingSampler

# D-Wave
from dwave.system import DWaveSampler, EmbeddingComposite
from dwave.cloud.client import Client

app = FastAPI(title="Meeting Optimizer API", version="0.4.0")

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
    # core
    num_people: int
    slot_minutes: int
    meeting_len_slots: int
    availability: List[List[bool]]      # [P][T]
    pref_start_ok: List[List[bool]]     # [P][T]
    weights: List[float]
    pref_bonus: float = 0.7
    late_hour: int = 20
    late_penalty_per_slot: float = 3.0

    # solver selection
    solver_mode: str = "sa"             # "sa" or "qa"
    dwave_token: Optional[str] = None
    dwave_solver: Optional[str] = None  # solver name/id (optional)

class SolveResponse(BaseModel):
    best_start: int
    best_end: int
    score: float
    attendees: List[int]
    pref_hit_people: List[int]
    meta: Dict[str, Any] = {}

class DWaveSolversRequest(BaseModel):
    token: str

class DWaveSolversResponse(BaseModel):
    solvers: List[str]

@app.post("/dwave/solvers", response_model=DWaveSolversResponse)
def list_dwave_solvers(req: DWaveSolversRequest):
    token = (req.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="token is required")

    try:
        with Client(token=token) as client:
            solvers = client.get_solvers(qpu=True, online=True)
            names = [s.id for s in solvers]
        return DWaveSolversResponse(solvers=names)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to list solvers: {e}")

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

        # attendance + preference bonus
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
    Domain-wall encoding with z_0..z_{n-2} choosing k in {0..n-1}.
    Objective:
      Score(k) = score[0] + sum_j (score[j+1]-score[j]) z_j
      => minimize E_obj = -Score(k)
    Constraint (monotone, forbid 0->1):
      A * sum_j z_{j+1}(1-z_j) = A*sum_j (z_{j+1} - z_j z_{j+1})
    """
    n = len(scores)
    if n <= 1:
        return dimod.BinaryQuadraticModel({}, {}, 0.0, vartype=dimod.BINARY)

    linear: Dict[str, float] = {}
    quadratic: Dict[Tuple[str, str], float] = {}
    offset = -float(scores[0])

    # objective linear: -(score[j+1]-score[j]) * z_j
    for j in range(n - 1):
        delta = float(scores[j + 1] - scores[j])
        linear[f"z_{j}"] = linear.get(f"z_{j}", 0.0) - delta

    # constraint: A*z_{j+1} - A*z_j*z_{j+1}
    for j in range(n - 2):
        zj = f"z_{j}"
        zk = f"z_{j+1}"
        linear[zk] = linear.get(zk, 0.0) + float(A)
        quadratic[(zj, zk)] = quadratic.get((zj, zk), 0.0) - float(A)

    return dimod.BinaryQuadraticModel(linear, quadratic, offset, vartype=dimod.BINARY)

def _repair_and_decode_k(sample: Dict[str, int], n: int) -> int:
    if n <= 1:
        return 0
    z = []
    for i in range(n - 1):
        v = sample.get(f"z_{i}", 0)
        z.append(1 if int(v) == 1 else 0)

    # repair monotone: once 0 appears, all after become 0
    for i in range(1, n - 1):
        if z[i - 1] == 0:
            z[i] = 0

    k = sum(z)
    return max(0, min(n - 1, k))

def _pick_best_k_from_sampleset(sampleset, scores: List[float]) -> Tuple[int, float]:
    n = len(scores)
    best_k = 0
    best_score = scores[0]
    for datum in sampleset.data(fields=["sample"]):
        k = _repair_and_decode_k(datum.sample, n)
        sc = scores[k]
        if sc > best_score:
            best_score = sc
            best_k = k
    return best_k, best_score

def _solve_sa_neal(bqm: dimod.BinaryQuadraticModel, scores: List[float]) -> Dict[str, Any]:
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
    k, sc = _pick_best_k_from_sampleset(sampleset, scores)
    return {
        "k": k,
        "score": sc,
        "meta": {
            "solver": "python-neal-sa-domainwall",
            "num_reads": num_reads,
            "num_sweeps": num_sweeps,
            "beta_range": list(beta_range),
        }
    }

def _solve_qa_dwave(bqm: dimod.BinaryQuadraticModel, scores: List[float], token: str, solver_name: Optional[str]) -> Dict[str, Any]:
    token = (token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="dwave_token is required for solver_mode='qa'")

    # choose solver
    try:
        if solver_name and solver_name.strip():
            base = DWaveSampler(token=token, solver=solver_name.strip())
        else:
            # auto: pick an online QPU
            base = DWaveSampler(token=token, solver={"qpu": True, "online": True})
        sampler = EmbeddingComposite(base)

        num_reads = 100
        # annealing_time is optional; not all solvers accept custom times
        sampleset = sampler.sample(bqm, num_reads=num_reads)
        k, sc = _pick_best_k_from_sampleset(sampleset, scores)

        # solver info (safe)
        used_solver = getattr(base.solver, "id", None) if hasattr(base, "solver") else None

        return {
            "k": k,
            "score": sc,
            "meta": {
                "solver": "dwave-qpu-domainwall",
                "dwave_solver": used_solver or (solver_name.strip() if solver_name else "auto"),
                "num_reads": num_reads,
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"D-Wave sampling failed: {e}")

def solve_core(payload: SolveRequest) -> SolveResponse:
    scores = _compute_scores(payload)
    n = len(scores)
    if n == 0:
        return SolveResponse(
            best_start=0,
            best_end=int(payload.meeting_len_slots),
            score=0.0,
            attendees=[],
            pref_hit_people=[],
            meta={"solver": "none", "note": "no feasible start times"}
        )

    # penalty scale
    if n >= 2:
        deltas = [abs(scores[i + 1] - scores[i]) for i in range(n - 1)]
        max_delta = max(deltas) if deltas else 1.0
    else:
        max_delta = 1.0
    A = max(5.0, 5.0 * float(max_delta) + 1.0)

    bqm = _build_domain_wall_bqm(scores, A=A)

    mode = (payload.solver_mode or "sa").strip().lower()
    if mode not in ("sa", "qa"):
        raise HTTPException(status_code=400, detail="solver_mode must be 'sa' or 'qa'")

    if mode == "sa":
        out = _solve_sa_neal(bqm, scores)
    else:
        out = _solve_qa_dwave(bqm, scores, payload.dwave_token or "", payload.dwave_solver)

    best_start = int(out["k"])
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

    meta = dict(out["meta"])
    meta.update({"A": A, "mode": mode})

    return SolveResponse(
        best_start=best_start,
        best_end=best_end,
        score=float(out["score"]),
        attendees=attendees,
        pref_hit_people=pref_hits,
        meta=meta
    )

@app.post("/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    return solve_core(req)
