"""MediCore HE-02 AI service.

A small FastAPI service that exposes the trained models, the CP-SAT optimizer
and the what-if simulator over HTTP. It is deliberately *not* the public API:

    React dashboards  →  Node/Express backend  →  this service
                          (auth, PostgreSQL,
                           sockets, approvals)

The Node backend owns authentication, the database, the approval workflow and
the Socket.IO event stream; it reads the live hospital state from PostgreSQL and
posts a snapshot here. This service never touches the database and never applies
an allocation — it predicts, detects, optimises and explains, and hands the
result back for human review.

Run it with:

    python -m ai.service.app            # or: npm run ai  (from backend/)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ai import config
from ai.inference import base, feature_builder
from ai.inference import demand_service, equipment_service, flow_service, pressure_service, resource_service, staff_service, surge_service
from ai.optimization import hospital_optimizer
from ai.recommendations import build_recommendations, build_resource_findings, summarise
from ai.registry import model_registry
from ai.simulation import surge_simulator

SERVICE_NAME = "MediCore HE-02 AI service"
SERVICE_VERSION = "1.0.0"


# --------------------------------------------------------------------- models
class SnapshotRequest(BaseModel):
    """A snapshot of live hospital state, produced by the Node backend."""

    snapshot: dict[str, Any] = Field(default_factory=dict, description="live hospital state from PostgreSQL")
    persist_history: bool = Field(True, description="record the snapshot so rolling features have history")
    explain: bool = Field(True, description="include per-feature contributions")


class OptimizationRequest(BaseModel):
    patients: list[dict[str, Any]] = Field(default_factory=list)
    resources: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)


class SimulationRequest(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)
    patientCount: int = Field(20, ge=1, le=200)
    scenario: str = "MASS_CASUALTY_INTAKE"
    steps: int = Field(8, ge=1, le=96)
    priorityMix: dict[str, float] | None = None
    resources: dict[str, Any] = Field(default_factory=dict)
    queuePatients: list[dict[str, Any]] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)


class AdvisoryRequest(BaseModel):
    """Everything the command centre needs in one call."""

    snapshot: dict[str, Any] = Field(default_factory=dict)
    patients: list[dict[str, Any]] = Field(default_factory=list)
    resources: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    includeSimulation: bool = False
    surgePatientCount: int = 20


app = FastAPI(
    title=SERVICE_NAME,
    version=SERVICE_VERSION,
    description=(
        "Operational decision support for MediCore: demand, resource, pressure, workload, equipment and "
        "patient-flow forecasting, operational anomaly detection, multi-resource optimization (OR-Tools CP-SAT) "
        "and what-if surge simulation.\n\n"
        f"{config.DISCLAIMER}"
    ),
)

_allowed = [origin.strip() for origin in (os.environ.get("AI_ALLOWED_ORIGINS") or "").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    # The service is called server-to-server by the Node backend. Browsers are
    # only allowed in if explicit origins are configured.
    allow_origins=_allowed or ["http://localhost:4000", "http://127.0.0.1:4000"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:  # noqa: ARG001
    """Never leak a stack trace; always answer in the backend's error envelope."""
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": {
                "code": "AI_SERVICE_ERROR",
                "message": "The AI service could not complete this request. The hospital system continues to run on its operational fallbacks.",
                "detail": str(exc)[:300],
            },
        },
    )


def _ok(data: dict) -> dict:
    return {"success": True, "data": data}


