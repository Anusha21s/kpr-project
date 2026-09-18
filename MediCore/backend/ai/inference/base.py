"""Model loading, prediction and fallback handling.

Every inference call returns the same envelope, whether the value came from a
trained model or from the deterministic rule fallback:

    {
      "value": 12.4,
      "source": "model" | "fallback",
      "model_name": "...",
      "model_version": "1.0.0",
      "algorithm": "...",
      "feature_version": "features_v1",
      "synthetic_training_data": true,
      "fallback_reason": null | "reason text"
    }

A model that is missing, corrupt or has been left as a candidate returns the
fallback value with the reason attached. The hospital never stops working
because a model file is unavailable — but it is always told which source it
got.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xgboost as xgb

from ai import config
from ai.features import feature_engineering as fe
from ai.registry import model_registry as registry

_lock = threading.Lock()
_booster_cache: dict[str, tuple[xgb.Booster, dict]] = {}
_joblib_cache: dict[str, dict] = {}

LAST_PREDICTION: dict[str, str] = {}
PREDICTION_COUNTER: dict[str, int] = {}


def record_prediction(model_name: str) -> None:
    LAST_PREDICTION[model_name] = datetime.now(timezone.utc).isoformat()
    PREDICTION_COUNTER[model_name] = PREDICTION_COUNTER.get(model_name, 0) + 1


def load_booster(model_name: str) -> tuple[xgb.Booster, dict] | None:
    """Load and cache the active XGBoost artifact for a model, if there is one."""
    with _lock:
        if model_name in _booster_cache:
            return _booster_cache[model_name]

    entry = registry.active_entry(model_name)
    if not entry:
        return None
    path = Path(entry["artifact_path"])
    if not path.exists():
        return None
    try:
        booster = xgb.Booster()
        booster.load_model(str(path))
    except Exception:  # noqa: BLE001 - any load failure means "use the fallback"
        return None

    # Training writes the metadata beside the artifact as "<model_key>_metadata.json";
    # the versioned and plain suffix styles are both accepted so an artifact can
    # never silently lose its feature contract.
    stem = path.stem
    base_key = stem.replace(f"_v{entry['model_version']}", "")
    candidates = [
        path.with_name(f"{base_key}_metadata.json"),
        path.with_name(f"{stem}_metadata.json"),
        path.with_suffix(".meta.json"),
    ]
    metadata: dict = {"features": [], "model_version": entry["model_version"]}
    for candidate in candidates:
        try:
            metadata = json.loads(candidate.read_text(encoding="utf-8"))
            break
        except (OSError, json.JSONDecodeError):
            continue

    with _lock:
        _booster_cache[model_name] = (booster, metadata)
    return _booster_cache[model_name]


def load_joblib(model_name: str) -> dict | None:
    with _lock:
        if model_name in _joblib_cache:
            return _joblib_cache[model_name]
    entry = registry.active_entry(model_name)
    if not entry:
        return None
    if not Path(entry["artifact_path"]).exists():
        return None
    try:
        import joblib

        payload = joblib.load(entry["artifact_path"])
    except Exception:  # noqa: BLE001
        return None
    with _lock:
        _joblib_cache[model_name] = payload
    return payload


def clear_cache() -> None:
    """Drop cached artifacts so a freshly promoted model is picked up."""
    with _lock:
        _booster_cache.clear()
        _joblib_cache.clear()


def envelope(
    *,
    value,
    model_name: str,
    source: str,
    metadata: dict | None = None,
    fallback_reason: str | None = None,
    extra: dict | None = None,
) -> dict:
    payload = {
        "value": value,
        "source": source,
        "model_name": model_name,
        "model_version": (metadata or {}).get("model_version"),
        "algorithm": (metadata or {}).get("algorithm"),
        "feature_version": (metadata or {}).get("feature_version", config.FEATURE_VERSION),
        "dataset_version": (metadata or {}).get("dataset_version", config.DATASET_VERSION),
        "synthetic_training_data": bool((metadata or {}).get("synthetic_data", True)),
        "fallback_reason": fallback_reason,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "disclaimer": config.DISCLAIMER,
    }
    if extra:
        payload.update(extra)
    return payload


def predict_regressor(
    model_name: str,
    features: dict,
    *,
    fallback: callable | float,
    fallback_reason: str | None = None,
    explain: bool = False,
    clamp: tuple[float, float] | None = None,
) -> dict:
    """Run one model, or compute the documented fallback value."""
    loaded = load_booster(model_name)
    if not loaded:
        value = fallback() if callable(fallback) else fallback
        return envelope(
            value=_clamp(value, clamp),
            model_name=model_name,
            source="fallback",
            fallback_reason=fallback_reason or "no active trained model available — rule-based operational estimate used",
        )

    booster, metadata = loaded
    feature_names = metadata.get("features") or []
    if not feature_names:
        value = fallback() if callable(fallback) else fallback
        return envelope(
            value=_clamp(value, clamp),
            model_name=model_name,
            source="fallback",
            fallback_reason="model metadata does not declare its feature contract",
        )

    row = np.array([[float(features.get(name, 0.0) or 0.0) for name in feature_names]], dtype=float)
    matrix = xgb.DMatrix(row, feature_names=feature_names)
    prediction = float(booster.predict(matrix, iteration_range=(0, _rounds(booster)))[0])
    record_prediction(model_name)

    extra = {}
    if explain:
        extra["feature_contributions"] = explain_row(booster, matrix, feature_names)

    metrics = metadata.get("metrics", {}).get("test", {})
    interval = metrics.get("prediction_interval") or {}
    if interval.get("lower_offset") is not None:
        extra["prediction_interval"] = {
            "confidence": interval.get("confidence"),
            "lower": round(_clamp(prediction + interval["lower_offset"], clamp), 4),
            "upper": round(_clamp(prediction + interval["upper_offset"], clamp), 4),
            "method": interval.get("method"),
        }
    extra["model_metrics"] = {
        "mae": metrics.get("mae"),
        "rmse": metrics.get("rmse"),
        "r2": metrics.get("r2"),
        "skill_vs_baseline": metrics.get("skill_vs_baseline"),
    }

    return envelope(
        value=round(_clamp(prediction, clamp), 4),
        model_name=model_name,
        source="model",
        metadata=metadata,
        extra=extra,
    )


def predict_classifier(model_name: str, features: dict, *, labels: list[str], fallback_probe: callable) -> dict:
    """Run a classifier and return the full probability vector."""
    loaded = load_booster(model_name)
    fallback_probabilities = fallback_probe()
    if not loaded:
        return envelope(
            value=max(fallback_probabilities, key=fallback_probabilities.get),
            model_name=model_name,
            source="fallback",
            fallback_reason="no active trained classifier — hospital pressure policy rules used",
            extra={"probabilities": fallback_probabilities},
        )

    booster, metadata = loaded
    feature_names = metadata.get("features") or []
    if not feature_names:
        return envelope(
            value=max(fallback_probabilities, key=fallback_probabilities.get),
            model_name=model_name,
            source="fallback",
            fallback_reason="model metadata does not declare its feature contract",
            extra={"probabilities": fallback_probabilities},
        )
    row = np.array([[float(features.get(name, 0.0) or 0.0) for name in feature_names]], dtype=float)
    matrix = xgb.DMatrix(row, feature_names=feature_names)
    probabilities = booster.predict(matrix, iteration_range=(0, _rounds(booster)))[0]
    record_prediction(model_name)
    probability_map = {label: round(float(probabilities[index]), 4) for index, label in enumerate(labels)}
    predicted_label = max(probability_map, key=probability_map.get)

    return envelope(
        value=predicted_label,
        model_name=model_name,
        source="model",
        metadata=metadata,
        extra={
            "probabilities": probability_map,
            "feature_contributions": explain_row(
                booster, matrix, feature_names, predicted_class=labels.index(predicted_label)
            ),
        },
    )


def explain_row(
    booster: xgb.Booster,
    matrix: xgb.DMatrix,
    feature_names: list[str],
    limit: int = 6,
    predicted_class: int | None = None,
) -> list[dict]:
    """Per-prediction feature contributions via XGBoost's built-in TreeSHAP.

    These are *feature contributions* — how much each operational input moved
    this particular forecast. They are not causal explanations, and they are
    labelled as such everywhere they are shown.

    For a multi-class classifier, XGBoost returns a contribution matrix
    (one row per class); the row for the predicted class is reported, because
    that is the class the reader is looking at.
    """
    try:
        raw = booster.predict(matrix, pred_contribs=True)[0]
    except Exception:  # noqa: BLE001 - explainability must never break a prediction
        return []

    array = np.asarray(raw)
    if array.ndim == 2:
        # Multi-class: shape (num_class, num_features + 1); drop the bias column.
        class_index = predicted_class if predicted_class is not None else int(np.argmax(array.sum(axis=1)))
        class_index = max(0, min(class_index, array.shape[0] - 1))
        contributions = array[class_index][:-1]
    else:
        contributions = array[:-1]

    if len(contributions) != len(feature_names):
        return []

    pairs = sorted(zip(feature_names, contributions), key=lambda item: abs(float(item[1])), reverse=True)
    return [
        {
            "feature": name,
            "label": fe.human_label(name),
            "contribution": round(float(value), 4),
            "direction": "increases" if value > 0 else "reduces",
        }
        for name, value in pairs[:limit]
    ]


def _rounds(booster: xgb.Booster) -> int:
    rounds = int(booster.num_boosted_rounds())
    best = getattr(booster, "best_iteration", None)
    try:
        best = int(best) if best is not None else -1
    except (TypeError, ValueError):
        best = -1
    if best < 0 or best >= rounds:
        best = rounds - 1
    return max(best, 0) + 1


def _clamp(value, limit: tuple[float, float] | None):
    if value is None:
        return None
    if not limit:
        return value
    return float(min(max(float(value), limit[0]), limit[1]))


def model_health() -> dict:
    """Status of every registered model, for GET /api/ai/health."""
    summary = registry.summary()["models"]
    health: dict = {}
    for name, entry in summary.items():
        active = entry.get("active_version")
        if not active:
            health[name] = {"status": "fallback", "detail": "no active model — rule-based fallback in use"}
        elif not entry.get("artifact_present"):
            health[name] = {"status": "degraded", "detail": "artifact missing on disk — fallback in use"}
        else:
            health[name] = {
                "status": "healthy",
                "version": active,
                "algorithm": entry.get("algorithm"),
                "trained_at": entry.get("trained_at"),
                "metrics": entry.get("metrics", {}).get("test", {}),
            }
    return {
        "models": health,
        "summary": {
            "registered": len(health),
            "healthy": sum(1 for entry in health.values() if entry["status"] == "healthy"),
            "fallback": sum(1 for entry in health.values() if entry["status"] == "fallback"),
            "degraded": sum(1 for entry in health.values() if entry["status"] == "degraded"),
        },
        "last_model_update": registry.all_models().get("updated_at"),
        "last_prediction": max(LAST_PREDICTION.values()) if LAST_PREDICTION else None,
        "predictions_served": PREDICTION_COUNTER,
        "synthetic_training_data": True,
        "synthetic_warning": (
            "All models were trained on a labelled synthetic hospital-operations dataset "
            "(ai/data/synthetic_generator.py) because no real hospital dataset was available to this project."
        ),
        "disclaimer": config.DISCLAIMER,
    }
