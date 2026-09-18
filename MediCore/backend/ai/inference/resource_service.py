"""Inference service — resource utilisation forecasting.

Projects where bed, ICU, doctor, nurse, equipment and theatre utilisation are
heading over the next one to two hours, and translates that into the hospital's
approved pressure band so the command centre can act before capacity is gone.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ai import config
from ai.inference import base, feature_builder
from ai.inference.feature_builder import build_live_features, load_history

MODELS = {
    "bed_occupancy": "resource_utilisation_bed",
    "icu_occupancy": "resource_utilisation_icu",
    "doctor_utilisation": "resource_utilisation_doctor",
    "nurse_utilisation": "resource_utilisation_nurse",
    "equipment_utilisation": "resource_utilisation_equipment",
    "ot_utilisation": "resource_utilisation_ot",
    "bed_occupancy_2h": "resource_utilisation_bed_2h",
    "icu_occupancy_2h": "resource_utilisation_icu_2h",
}

PRESENT_CURRENT = {
    "bed_occupancy": "bed_occupancy",
    "icu_occupancy": "icu_occupancy",
    "doctor_utilisation": "doctor_utilisation",
    "nurse_utilisation": "nurse_utilisation",
    "equipment_utilisation": "equipment_utilisation",
    "ot_utilisation": "ot_utilisation",
}

RESOURCE_LABELS = {
    "bed_occupancy": "General beds",
    "icu_occupancy": "ICU beds",
    "doctor_utilisation": "Doctor capacity",
    "nurse_utilisation": "Nursing capacity",
    "equipment_utilisation": "Equipment",
    "ot_utilisation": "Operating theatres",
}


def band_for(value: float) -> str:
    for label, low, high in config.PRESSURE_BANDS:
        if low <= value < high:
            return label
    return config.PRESSURE_LABELS[-1]


def _drift_estimate(features: dict, current: float, steps: int) -> float:
    """Transparent fallback: carry the current trend forward, within policy limits.

    Occupancy moves slowly and predictably at the operational level; the queue
    trend is the strongest short-horizon driver of how fast it moves.
    """
    queue_trend = float(features.get("queue_change_1h", 0.0))
    hours = steps / config.STEPS_PER_HOUR
    drift = (0.35 * queue_trend) * hours
    if current >= 95.0:
        drift += 0.4 * hours   # relief planning is already underway at this level
    return float(min(max(current + drift, 0.0), 100.0))


def forecast(snapshot: dict, *, explain: bool = False, persist_history: bool = True) -> dict:
    history = load_history()
    features = build_live_features(snapshot, history)
    if persist_history:
        feature_builder.append_snapshot(snapshot)

    outputs: dict = {}
    for key, model_name in MODELS.items():
        hours_ahead = 2 if key.endswith("_2h") else 1
        base_key = key.replace("_2h", "")
        current = float(features.get(PRESENT_CURRENT[base_key], 0.0))
        steps = config.HORIZON_STEPS["2h"] if hours_ahead == 2 else config.HORIZON_STEPS["1h"]
        outputs[key] = base.predict_regressor(
            model_name,
            features,
            fallback=lambda c=current, s=steps: _drift_estimate(features, c, s),
            explain=explain,
            clamp=(0.0, 100.0),
        )

    resources: list[dict] = []
    for key in PRESENT_CURRENT:
        current = round(float(features.get(PRESENT_CURRENT[key], 0.0)), 1)
        one_hour = outputs[key]["value"]
        two_hour = outputs[f"{key}_2h"]["value"] if f"{key}_2h" in outputs else None
        delta = round(one_hour - current, 1)
        resources.append(
            {
                "resource": key,
                "label": RESOURCE_LABELS[key],
                "current": current,
                "predicted1h": one_hour,
                "predicted2h": two_hour,
                "delta1h": delta,
                "direction": "rising" if delta > 0.5 else ("falling" if delta < -0.5 else "steady"),
                "currentBand": band_for(current),
                "predictedBand1h": band_for(one_hour),
                "source": outputs[key]["source"],
                "predictionInterval": outputs[key].get("prediction_interval"),
                "wording": "projected",
            }
        )

    worst = max(resources, key=lambda item: item["predicted1h"])
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "resources": resources,
        "summary": {
            "highestProjectedUtilisation": {"resource": worst["resource"], "label": worst["label"], "value": worst["predicted1h"]},
            "resourcesRising": [item["resource"] for item in resources if item["direction"] == "rising"],
            "bandChangesWithinOneHour": [
                item["resource"] for item in resources if item["currentBand"] != item["predictedBand1h"]
            ],
        },
        "predictions": outputs,
        "sources": {key: value["source"] for key, value in outputs.items()},
        "wording": {"basis": "projected from current utilisation and demand trend — not a guarantee"},
        "disclaimer": config.DISCLAIMER,
    }
