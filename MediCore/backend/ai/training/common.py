"""Shared training machinery.

Every trainer in this package goes through the functions below, so all models
are trained the same way and all of them produce the same four deliverables:

1. a saved artifact          (`ai/models/<family>/<model>_v<version>.<ext>`)
2. metrics on held-out data  (validation *and* the future test block)
3. model metadata            (`ai/models/<family>/<model>_v<version>_metadata.json`)
4. a registry entry          (`ai/registry/model_registry.json`)

Chronological splits are mandatory. A model is never scored on rows it trained
on, and the test block is always the most recent stretch of the timeline.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import xgboost as xgb

from ai import config
from ai.evaluation import classification_metrics as cm
from ai.evaluation import regression_metrics as rm
from ai.features import feature_engineering as fe
from ai.registry import model_registry as registry

# Gradient-boosted trees on a few thousand operational rows: shallow, heavily
# regularised, so the model cannot memorise individual shifts.
REGRESSOR_PARAMS = {
    "objective": "reg:squarederror",
    "eta": 0.06,
    "max_depth": 5,
    "subsample": 0.85,
    "colsample_bytree": 0.85,
    "min_child_weight": 3,
    "reg_lambda": 1.5,
    "seed": config.DEFAULT_SEED,
    "nthread": 2,
}

CLASSIFIER_PARAMS = {
    "objective": "multi:softprob",
    "num_class": len(config.PRESSURE_LABELS),
    "eta": 0.08,
    "max_depth": 4,
    "subsample": 0.9,
    "colsample_bytree": 0.9,
    "min_child_weight": 2,
    "reg_lambda": 1.5,
    "seed": config.DEFAULT_SEED,
    "nthread": 2,
    "eval_metric": "mlogloss",
}


def _family_dir(family: str):
    path = config.MODELS_DIR / family
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_metadata(family: str, model_key: str, payload: dict) -> str:
    path = _family_dir(family) / f"{model_key}_metadata.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path)


def _stopping_round(booster: xgb.Booster, fallback: int) -> int:
    """Last boosting round to use for predictions.

    XGBoost's ``best_iteration`` is only meaningful when early stopping actually
    fired; when it did not, or when it reports a value beyond the trees that
    were built, the final round is used instead.
    """
    rounds = int(booster.num_boosted_rounds())
    best = getattr(booster, "best_iteration", None)
    try:
        best = int(best) if best is not None else -1
    except (TypeError, ValueError):
        best = -1
    if best < 0 or best >= rounds:
        best = min(rounds - 1, fallback)
    return max(best, 0)


def _persistence_metrics(frame: pd.DataFrame, column: str | None, target: str) -> dict | None:
    """Score the simplest possible forecast: "what we see now is what we get".

    Reported next to every model so the dashboards can state, honestly, whether
    the model is adding anything over the naive operational assumption.
    """
    if not column or column not in frame.columns:
        return None
    return rm.regression_report(frame[target].astype(float), frame[column].astype(float))


def train_regressor(
    *,
    family: str,
    model_name: str,
    model_key: str,
    frame: pd.DataFrame,
    features: list[str],
    target: str,
    num_boost_round: int = 320,
    early_stopping_rounds: int = 30,
    notes: str | None = None,
    params: dict | None = None,
    baseline_column: str | None = None,
) -> dict:
    """Train, evaluate, save and register one XGBoost regressor.

    The model is also scored against the persistence baseline supplied in
    ``baseline_column``; ``skill_vs_baseline`` is the relative improvement in
    MAE, which is what the quality gate uses for count and occupancy targets
    where raw R² is dominated by irreducible demand noise.
    """
    working = fe.add_derived_flags(frame).dropna(subset=[target]).reset_index(drop=True)
    train, validation, test = fe.chronological_split(working)
    x_train, y_train = fe.build_matrix(train, features), train[target].astype(float)
    x_validation, y_validation = fe.build_matrix(validation, features), validation[target].astype(float)
    x_test, y_test = fe.build_matrix(test, features), test[target].astype(float)

    dtrain = xgb.DMatrix(x_train, label=y_train, feature_names=features)
    dvalidation = xgb.DMatrix(x_validation, label=y_validation, feature_names=features)
    dtest = xgb.DMatrix(x_test, label=y_test, feature_names=features)

    booster = xgb.train(
        {**(params or REGRESSOR_PARAMS), "seed": config.DEFAULT_SEED},
        dtrain,
        num_boost_round=num_boost_round,
        evals=[(dvalidation, "validation")],
        early_stopping_rounds=early_stopping_rounds,
        verbose_eval=False,
    )

    best_iteration = _stopping_round(booster, num_boost_round - 1)
    validation_predictions = booster.predict(dvalidation, iteration_range=(0, best_iteration + 1))
    test_predictions = booster.predict(dtest, iteration_range=(0, best_iteration + 1))

    baseline_validation = _persistence_metrics(validation, baseline_column, target)
    baseline_test = _persistence_metrics(test, baseline_column, target)
    model_test = rm.regression_report(y_test, test_predictions)
    if baseline_test and baseline_test.get("mae"):
        model_test["skill_vs_baseline"] = round(1.0 - (model_test["mae"] / baseline_test["mae"]), 4)
        model_test["skill_baseline"] = f"persistence ({baseline_column})"

    metrics = {
        "validation": rm.regression_report(y_validation, validation_predictions),
        "test": model_test,
        "baseline": {"validation": baseline_validation, "test": baseline_test, "column": baseline_column},
        "best_iteration": best_iteration,
        "trees": int(booster.num_boosted_rounds()),
    }
    metrics["feature_importance"] = top_importances(booster, features, limit=10)

    artifact = _family_dir(family) / f"{model_key}_v{config.MODEL_VERSION}.json"
    booster.save_model(str(artifact))

    metadata = {
        "model_name": model_name,
        "model_key": model_key,
        "model_version": config.MODEL_VERSION,
        "algorithm": "XGBoost Regressor",
        "family": family,
        "target": target,
        "features": features,
        "feature_version": config.FEATURE_VERSION,
        "dataset_version": config.DATASET_VERSION,
        "training_date": datetime.now(timezone.utc).isoformat(),
        "training_rows": int(len(train)),
        "validation_rows": int(len(validation)),
        "test_rows": int(len(test)),
        "baseline_column": baseline_column,
        "params": {k: v for k, v in (params or REGRESSOR_PARAMS).items()},
        "metrics": metrics,
        "artifact_path": str(artifact),
        "synthetic_data": True,
        "notes": notes,
    }
    save_metadata(family, model_key, metadata)

    registry.register(
        model_name=model_name,
        model_version=config.MODEL_VERSION,
        algorithm=metadata["algorithm"],
        target=target,
        metrics=metrics,
        artifact_path=str(artifact),
        training_rows=int(len(train)),
        notes=notes,
    )
    return metadata


def train_classifier(
    *,
    family: str,
    model_name: str,
    model_key: str,
    frame: pd.DataFrame,
    features: list[str],
    target: str,
    labels: list[str],
    num_boost_round: int = 260,
    notes: str | None = None,
) -> dict:
    """Train, evaluate, save and register the operational pressure classifier."""
    working = fe.add_derived_flags(frame).dropna(subset=[target]).reset_index(drop=True)
    working = working[working[target].isin(labels)].reset_index(drop=True)
    train, validation, test = fe.chronological_split(working)

    def encode(values: pd.Series) -> np.ndarray:
        return values.map({label: index for index, label in enumerate(labels)}).astype(int).to_numpy()

    x_train, y_train = fe.build_matrix(train, features), encode(train[target])
    x_validation, y_validation = fe.build_matrix(validation, features), encode(validation[target])
    x_test, y_test = fe.build_matrix(test, features), encode(test[target])

    dtrain = xgb.DMatrix(x_train, label=y_train, feature_names=features)
    dvalidation = xgb.DMatrix(x_validation, label=y_validation, feature_names=features)
    dtest = xgb.DMatrix(x_test, label=y_test, feature_names=features)

    booster = xgb.train(
        {**CLASSIFIER_PARAMS, "seed": config.DEFAULT_SEED},
        dtrain,
        num_boost_round=num_boost_round,
        evals=[(dvalidation, "validation")],
        early_stopping_rounds=25,
        verbose_eval=False,
    )
    best_iteration = int(getattr(booster, "best_iteration", num_boost_round - 1) or num_boost_round - 1)

    def predict(matrix: xgb.DMatrix) -> np.ndarray:
        probabilities = booster.predict(matrix, iteration_range=(0, best_iteration + 1))
        return np.argmax(probabilities, axis=1)

    validation_predictions = predict(dvalidation)
    test_predictions = predict(dtest)

    metrics = {
        "validation": cm.classification_report(
            [labels[index] for index in y_validation], [labels[index] for index in validation_predictions], labels
        ),
        "test": cm.classification_report([labels[index] for index in y_test], [labels[index] for index in test_predictions], labels),
        "best_iteration": best_iteration,
        "trees": int(booster.num_boosted_rounds()),
        "labels": labels,
        "label_source": "hospital pressure policy bands (approved operationally, reproduced from labelled operational history)",
    }
    metrics["feature_importance"] = top_importances(booster, features, limit=10)

    artifact = _family_dir(family) / f"{model_key}_v{config.MODEL_VERSION}.json"
    booster.save_model(str(artifact))

    metadata = {
        "model_name": model_name,
        "model_key": model_key,
        "model_version": config.MODEL_VERSION,
        "algorithm": "XGBoost Classifier",
        "family": family,
        "target": target,
        "labels": labels,
        "features": features,
        "feature_version": config.FEATURE_VERSION,
        "dataset_version": config.DATASET_VERSION,
        "training_date": datetime.now(timezone.utc).isoformat(),
        "training_rows": int(len(train)),
        "validation_rows": int(len(validation)),
        "test_rows": int(len(test)),
        "class_balance": {label: int((train[target] == label).sum()) for label in labels},
        "metrics": metrics,
        "artifact_path": str(artifact),
        "synthetic_data": True,
        "notes": notes
        or (
            "Trained on the hospital's approved pressure banding (NORMAL/MODERATE/HIGH/CRITICAL). "
            "The rule-based pressure engine in the Node backend remains the authority and the fallback; "
            "this classifier reports the probability of each band."
        ),
    }
    save_metadata(family, model_key, metadata)

    registry.register(
        model_name=model_name,
        model_version=config.MODEL_VERSION,
        algorithm=metadata["algorithm"],
        target=target,
        metrics=metrics,
        artifact_path=str(artifact),
        training_rows=int(len(train)),
        notes=metadata["notes"],
    )
    return metadata


def top_importances(booster: xgb.Booster, features: list[str], limit: int = 10) -> list[dict]:
    """Gain-based feature contributions, in the order the dashboards show them."""
    gains = booster.get_score(importance_type="gain")
    total = sum(gains.values()) or 1.0
    ranked = sorted(gains.items(), key=lambda item: item[1], reverse=True)[:limit]
    return [
        {"feature": name, "label": fe.human_label(name), "share": round(value / total, 4)}
        for name, value in ranked
    ]


def write_training_report(name: str, payload: dict) -> str:
    path = config.REPORTS_DIR / f"{name}_report.json"
    payload = {**payload, "generated_at": datetime.now(timezone.utc).isoformat()}
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path)


def summarise(metadata: dict, headline_target: str = "test") -> str:
    """One-line console summary for a training run."""
    block = metadata["metrics"].get(headline_target, {})
    if "r2" in block:
        skill = block.get("skill_vs_baseline")
        return (
            f"  {metadata['model_name']:34s} "
            f"MAE={str(block['mae']):<8} RMSE={str(block['rmse']):<8} R2={str(block['r2']):<8} "
            f"skill_vs_baseline={('n/a' if skill is None else f'{round(skill * 100, 1)}%')}"
        )
    if "macro_f1" in block:
        return f"  {metadata['model_name']:34s} {metadata['target']:22s} acc={block['accuracy']} macroF1={block['macro_f1']}"
    return f"  {metadata['model_name']:34s} {metadata['target']:22s}"
