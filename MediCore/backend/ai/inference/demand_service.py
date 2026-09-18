"""Inference service — emergency demand forecasting.

Answers the operational question the command centre asks: *how many emergency
arrivals and how long a queue should we expect over the next one to two hours?*

Fallback (used whenever a trained model is unavailable): a seasonal-naive
operational estimate — the same hour across the recent history, lifted by the
current queue pressure. It is deliberately simple and stated as an estimate.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from ai import config
from ai.inference import base, feature_builder
from ai.inference.feature_builder import build_live_features, load_history

MODELS = {
    "arrivals_1h": "emergency_demand_arrivals_1h",
    "arrivals_2h": "emergency_demand_arrivals_2h",
    "queue_1h": "emergency_demand_queue_1h",
    "queue_2h": "emergency_demand_queue_2h",
}


def _seasonal_estimate(features: dict, history: list[dict], steps_ahead: int, field: str) -> float:
    """Transparent fallback: recent same-hour behaviour, adjusted for pressure."""
    values: list[float] = []
    for entry in history[-24 * config.STEPS_PER_HOUR :]:
        snapshot = entry.get("snapshot", {})
        if field == "arrivals":
            value = feature_builder._dig(snapshot, "arrivals.last1h", None)  # noqa: SLF001
        else:
            value = feature_builder._dig(snapshot, "queue.waiting", None)  # noqa: SLF001
        if value is not None:
            values.append(float(value))

    if field == "arrivals":
        baseline = float(np.mean(values)) if values else float(features.get("arrivals_1h", 0.0))
        trend = 1.0 + 0.06 * float(features.get("queue_change_1h", 0.0))
        return max(0.0, baseline * trend * (1.0 if steps_ahead == config.STEPS_PER_HOUR else 1.92))
    baseline = float(features.get("current_queue", 0.0))
    arrival_rate = float(features.get("arrivals_1h", 0.0))
    discharge_rate = float(features.get("admissions_rate_1h", 0.0)) + 2.0
    projected = baseline + (arrival_rate - discharge_rate) * (steps_ahead / config.STEPS_PER_HOUR)
    return max(0.0, projected)


def forecast(snapshot: dict, *, explain: bool = True, persist_history: bool = True) -> dict:
    """Full demand forecast for the next one and two hours."""
    history = load_history()
    features = build_live_features(snapshot, history)
    if persist_history:
        feature_builder.append_snapshot(snapshot)

    outputs: dict = {}
    for key, model_name in MODELS.items():
        steps = config.HORIZON_STEPS["1h"] if key.endswith("1h") else config.HORIZON_STEPS["2h"]
        field = "arrivals" if key.startswith("arrivals") else "queue"
        ceiling = 600.0 if field == "queue" else 200.0
        outputs[key] = base.predict_regressor(
            model_name,
            features,
            fallback=lambda s=steps, f=field: _seasonal_estimate(features, history, s, f),
            explain=explain,
            clamp=(0.0, ceiling),
        )

    queue_now = float(features["current_queue"])
    arrivals_now = float(features["arrivals_1h"])
    summary = {
        "currentQueue": round(queue_now, 1),
        "currentArrivalsPerHour": round(arrivals_now, 1),
        "predictedArrivals1h": outputs["arrivals_1h"]["value"],
        "predictedArrivals2h": outputs["arrivals_2h"]["value"],
        "predictedQueue1h": outputs["queue_1h"]["value"],
        "predictedQueue2h": outputs["queue_2h"]["value"],
        "projectedQueueChange1h": round(outputs["queue_1h"]["value"] - queue_now, 1),
        "historyHoursAvailable": feature_builder.history_window_hours(history),
    }

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "forecast_horizons": ["1h", "2h"],
        "summary": summary,
        "predictions": outputs,
        "sources": {key: value["source"] for key, value in outputs.items()},
        "wording": {
            "projection": "projected / expected / estimated — not a guarantee",
            "note": "Operational demand projection. No clinical judgement is made about any patient.",
        },
        "disclaimer": config.DISCLAIMER,
    }
