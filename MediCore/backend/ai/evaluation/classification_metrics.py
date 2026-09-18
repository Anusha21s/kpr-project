"""Classification and anomaly-detection metrics."""

from __future__ import annotations

import numpy as np


def confusion_matrix(actual, predicted, labels: list[str]) -> dict:
    actual = np.asarray(actual)
    predicted = np.asarray(predicted)
    matrix = {label: {inner: 0 for inner in labels} for label in labels}
    for a, p in zip(actual, predicted):
        if a in matrix and p in matrix[a]:
            matrix[a][p] += 1
    return matrix


def classification_report(actual, predicted, labels: list[str]) -> dict:
    actual = np.asarray(actual)
    predicted = np.asarray(predicted)
    matrix = confusion_matrix(actual, predicted, labels)
    per_class: dict = {}
    recalls: list[float] = []
    precisions: list[float] = []
    f1s: list[float] = []
    supports: list[int] = []

    for label in labels:
        true_positive = matrix[label][label]
        false_negative = sum(matrix[label][other] for other in labels if other != label)
        false_positive = sum(matrix[other][label] for other in labels if other != label)
        support = true_positive + false_negative
        precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) else 0.0
        recall = true_positive / support if support else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        per_class[label] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": int(support),
        }
        if support:
            precisions.append(precision)
            recalls.append(recall)
            f1s.append(f1)
            supports.append(support)

    total = len(actual)
    accuracy = float(np.mean(actual == predicted)) if total else float("nan")
    weighted = lambda values: float(np.average(values, weights=supports)) if supports else float("nan")  # noqa: E731

    return {
        "accuracy": round(accuracy, 4),
        "macro_f1": round(float(np.mean(f1s)) if f1s else float("nan"), 4),
        "weighted_f1": round(weighted(f1s), 4),
        "weighted_precision": round(weighted(precisions), 4),
        "weighted_recall": round(weighted(recalls), 4),
        "per_class": per_class,
        "confusion_matrix": matrix,
        "samples": int(total),
    }


def anomaly_report(actual_flags, predicted_flags) -> dict:
    """Precision/recall for anomaly detection, where the positive class is 'unusual'."""
    actual = np.asarray(actual_flags).astype(int)
    predicted = np.asarray(predicted_flags).astype(int)
    true_positive = int(np.sum((actual == 1) & (predicted == 1)))
    false_positive = int(np.sum((actual == 0) & (predicted == 1)))
    false_negative = int(np.sum((actual == 1) & (predicted == 0)))
    true_negative = int(np.sum((actual == 0) & (predicted == 0)))

    precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) else 0.0
    recall = true_positive / (true_positive + false_negative) if (true_positive + false_negative) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    false_positive_rate = false_positive / (false_positive + true_negative) if (false_positive + true_negative) else 0.0

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "false_positive_rate": round(false_positive_rate, 4),
        "true_positive": true_positive,
        "false_positive": false_positive,
        "false_negative": false_negative,
        "true_negative": true_negative,
        "samples": int(len(actual)),
    }


def detection_delay(predicted_flags, actual_flags, step_minutes: int = 15) -> dict:
    """How many steps after a real surge starts the detector raises the flag."""
    predicted = np.asarray(predicted_flags).astype(int)
    actual = np.asarray(actual_flags).astype(int)
    delays: list[int] = []
    index = 1
    while index < len(actual):
        rising = actual[index] == 1 and actual[index - 1] == 0
        if rising:
            window = predicted[index : index + 24]
            hits = np.flatnonzero(window == 1)
            delays.append(int(hits[0]) if len(hits) else -1)
        index += 1
    detected = [d for d in delays if d >= 0]
    missed = len(delays) - len(detected)
    return {
        "surge_events": len(delays),
        "detected": len(detected),
        "missed": missed,
        "mean_delay_steps": round(float(np.mean(detected)), 2) if detected else None,
        "mean_delay_minutes": round(float(np.mean(detected)) * step_minutes, 1) if detected else None,
        "max_delay_steps": int(np.max(detected)) if detected else None,
    }
