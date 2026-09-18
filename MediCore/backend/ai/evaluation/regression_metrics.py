"""Regression metrics for the forecasting models.

MAPE is reported as well as MAE/RMSE/R² because hospital staff read forecasts
as "how many patients" — but MAPE is suppressed when the target series contains
values at or near zero, where it is not a meaningful number.
"""

from __future__ import annotations

import numpy as np


def _clean(actual, predicted) -> tuple[np.ndarray, np.ndarray]:
    actual = np.asarray(actual, dtype=float).reshape(-1)
    predicted = np.asarray(predicted, dtype=float).reshape(-1)
    mask = np.isfinite(actual) & np.isfinite(predicted)
    return actual[mask], predicted[mask]


def mae(actual, predicted) -> float:
    actual, predicted = _clean(actual, predicted)
    return float(np.mean(np.abs(actual - predicted))) if len(actual) else float("nan")


def rmse(actual, predicted) -> float:
    actual, predicted = _clean(actual, predicted)
    return float(np.sqrt(np.mean((actual - predicted) ** 2))) if len(actual) else float("nan")


def r2(actual, predicted) -> float:
    actual, predicted = _clean(actual, predicted)
    if len(actual) < 2:
        return float("nan")
    denominator = float(np.sum((actual - np.mean(actual)) ** 2))
    if denominator == 0:
        return float("nan")
    return float(1.0 - np.sum((actual - predicted) ** 2) / denominator)


def mape(actual, predicted, epsilon: float = 1e-6) -> float | None:
    actual, predicted = _clean(actual, predicted)
    mask = np.abs(actual) > epsilon
    if mask.sum() < max(5, 0.05 * len(actual)):
        return None
    return float(np.mean(np.abs((actual[mask] - predicted[mask]) / actual[mask])) * 100.0)


def bias(actual, predicted) -> float:
    """Mean signed error — positive means the model over-forecasts on average."""
    actual, predicted = _clean(actual, predicted)
    return float(np.mean(predicted - actual)) if len(actual) else float("nan")


def prediction_interval(actual, predicted, confidence: float = 0.9) -> dict:
    """Empirical interval from residuals on held-out data.

    The interval is reported instead of a fabricated certainty figure. It is
    what the API returns to the dashboards as the expected error band.
    """
    actual, predicted = _clean(actual, predicted)
    if len(actual) < 10:
        return {"method": "insufficient_holdout_rows", "confidence": None, "lower_offset": None, "upper_offset": None}
    residuals = predicted - actual
    alpha = (1.0 - confidence) / 2.0
    return {
        "method": "empirical_residual_quantile_on_holdout",
        "confidence": confidence,
        "lower_offset": float(np.quantile(residuals, alpha)),
        "upper_offset": float(np.quantile(residuals, 1.0 - alpha)),
        "residual_std": float(np.std(residuals)),
    }


def regression_report(actual, predicted, confidence: float = 0.9) -> dict:
    return {
        "mae": round(mae(actual, predicted), 4),
        "rmse": round(rmse(actual, predicted), 4),
        "r2": round(r2(actual, predicted), 4),
        "mape": (None if mape(actual, predicted) is None else round(mape(actual, predicted), 3)),
        "bias": round(bias(actual, predicted), 4),
        "samples": int(len(_clean(actual, predicted)[0])),
        "prediction_interval": prediction_interval(actual, predicted, confidence),
    }
