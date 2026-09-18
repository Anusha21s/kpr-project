"""Inference service — patient flow forecasting.

Projects the operational flow of the hospital six hours out: admissions,
discharges, ICU occupancy, general bed occupancy and the surgical backlog.

Scope is enforced here: this service forecasts *operational throughput*. It
never predicts a diagnosis, disease progression, treatment, surgery outcome or
mortality for any patient.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ai import config
from ai.inference import base, feature_builder
from ai.inference.feature_builder import build_live_features, load_history

MODELS = {
    "admissions_6h": "patient_flow_xgboost_admissions_6h",
    "discharges_6h": "patient_flow_xgboost_discharges_6h",
    "icu_occupancy_6h": "patient_flow_xgboost_icu_occupancy_6h",
    "bed_occupancy_6h": "patient_flow_xgboost_bed_occupancy_6h",
    "ot_backlog_6h": "patient_flow_xgboost_ot_backlog_6h",
}

CURRENT = {
    "admissions_6h": ("admissions_rate_1h", "admissions per hour"),
    "discharges_6h": ("discharge_rate_1h", "discharges per hour"),
    "icu_occupancy_6h": ("icu_occupancy", "ICU occupancy %"),
    "bed_occupancy_6h": ("bed_occupancy", "general bed occupancy %"),
    "ot_backlog_6h": ("ot_backlog", "surgical cases waiting"),
}


def _fallback(current: float, features: dict, key: str) -> float:
    """Transparent fallback: hold the current operational rate steady."""
    queue_trend = float(features.get("queue_change_1h", 0.0))
    if key == "admissions_6h":
        return max(0.0, current + 0.10 * queue_trend)
    if key == "discharges_6h":
        return max(0.0, current)
    if key.endswith("_occupancy_6h"):
        drift = 0.8 if current >= 90 else 0.2
        return min(100.0, current + drift + 0.05 * queue_trend)
    return max(0.0, current + 0.4 * queue_trend)


def forecast(snapshot: dict, *, explain: bool = False) -> dict:
    history = load_history()
    features = build_live_features(snapshot, history)

    outputs: dict = {}
    for key, model_name in MODELS.items():
        column, label = CURRENT[key]
        current = float(features.get(column, 0.0))
        ceiling = 100.0 if key.endswith("_occupancy_6h") else 400.0
        outputs[key] = base.predict_regressor(
            model_name,
            features,
            fallback=lambda c=current, k=key: _fallback(c, features, k),
            explain=explain,
            clamp=(0.0, ceiling),
        )

    projection = {
        key: {
            "label": CURRENT[key][1],
            "current": round(float(features.get(CURRENT[key][0], 0.0)), 2),
            "projected6h": outputs[key]["value"],
            "source": outputs[key]["source"],
            "wording": "projected",
        }
        for key in MODELS
    }

    icu_delta = round(projection["icu_occupancy_6h"]["projected6h"] - projection["icu_occupancy_6h"]["current"], 1)
    bed_delta = round(projection["bed_occupancy_6h"]["projected6h"] - projection["bed_occupancy_6h"]["current"], 1)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "horizon": "6h",
        "projection": projection,
        "summary": {
            "icuDirection": "rising" if icu_delta > 0.5 else ("falling" if icu_delta < -0.5 else "steady"),
            "icuDelta6h": icu_delta,
            "bedDirection": "rising" if bed_delta > 0.5 else ("falling" if bed_delta < -0.5 else "steady"),
            "bedDelta6h": bed_delta,
            "statement": (
                f"On the current trajectory, ICU occupancy is {('projected to reach ' + str(projection['icu_occupancy_6h']['projected6h']) + '%') if icu_delta >= 0 else ('projected to ease to ' + str(projection['icu_occupancy_6h']['projected6h']) + '%')} "
                f"within six hours and general bed occupancy {('rises to ' + str(projection['bed_occupancy_6h']['projected6h']) + '%') if bed_delta > 0 else ('eases to ' + str(projection['bed_occupancy_6h']['projected6h']) + '%')}."
            ),
        },
        "predictions": outputs,
        "sources": {key: value["source"] for key, value in outputs.items()},
        "scope": {
            "in_scope": ["admissions", "discharges", "bed and ICU occupancy", "surgical backlog"],
            "explicitly_out_of_scope": [
                "diagnosis",
                "disease progression",
                "treatment recommendation",
                "surgery outcome",
                "mortality",
            ],
            "reason": "MediCore is an operational resource system. Clinical judgement belongs to clinicians.",
        },
        "disclaimer": config.DISCLAIMER,
    }
