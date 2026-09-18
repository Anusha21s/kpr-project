"""Model 1 — Emergency demand forecasting (XGBoost Regressor).

Predicts emergency arrivals and the waiting queue for the next 1 and 2 hours
from the hospital's own operational history. Uses only data that is available
at the moment the forecast is made.
"""

from __future__ import annotations

import json

from ai.features import feature_engineering as fe
from ai.training import common

FAMILY = "demand_forecast"

TARGETS = {
    "arrivals_1h": ("emergency_demand_arrivals_1h", "targets arrivals in the next 1 hour"),
    "arrivals_2h": ("emergency_demand_arrivals_2h", "targets arrivals in the next 2 hours"),
    "queue_1h": ("emergency_demand_queue_1h", "targets the emergency queue in 1 hour"),
    "queue_2h": ("emergency_demand_queue_2h", "targets the emergency queue in 2 hours"),
}


# The naive operational assumption each model has to beat: today's rate holds.
BASELINES = {
    "arrivals_1h": "arrivals_1h",
    "arrivals_2h": "arrivals_1h",
    "queue_1h": "current_queue",
    "queue_2h": "current_queue",
}


def run(verbose: bool = True) -> dict:
    frame = fe.load_prepared("timeline")
    results: dict = {}
    for model_key, (model_name, notes) in TARGETS.items():
        metadata = common.train_regressor(
            family=FAMILY,
            model_name=model_name,
            model_key=model_key,
            frame=frame,
            features=fe.DEMAND_FEATURES,
            target=fe.TARGETS["demand"][model_key],
            notes=notes,
            baseline_column=BASELINES[model_key],
        )
        results[model_key] = metadata
        if verbose:
            print(common.summarise(metadata))
    return results


if __name__ == "__main__":  # pragma: no cover
    payload = run()
    print(json.dumps({key: {"test": value["metrics"]["test"]} for key, value in payload.items()}, indent=2))
