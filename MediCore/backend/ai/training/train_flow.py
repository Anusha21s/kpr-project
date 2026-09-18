"""Model 8 — Patient flow forecasting (XGBoost Regressor).

Forecasts the operational flow of the hospital six hours out: admissions,
discharges, ICU occupancy, bed occupancy and the surgical backlog.

This is an operational model. It does not predict any individual patient's
diagnosis, disease progression, treatment, surgery outcome or mortality — those
are clinical questions and are explicitly out of scope for this system.
"""

from __future__ import annotations

import json

from ai.features import feature_engineering as fe
from ai.training import common

FAMILY = "patient_flow"
MODEL_PREFIX = "patient_flow_xgboost"


BASELINES = {
    "admissions_6h": "admissions_rate_1h",
    "discharges_6h": "discharge_rate_1h",
    "icu_occupancy_6h": "icu_occupancy",
    "bed_occupancy_6h": "bed_occupancy",
    "ot_backlog_6h": "ot_backlog",
}


def run(verbose: bool = True) -> dict:
    frame = fe.load_prepared("flow")
    results: dict = {}
    for model_key, note in (
        ("admissions_6h", "admissions per hour six hours out"),
        ("discharges_6h", "discharges per hour six hours out"),
        ("icu_occupancy_6h", "ICU occupancy six hours out"),
        ("bed_occupancy_6h", "general bed occupancy six hours out"),
        ("ot_backlog_6h", "waiting surgical cases six hours out"),
    ):
        metadata = common.train_regressor(
            family=FAMILY,
            model_name=f"{MODEL_PREFIX}_{model_key}",
            model_key=model_key,
            frame=frame,
            features=fe.FLOW_FEATURES,
            target=fe.TARGETS["flow"][model_key],
            baseline_column=BASELINES[model_key],
            notes=f"Forecasts {note}. Operational flow only: no diagnosis, treatment or outcome prediction.",
        )
        results[model_key] = metadata
        if verbose:
            print(common.summarise(metadata))
    return results


if __name__ == "__main__":  # pragma: no cover
    payload = run()
    print(json.dumps({k: v["metrics"]["test"] for k, v in payload.items()}, indent=2))
