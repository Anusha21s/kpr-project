"""Model 3 — Operational surge / anomaly detection (Isolation Forest).

Learns what "unusual for this hospital at this hour" looks like across the
operational signals and flags departures from it. This is an *operational*
anomaly detector: it never equates an anomaly with a patient's medical
condition, and it never blocks or delays clinical care.

The detector is evaluated against the surge waves that are actually present in
the timeline (labelled from the data, not assumed), reporting precision,
recall, false-positive rate and detection delay.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import joblib
import numpy as np

from ai import config
from ai.evaluation import classification_metrics as cm
from ai.features import feature_engineering as fe
from ai.registry import model_registry as registry
from ai.training import common

FAMILY = "surge_detection"
MODEL_NAME = "surge_isolation_forest"
MODEL_KEY = "surge_detector"


def _severity_from_score(score: float, queue_pressure: float, arrivals: float) -> str:
    """Operational wording only: NORMAL / ELEVATED / HIGH PRESSURE / CRITICAL OPERATIONAL PRESSURE."""
    if score <= -0.20 or queue_pressure >= 95:
        return "CRITICAL OPERATIONAL PRESSURE"
    if score <= -0.12 or queue_pressure >= 85:
        return "HIGH PRESSURE"
    if score <= -0.05 or queue_pressure >= 72:
        return "ELEVATED"
    return "NORMAL"


def run(verbose: bool = True) -> dict:
    from sklearn.ensemble import IsolationForest

    frame = fe.load_prepared("timeline")
    train, validation, test = fe.chronological_split(frame)
    features = fe.ANOMALY_FEATURES

    # Fit on plain arrays: the detector is scored with raw numeric rows, and
    # matching the two representations keeps inference warning-free.
    x_train = fe.build_matrix(train, features).to_numpy()
    x_validation = fe.build_matrix(validation, features).to_numpy()
    x_test = fe.build_matrix(test, features).to_numpy()

    model = IsolationForest(
        n_estimators=320,
        max_samples=0.75,
        contamination=0.06,  # expected share of unusual operational windows in a normal month
        random_state=config.DEFAULT_SEED,
        n_jobs=2,
    )
    model.fit(x_train)

    # Score offsets: IsolationForest decision_function is centred near 0.
    train_scores = model.decision_function(x_train)
    offset = float(np.quantile(train_scores, 0.06))

    def flag(matrix) -> np.ndarray:
        return (model.decision_function(matrix) <= offset).astype(int)

    # Ground truth for evaluation comes from the injected intake waves and from
    # genuine critical-pressure windows in the held-out data.
    def ground_truth(frame_block) -> np.ndarray:
        return ((frame_block["surge_active"].astype(int) == 1) | (frame_block["pressure_index"] >= 95)).astype(int).to_numpy()

    validation_scores = model.decision_function(x_validation)
    test_scores = model.decision_function(x_test)
    validation_flags, test_flags = flag(x_validation), flag(x_test)

    metrics = {
        "validation": cm.anomaly_report(ground_truth(validation), validation_flags),
        "test": cm.anomaly_report(ground_truth(test), test_flags),
        "validation_detection_delay": cm.detection_delay(validation_flags, ground_truth(validation), config.STEP_MINUTES),
        "test_detection_delay": cm.detection_delay(test_flags, ground_truth(test), config.STEP_MINUTES),
        "score_offset": offset,
        "contamination": 0.06,
        "score_range": {"min": float(np.min(train_scores)), "max": float(np.max(train_scores))},
    }

    artifact = config.MODELS_DIR / FAMILY / f"{MODEL_KEY}_v{config.MODEL_VERSION}.joblib"
    joblib.dump({"model": model, "features": features, "score_offset": offset, "feature_version": config.FEATURE_VERSION}, artifact)

    metadata = {
        "model_name": MODEL_NAME,
        "model_key": MODEL_KEY,
        "model_version": config.MODEL_VERSION,
        "algorithm": "Isolation Forest",
        "family": FAMILY,
        "target": "operational anomaly flag",
        "features": features,
        "feature_version": config.FEATURE_VERSION,
        "dataset_version": config.DATASET_VERSION,
        "training_date": datetime.now(timezone.utc).isoformat(),
        "training_rows": int(len(train)),
        "validation_rows": int(len(validation)),
        "test_rows": int(len(test)),
        "metrics": metrics,
        "artifact_path": str(artifact),
        "synthetic_data": True,
        "severity_bands": {
            "NORMAL": "no unusual operational pattern",
            "ELEVATED": "early departure from normal, monitor",
            "HIGH PRESSURE": "sustained unusual demand, review staffing and capacity",
            "CRITICAL OPERATIONAL PRESSURE": "operational pressure at the top of the policy band — escalate for human review",
        },
        "notes": (
            "Detects unusual operational patterns only. It does not diagnose patients and never delays treatment; "
            "clinical workflows continue while the detector runs."
        ),
    }
    common.save_metadata(FAMILY, MODEL_KEY, metadata)
    registry.register(
        model_name=MODEL_NAME,
        model_version=config.MODEL_VERSION,
        algorithm=metadata["algorithm"],
        target=metadata["target"],
        metrics=metrics,
        artifact_path=str(artifact),
        training_rows=int(len(train)),
        notes=metadata["notes"],
    )
    if verbose:
        block = metrics["test"]
        delay = metrics["test_detection_delay"]
        print(
            f"  {MODEL_NAME:34s} anomaly              precision={block['precision']} recall={block['recall']} "
            f"fpr={block['false_positive_rate']} delay={delay['mean_delay_minutes']}min"
        )
    return metadata


if __name__ == "__main__":  # pragma: no cover
    print(json.dumps(run()["metrics"]["test"], indent=2))
