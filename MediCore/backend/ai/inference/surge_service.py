"""Inference service — operational surge / anomaly detection.

Uses the trained Isolation Forest to say whether the *current* operational
picture is unusual for this hospital at this hour, and how far from normal it
is. Severity wording is operational only — NORMAL, ELEVATED, HIGH PRESSURE,
CRITICAL OPERATIONAL PRESSURE — and never claims anything about a patient.

Fallback: a threshold detector over the same signals, using the hospital's own
pressure bands. It is conservative and transparent, and it is what runs
whenever the trained detector is unavailable.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from ai import config
from ai.inference import base, feature_builder
from ai.inference.feature_builder import build_live_features, load_history

MODEL_NAME = "surge_isolation_forest"

SEVERITY_LEVELS = ["NORMAL", "ELEVATED", "HIGH PRESSURE", "CRITICAL OPERATIONAL PRESSURE"]

# The detector answers "is this unusual?", the threshold rules below answer
# "is this unusual in a way that matters operationally?".
THRESHOLDS = {
    "queue": 18.0,
    "arrival_rate_spike": 2.4,      # × the same-hour baseline
    "icu_occupancy": 90.0,
    "bed_occupancy": 92.0,
    "nurse_utilisation": 90.0,
    "equipment_utilisation": 85.0,
    "ot_backlog": 12.0,
}


def _threshold_probe(features: dict) -> dict:
    """Rule-based second opinion. Returns the fired triggers and a severity."""
    triggers: list[str] = []
    if features["current_queue"] >= THRESHOLDS["queue"]:
        triggers.append(f"emergency queue at {round(features['current_queue'])} (policy threshold {THRESHOLDS['queue']:.0f})")
    if features["icu_occupancy"] >= THRESHOLDS["icu_occupancy"]:
        triggers.append(f"ICU occupancy at {round(features['icu_occupancy'])}%")
    if features["bed_occupancy"] >= THRESHOLDS["bed_occupancy"]:
        triggers.append(f"general bed occupancy at {round(features['bed_occupancy'])}%")
    if features["nurse_utilisation"] >= THRESHOLDS["nurse_utilisation"]:
        triggers.append(f"nursing capacity at {round(features['nurse_utilisation'])}%")
    if features["equipment_utilisation"] >= THRESHOLDS["equipment_utilisation"]:
        triggers.append(f"equipment utilisation at {round(features['equipment_utilisation'])}%")
    if features["ot_backlog"] >= THRESHOLDS["ot_backlog"]:
        triggers.append(f"{round(features['ot_backlog'])} surgical cases waiting")

    recent = _arrivals_series()
    baseline = _same_hour_baseline()
    ratio = None
    if recent and baseline:
        ratio = recent[-1] / baseline if baseline else None
        if ratio and ratio >= THRESHOLDS["arrival_rate_spike"]:
            triggers.append(f"arrival rate {round(ratio, 2)}× the usual rate for this hour")

    severity = "NORMAL"
    if len(triggers) >= 4:
        severity = "CRITICAL OPERATIONAL PRESSURE"
    elif len(triggers) >= 3:
        severity = "HIGH PRESSURE"
    elif len(triggers) >= 1:
        severity = "ELEVATED"

    return {
        "triggers": triggers,
        "severity": severity,
        "arrival_ratio": None if ratio is None else round(float(ratio), 3),
        "fired": len(triggers),
    }


def _arrivals_series(history: list[dict] | None = None) -> list[float]:
    history = history if history is not None else load_history()
    values: list[float] = []
    for entry in history:
        value = feature_builder._dig(entry.get("snapshot", {}), "arrivals.last1h", None)  # noqa: SLF001
        if value is not None:
            values.append(float(value))
    return values


def _same_hour_baseline() -> float | None:
    try:
        from ai.data import synthetic_generator as generator

        frame = generator.load_dataset()
        hour = datetime.now(timezone.utc).hour
        block = frame[frame["hour_of_day"] == hour]["arrivals_1h"]
        return float(block.tail(48).mean()) if len(block) else None
    except Exception:  # noqa: BLE001 - a missing baseline simply disables that trigger
        return None


def detect(snapshot: dict, *, persist_history: bool = True) -> dict:
    """Detect whether the current operational pattern is unusual."""
    history = load_history()
    features = build_live_features(snapshot, history)
    if persist_history:
        feature_builder.append_snapshot(snapshot)

    rule_view = _threshold_probe(features)

    payload = base.load_joblib(MODEL_NAME)
    if not payload:
        return _response(
            features,
            rule_view,
            detection=None,
            source="fallback",
            reason="no active trained detector — threshold rules used",
        )

    model = payload["model"]
    feature_names = payload["features"]
    # Raw numeric row, matching how the detector was fitted.
    row = np.array([[float(features.get(name, 0.0) or 0.0) for name in feature_names]], dtype=float)
    score = float(model.decision_function(row)[0])
    offset = float(payload.get("score_offset", 0.0))
    is_anomaly = bool(model.predict(row)[0] == -1) or score <= offset
    base.record_prediction(MODEL_NAME)

    detection = {
        "anomaly_detected": is_anomaly,
        "anomaly_score": round(score, 4),
        "score_offset": round(offset, 4),
        "distance_from_normal": round(offset - score, 4),
    }
    return _response(features, rule_view, detection=detection, source="model", reason=None)


def _response(features: dict, rule_view: dict, *, detection: dict | None, source: str, reason: str | None) -> dict:
    # Two different questions, two different answers, both reported:
    #   * the detector answers "is this pattern unusual for this hospital?"
    #   * the hospital's policy thresholds answer "is it operationally severe?"
    # The policy answer is the headline, because it is the one the hospital is
    # accountable to and the one that matches the pressure band shown elsewhere.
    # A model-only anomaly is still surfaced — clearly labelled as the detector's
    # view — instead of silently escalating the operational severity.
    model_severity = None
    if detection and detection["anomaly_detected"]:
        distance = detection["distance_from_normal"]
        model_severity = (
            "CRITICAL OPERATIONAL PRESSURE"
            if distance >= 0.20
            else "HIGH PRESSURE"
            if distance >= 0.10
            else "ELEVATED"
        )

    severity = rule_view["severity"]
    model_escalated = bool(model_severity) and SEVERITY_LEVELS.index(model_severity) > SEVERITY_LEVELS.index(severity)
    triggers = list(rule_view["triggers"])
    if detection and detection["anomaly_detected"] and not triggers:
        triggers = [
            "the operational pattern differs from this hospital's normal behaviour for this hour "
            f"(detector view: {model_severity}); no policy threshold is breached yet"
        ]

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "anomaly_detected": bool(detection["anomaly_detected"]) if detection else rule_view["severity"] != "NORMAL",
        "anomaly_score": detection["anomaly_score"] if detection else None,
        "severity": severity,
        "severityAuthority": "hospital surge policy thresholds (the same thresholds the command centre displays)",
        "modelSeverity": model_severity,
        "modelEscalatedAbovePolicy": model_escalated,
        "modelAgreesWithPolicy": model_severity in (None, severity),
        "severity_scale": SEVERITY_LEVELS,
        "trigger": triggers[0] if triggers else None,
        "triggers": triggers,
        "ruleBasedSeverity": rule_view["severity"],
        "arrival_rate_ratio": rule_view["arrival_ratio"],
        "thresholds": THRESHOLDS,
        "signals": {
            "currentQueue": round(features["current_queue"], 1),
            "arrivals1h": round(features["arrivals_1h"], 1),
            "icuOccupancy": round(features["icu_occupancy"], 1),
            "bedOccupancy": round(features["bed_occupancy"], 1),
            "doctorUtilisation": round(features["doctor_utilisation"], 1),
            "nurseUtilisation": round(features["nurse_utilisation"], 1),
            "equipmentUtilisation": round(features["equipment_utilisation"], 1),
            "otBacklog": round(features["ot_backlog"], 1),
        },
        "model": {
            "name": MODEL_NAME,
            "source": source,
            "fallback_reason": reason,
            "detection": detection,
        },
        "wording": {
            "note": (
                "An anomaly here means an unusual operational pattern — not a patient's medical condition. "
                "Clinical teams are never asked to wait for this signal: emergency care continues regardless."
            )
        },
        "disclaimer": config.DISCLAIMER,
        "sources": {MODEL_NAME: source},
    }


def _max_severity(*severities: str | None) -> str:
    order = {label: index for index, label in enumerate(SEVERITY_LEVELS)}
    present = [label for label in severities if label]
    return max(present, key=lambda label: order.get(label, 0)) if present else "NORMAL"