# --------------------------------------------------------------------- health
@app.get("/api/ai/health")
def health() -> dict:
    """Model and optimizer health. Fallback status is always stated explicitly."""
    models = base.model_health()
    optimizer_ok = True
    optimizer_detail = "Google OR-Tools CP-SAT available"
    try:
        from ortools.sat.python import cp_model  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        optimizer_ok = False
        optimizer_detail = f"CP-SAT unavailable — optimization requests are refused, not faked ({exc})"

    return _ok(
        {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "status": "ok" if models["summary"]["healthy"] else "degraded",
            "models": {
                name: entry["status"]
                for name, entry in models["models"].items()
            },
            "model_detail": models["models"],
            "models_summary": models["summary"],
            "optimizer": "healthy" if optimizer_ok else "unavailable",
            "optimizer_detail": optimizer_detail,
            "simulator": "healthy",
            "last_model_update": models["last_model_update"],
            "last_prediction": models["last_prediction"],
            "predictions_served": models["predictions_served"],
            "feature_version": config.FEATURE_VERSION,
            "dataset_version": config.DATASET_VERSION,
            "synthetic_training_data": True,
            "synthetic_warning": models["synthetic_warning"],
            "history": {
                "snapshots_recorded": len(feature_builder.load_history()),
                "window_hours": feature_builder.history_window_hours(),
                "note": "rolling features use this recorded history; a cold start falls back to the snapshot's own totals",
            },
            "disclaimer": config.DISCLAIMER,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


@app.get("/api/ai/models")
def models() -> dict:
    """The model registry: versions, algorithms, metrics, dataset and status."""
    payload = model_registry.summary()
    registry = model_registry.all_models()
    return _ok(
        {
            **payload,
            "model_version": config.MODEL_VERSION,
            "feature_version": config.FEATURE_VERSION,
            "dataset_version": config.DATASET_VERSION,
            "synthetic_training_data": True,
            "synthetic_warning": (
                "All models were trained on a labelled SYNTHETIC hospital-operations dataset generated by "
                "ai/data/synthetic_generator.py. No real hospital dataset was available to this project. "
                "Metrics are honest held-out scores on that synthetic data and should be re-validated before any "
                "clinical-adjacent deployment."
            ),
            "versioning_policy": (
                "A newly trained model is registered as 'candidate'. It is promoted to 'active' only when it clears "
                "the quality gates, and the previous active version is retained as 'superseded' rather than deleted."
            ),
            "training_history_available": {name: len(entry["versions"]) for name, entry in registry["models"].items()},
        }
    )


@app.post("/api/ai/maintenance/reload")
def reload_models() -> dict:
    """Drop cached artifacts so a freshly promoted model is used immediately."""
    base.clear_cache()
    return _ok({"reloaded": True, "at": datetime.now(timezone.utc).isoformat()})


# ---------------------------------------------------------------- inference
@app.post("/api/ai/demand/forecast")
def demand_forecast(request: SnapshotRequest) -> dict:
    return _ok(demand_service.forecast(request.snapshot, explain=request.explain, persist_history=request.persist_history))


@app.post("/api/ai/resources/forecast")
def resource_forecast(request: SnapshotRequest) -> dict:
    return _ok(resource_service.forecast(request.snapshot, explain=request.explain, persist_history=request.persist_history))


@app.post("/api/ai/surge/detect")
def surge_detect(request: SnapshotRequest) -> dict:
    return _ok(surge_service.detect(request.snapshot, persist_history=request.persist_history))


@app.post("/api/ai/pressure/predict")
def pressure_predict(request: SnapshotRequest) -> dict:
    return _ok(pressure_service.predict(request.snapshot, persist_history=request.persist_history))


@app.post("/api/ai/doctor-workload/predict")
def doctor_workload(request: SnapshotRequest) -> dict:
    return _ok(staff_service.predict_workload(request.snapshot, role="doctors", explain=request.explain))


@app.post("/api/ai/nurse-workload/predict")
def nurse_workload(request: SnapshotRequest) -> dict:
    return _ok(staff_service.predict_workload(request.snapshot, role="nurses", explain=request.explain))


@app.post("/api/ai/equipment-demand/predict")
def equipment_demand(request: SnapshotRequest) -> dict:
    return _ok(equipment_service.predict_demand(request.snapshot, explain=request.explain))


@app.post("/api/ai/patient-flow/predict")
def patient_flow(request: SnapshotRequest) -> dict:
    return _ok(flow_service.forecast(request.snapshot, explain=request.explain))


# --------------------------------------------------------------- optimization
@app.post("/api/ai/optimize")
def optimize(request: OptimizationRequest) -> dict:
    """CP-SAT multi-resource plan. Always returns a recommendation for review."""
    plan = hospital_optimizer.optimise(request.model_dump())
    return _ok(plan)


@app.post("/api/ai/simulate")
def simulate(request: SimulationRequest) -> dict:
    """What-if surge simulation: before → after surge → after optimization."""
    return _ok(surge_simulator.run(request.model_dump()))


# ------------------------------------------------------------- advisory bundle
@app.post("/api/ai/advisory")
def advisory(request: AdvisoryRequest) -> dict:
    """One call that produces everything the command centre shows.

    Order matters and is preserved here: predict → detect → find → optimise →
    explain → hand over for human approval.
    """
    payload = request.model_dump()
    snapshot = payload["snapshot"]

    demand = demand_service.forecast(snapshot, explain=True, persist_history=True)
    resources = resource_service.forecast(snapshot, explain=False, persist_history=False)
    detection = surge_service.detect(snapshot, persist_history=False)
    pressure = pressure_service.predict(snapshot, persist_history=False, include_forecast=False)
    doctors = staff_service.predict_workload(snapshot, role="doctors")
    nurses = staff_service.predict_workload(snapshot, role="nurses")
    equipment = equipment_service.predict_demand(snapshot)
    flow = flow_service.forecast(snapshot)

    simulation = None
    if payload["includeSimulation"]:
        simulation = surge_simulator.run(
            {
                "state": _simulation_state(snapshot, pressure, demand),
                "patientCount": payload["surgePatientCount"],
                "resources": payload["resources"],
                "queuePatients": payload["patients"],
                "config": payload["config"],
            }
        )

    optimization = hospital_optimizer.optimise(
        {"patients": payload["patients"], "resources": payload["resources"], "config": payload["config"]}
    )

    findings = build_resource_findings(
        resource_pressure=resources,
        equipment_demand=equipment,
        staff_workload={"summary": {**doctors["summary"], "projectedOverLimit": doctors["summary"]["projectedOverLimit"] + nurses["summary"]["projectedOverLimit"]},
                        "staff": doctors["staff"]},
        surge=simulation,
    )
    recommendations = build_recommendations(
        optimization=optimization, findings=findings, demand=demand, surge=simulation
    )
    summary = summarise(
        pressure=pressure, demand=demand, surge_detection=detection, findings=findings, optimization=optimization
    )

    return _ok(
        {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "predictions": {
                "demand": demand,
                "resources": resources,
                "surgeDetection": detection,
                "pressure": pressure,
                "doctorWorkload": doctors,
                "nurseWorkload": nurses,
                "equipmentDemand": equipment,
                "patientFlow": flow,
            },
            "findings": findings,
            "optimization": optimization,
            "recommendations": recommendations,
            "summary": summary,
            "simulation": simulation,
            "requiresHumanApproval": True,
            "decisionSupportOnly": True,
            "wording": {
                "values": "projected / expected / estimated",
                "approval": "no recommendation in this payload has any effect until a human being approves it",
            },
            "disclaimer": config.DISCLAIMER,
        }
    )


def _simulation_state(snapshot: dict, pressure: dict, demand: dict) -> dict:
    """Build the simulator's starting state from the live snapshot."""
    beds = snapshot.get("beds", {}) or {}
    staff = snapshot.get("staff", {}) or {}
    equipment = snapshot.get("equipment", {}) or {}
    ot = snapshot.get("ot", {}) or {}
    queue = snapshot.get("queue", {}) or {}
    return {
        "bedTotal": beds.get("total"),
        "icuTotal": beds.get("icuTotal"),
        "occupiedBeds": beds.get("occupied"),
        "occupiedIcu": beds.get("icuOccupied"),
        "availableBeds": beds.get("available"),
        "availableIcu": beds.get("icuAvailable"),
        "queue": queue.get("waiting"),
        "doctorsAvailable": staff.get("doctorsAvailable"),
        "nursesAvailable": staff.get("nursesAvailable"),
        "arrivalsPerHour": (demand.get("summary") or {}).get("currentArrivalsPerHour"),
        "ventilatorsAvailable": (equipment.get("ventilators") or {}).get("available"),
        "ventilatorsInUse": (equipment.get("ventilators") or {}).get("inUse"),
        "otAvailable": ot.get("available"),
        "theatreTotal": ot.get("total"),
        "pressureBand": pressure.get("pressure"),
    }


@app.post("/api/ai/snapshot")
def record_snapshot(request: SnapshotRequest) -> dict:
    """Record a snapshot so rolling features accumulate real operational history."""
    feature_builder.append_snapshot(request.snapshot)
    return _ok(
        {
            "recorded": True,
            "snapshots": len(feature_builder.load_history()),
            "window_hours": feature_builder.history_window_hours(),
        }
    )


@app.get("/")
def root() -> dict:
    return _ok(
        {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "docs": "/docs",
            "endpoints": [
                "POST /api/ai/demand/forecast",
                "POST /api/ai/resources/forecast",
                "POST /api/ai/surge/detect",
                "POST /api/ai/pressure/predict",
                "POST /api/ai/doctor-workload/predict",
                "POST /api/ai/nurse-workload/predict",
                "POST /api/ai/equipment-demand/predict",
                "POST /api/ai/patient-flow/predict",
                "POST /api/ai/optimize",
                "POST /api/ai/simulate",
                "POST /api/ai/advisory",
                "POST /api/ai/snapshot",
                "GET  /api/ai/models",
                "GET  /api/ai/health",
            ],
            "disclaimer": config.DISCLAIMER,
        }
    )


if __name__ == "__main__":  # pragma: no cover - manual entry point
    import uvicorn

    port = int(os.environ.get("AI_SERVICE_PORT", "5001"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level=os.environ.get("AI_LOG_LEVEL", "info"))
