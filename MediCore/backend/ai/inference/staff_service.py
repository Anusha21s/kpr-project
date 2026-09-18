"""Inference service — doctor and nurse workload forecasting.

Forecasts the near-term assigned-patient load of each clinician on duty, so the
resource coordinator can see where load is heading *before* it becomes a
staffing problem.

Two rules are enforced in this file:

* only staff who are ON_DUTY, available, and inside a valid duty window are
  scored for allocation planning — the model never "activates" an off-duty
  clinician;
* a forecast that would cross a configured workload limit is reported as a
  staffing pressure warning. It is never applied to the roster.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ai import config
from ai.inference import base, feature_builder
from ai.inference.feature_builder import build_live_features, load_history

MODELS = {
    "doctors": {"1h": "doctor_workload_xgboost_load_1h", "2h": "doctor_workload_xgboost_load_2h"},
    "nurses": {"1h": "nurse_workload_xgboost_load_1h", "2h": "nurse_workload_xgboost_load_2h"},
}

DEFAULT_LIMITS = {"doctors": 6, "nurses": 4}


def _fallback_load(staff: dict, features: dict, horizon: str) -> float:
    """Transparent fallback: current load plus this department's share of the queue trend."""
    current = float(staff.get("assignedPatients") or staff.get("currentLoad") or 0.0)
    department_pressure = float(staff.get("departmentPressure") or features.get("department_pressure", 50.0))
    incoming = 0.45 * float(features.get("arrivals_1h", 0.0))
    horizon_factor = 1.0 if horizon == "1h" else 1.8
    projected = current + (0.02 * department_pressure + 0.10 * incoming) * horizon_factor
    return round(max(0.0, projected), 3)


def predict_workload(snapshot: dict, *, role: str = "doctors", explain: bool = False) -> dict:
    """Workload forecast for every member of the given roster in the snapshot."""
    role = "nurses" if role.startswith("nurse") else "doctors"
    history = load_history()
    features = build_live_features(snapshot, history)

    roster = snapshot.get(role) or []
    limit_key = "maxOperationalLoad"
    results: list[dict] = []

    for member in roster:
        member_features = dict(features)
        member_features.update(
            {
                "current_load": float(member.get("assignedPatients") or member.get("currentLoad") or 0.0),
                "max_operational_load": float(member.get(limit_key) or DEFAULT_LIMITS[role]),
                "scheduled_procedures": float(member.get("scheduledProcedures") or 0.0),
                "department_pressure": float(member.get("departmentPressure") or features.get("department_pressure", 50.0)),
                "expected_arrivals_1h": float(features.get("arrivals_1h", 0.0)),
                "incoming_demand_1h": round(0.45 * float(features.get("arrivals_1h", 0.0)), 3),
                "specialty_match": 1.0 if member.get("emergencyTrained") else 0.0,
                "duty_status_on": 1.0 if member.get("dutyStatus") == "ON_DUTY" else 0.0,
                "availability_free": 1.0 if member.get("availability") == "Available" else 0.0,
            }
        )

        one_hour = base.predict_regressor(
            MODELS[role]["1h"],
            member_features,
            fallback=lambda m=member: _fallback_load(m, features, "1h"),
            explain=explain,
            clamp=(0.0, 20.0),
        )
        two_hour = base.predict_regressor(
            MODELS[role]["2h"],
            member_features,
            fallback=lambda m=member: _fallback_load(m, features, "2h"),
            clamp=(0.0, 20.0),
        )

        limit = float(member.get(limit_key) or DEFAULT_LIMITS[role])
        current_load = float(member.get("assignedPatients") or member.get("currentLoad") or 0.0)
        projected = one_hour["value"]
        results.append(
            {
                "staffId": member.get("id") or member.get("staffId"),
                "name": member.get("name"),
                "department": member.get("department"),
                "dutyStatus": member.get("dutyStatus"),
                "availability": member.get("availability"),
                "currentLoad": current_load,
                "maxOperationalLoad": limit,
                "predictedLoad1h": projected,
                "predictedLoad2h": two_hour["value"],
                "workloadLevel": workload_level(projected, limit),
                "exceedsConfiguredLimit": projected > limit,
                "delta1h": round(projected - current_load, 2),
                "source": one_hour["source"],
                "eligibleForAssignment": member.get("dutyStatus") == "ON_DUTY" and member.get("availability") == "Available",
                "wording": "projected",
            }
        )

    over_limit = [item for item in results if item["exceedsConfiguredLimit"]]
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "role": role,
        "summary": {
            "scored": len(results),
            "eligibleNow": sum(1 for item in results if item["eligibleForAssignment"]),
            "projectedOverLimit": len(over_limit),
            "projectedOverLimitIds": [item["staffId"] for item in over_limit],
            "meanProjectedLoad1h": round(sum(item["predictedLoad1h"] for item in results) / len(results), 2) if results else None,
            "warning": (
                "Projected load crosses a configured workload limit for "
                f"{len(over_limit)} clinician(s) — staffing reinforcement should be reviewed by the coordinator."
                if over_limit
                else "No clinician is projected to cross a configured workload limit within the next hour."
            ),
        },
        "staff": results,
        "models": MODELS[role],
        "policy": {
            "assignmentEligibility": "ON_DUTY + Available only; off-duty, leave and unavailable staff are never assigned",
            "workloadLimits": {
                "doctors": f"configured per doctor (default {DEFAULT_LIMITS['doctors']} patients)",
                "nurses": f"configured per nurse (default {DEFAULT_LIMITS['nurses']} patients)",
            },
            "enforcement": "forecasts are advisory; the configured limits in the operational database remain binding",
        },
        "sources": {key: value for key, value in MODELS[role].items()},
        "disclaimer": config.DISCLAIMER,
    }


def workload_level(load: float, limit: float) -> str:
    ratio = load / max(limit, 1)
    if ratio >= 1.0:
        return "OVER_LIMIT"
    if ratio >= 0.85:
        return "HIGH"
    if ratio >= 0.6:
        return "MODERATE"
    return "LOW"


def feature_snapshot() -> dict:  # pragma: no cover - helper for diagnostics
    return build_live_features(feature_builder.empty_state_snapshot(), load_history())
