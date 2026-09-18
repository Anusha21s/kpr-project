"""Inference service — operational pressure classification.

Returns the probability of each of the hospital's four approved pressure bands.
The band itself is always *also* computed by the transparent rule engine, and
the response states whether the two agree. When they disagree, the rule engine
wins: the policy band is a hospital decision, and a model may not quietly
re-band the hospital.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ai import config
from ai.inference import base, feature_builder
from ai.inference.demand_service import forecast as demand_forecast
from ai.inference.feature_builder import build_live_features, load_history
from ai.inference.resource_service import band_for

MODEL_NAME = "pressure_xgboost"

# Component weights mirror the hospital's pressure policy. They are published
# here (and in the Node engine) so the band can always be recomputed by hand.
WEIGHTS = {
    "bed_occupancy": 0.22,
    "icu_occupancy": 0.20,
    "queue_pressure": 0.16,
    "doctor_utilisation": 0.12,
    "nurse_utilisation": 0.12,
    "equipment_utilisation": 0.09,
    "ot_pressure": 0.09,
}


def components(features: dict) -> dict:
    queue_pressure = min(100.0, 100.0 * features["current_queue"] / 25.0)
    ot_pressure = min(100.0, 0.7 * features["ot_utilisation"] + 0.3 * min(100.0, features["ot_backlog"] * 8.0))
    return {
        "bed_occupancy": features["bed_occupancy"],
        "icu_occupancy": features["icu_occupancy"],
        "queue_pressure": queue_pressure,
        "doctor_utilisation": features["doctor_utilisation"],
        "nurse_utilisation": features["nurse_utilisation"],
        "equipment_utilisation": features["equipment_utilisation"],
        "ot_pressure": ot_pressure,
    }


def rule_index(features: dict) -> tuple[float, dict]:
    parts = components(features)
    index = sum(parts[name] * WEIGHTS[name] for name in WEIGHTS)
    return round(float(index), 2), {name: round(float(value), 2) for name, value in parts.items()}


def _rule_probabilities(index: float) -> dict:
    """Softmax-shaped distribution centred on the band the policy assigns.

    This is what the classifier is compared against; it exists so the API can
    always return a probability vector, even with no model on disk.
    """
    centres = {"NORMAL": 55.0, "MODERATE": 77.5, "HIGH": 90.0, "CRITICAL": 98.0}
    spread = 8.0
    weights = {label: pow(2.718281828, -abs(index - centre) / spread) for label, centre in centres.items()}
    total = sum(weights.values()) or 1.0
    return {label: round(value / total, 4) for label, value in weights.items()}


def predict(snapshot: dict, *, persist_history: bool = True, include_forecast: bool = True) -> dict:
    history = load_history()
    features = build_live_features(snapshot, history)
    index, parts = rule_index(features)
    policy_band = band_for(index)

    result = base.predict_classifier(
        MODEL_NAME,
        features,
        labels=config.PRESSURE_LABELS,
        fallback_probe=lambda: _rule_probabilities(index),
    )

    model_band = result["value"]
    agreement = model_band == policy_band
    projections: dict = {}
    if include_forecast:
        demand = demand_forecast(snapshot, explain=False, persist_history=persist_history)
        projected_queue = demand["summary"]["predictedQueue1h"]
        projected_features = dict(features)
        projected_features["current_queue"] = projected_queue
        projected_index, projected_parts = rule_index(projected_features)
        projections = {
            "projectedPressureIndex1h": projected_index,
            "projectedBand1h": band_for(projected_index),
            "projectedComponents1h": projected_parts,
        }
    elif persist_history:
        feature_builder.append_snapshot(snapshot)

    explanation = _explain(parts)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pressure": policy_band,
        "pressureIndex": index,
        "components": parts,
        "weights": WEIGHTS,
        "probabilities": result.get("probabilities"),
        "modelBand": model_band,
        "modelAgreesWithPolicy": agreement,
        "bandAuthority": "hospital pressure policy rules (NHS-style banding configured for this facility)",
        "source": result["source"],
        "model": {
            "name": MODEL_NAME,
            "source": result["source"],
            "fallback_reason": result.get("fallback_reason"),
            "model_version": result.get("model_version"),
            "feature_contributions": result.get("feature_contributions"),
        },
        "projections": projections,
        "explanation": explanation,
        "bands": [{"label": label, "low": low, "high": None if high == float("inf") else high} for label, low, high in config.PRESSURE_BANDS],
        "disclaimer": config.DISCLAIMER,
    }


def _explain(parts: dict) -> dict:
    """Human-readable drivers, ordered by contribution to the index."""
    ranked = sorted(
        ((name, parts[name], parts[name] * WEIGHTS[name]) for name in WEIGHTS),
        key=lambda item: item[2],
        reverse=True,
    )
    labels = {
        "bed_occupancy": "general bed occupancy",
        "icu_occupancy": "ICU occupancy",
        "queue_pressure": "emergency queue pressure",
        "doctor_utilisation": "doctor utilisation",
        "nurse_utilisation": "nursing utilisation",
        "equipment_utilisation": "equipment utilisation",
        "ot_pressure": "theatre and surgical backlog pressure",
    }
    drivers = [
        {
            "component": name,
            "label": labels[name],
            "value": round(value, 2),
            "weight": WEIGHTS[name],
            "contribution": round(contribution, 2),
        }
        for name, value, contribution in ranked
    ]
    top = drivers[0]
    return {
        "main_driver": top["label"],
        "statement": (
            f"{top['label'].capitalize()} contributes {top['contribution']} points of the pressure index "
            f"(value {top['value']}, weight {top['weight']})."
        ),
        "drivers": drivers,
        "method": "weighted operational index computed from the live database — reproducible by hand",
    }
