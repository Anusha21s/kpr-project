"""Model 7 — Equipment demand forecasting (XGBoost Regressor).

Forecasts how many units of each equipment category the hospital is likely to
need in the next 1–2 hours given current utilisation, reservations, ICU and
emergency demand and the waiting queue.

A predicted shortfall is reported as an operational gap for human review. It is
never an instruction to move equipment between patients, and it never overrides
a clinical decision about who needs a ventilator.
"""

from __future__ import annotations

import json

from ai.features import feature_engineering as fe
from ai.training import common

FAMILY = "equipment_demand"
MODEL_PREFIX = "equipment_demand_xgboost"


def run(verbose: bool = True) -> dict:
    frame = fe.load_prepared("equipment")
    results: dict = {}
    for model_key, target_key, note in (
        ("units_needed_1h", "units_needed_1h", "units required in the next hour"),
        ("units_needed_2h", "units_needed_2h", "units required in the next 2 hours"),
    ):
        metadata = common.train_regressor(
            family=FAMILY,
            model_name=f"{MODEL_PREFIX}_{model_key}",
            model_key=model_key,
            frame=frame,
            features=fe.EQUIPMENT_FEATURES,
            target=fe.TARGETS["equipment"][target_key],
            baseline_column="units_in_use",
            notes=f"Forecasts {note} for one equipment category. Reported as a projected gap, never as an allocation decision.",
        )
        results[model_key] = metadata
        if verbose:
            print(common.summarise(metadata))
    return results


if __name__ == "__main__":  # pragma: no cover
    payload = run()
    print(json.dumps({k: v["metrics"]["test"] for k, v in payload.items()}, indent=2))
