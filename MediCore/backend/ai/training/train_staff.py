"""Models 5 & 6 — Doctor and nurse workload forecasting (XGBoost Regressor).

Predicts the near-term assigned-patient load of an individual clinician from
their current load, department pressure, incoming demand and shift context.

The allocation path only ever considers staff who are ON_DUTY, available and
inside a valid duty window; these models forecast *load*, they never decide who
works or who is assigned to a patient. Workload predictions that would exceed a
configured operational limit are surfaced as a staffing pressure warning, not
applied.
"""

from __future__ import annotations

import json

from ai.features import feature_engineering as fe
from ai.training import common

FAMILIES = {
    "doctors": ("doctor_workload", "doctor_workload_xgboost", fe.DOCTOR_FEATURES),
    "nurses": ("nurse_workload", "nurse_workload_xgboost", fe.NURSE_FEATURES),
}


def run(verbose: bool = True) -> dict:
    results: dict = {}
    for table, (family, model_prefix, features) in FAMILIES.items():
        frame = fe.load_prepared(table)
        results[table] = {}
        for model_key, target_key, horizon, note in (
            ("load_1h", "load_1h", "1 hour", "expected assigned load in the next hour"),
            ("load_2h", "load_2h", "2 hours", "expected assigned load in the next 2 hours"),
        ):
            metadata = common.train_regressor(
                family=family,
                model_name=f"{model_prefix}_{model_key}",
                model_key=model_key,
                frame=frame,
                features=features,
                target=fe.TARGETS[table][target_key],
                baseline_column="current_load",
                notes=(
                    f"Forecasts {note} for one {'doctor' if table == 'doctors' else 'nurse'}. "
                    "Configured workload limits in the operational database remain binding."
                ),
            )
            results[table][model_key] = metadata
            if verbose:
                print(common.summarise(metadata))
    return results


if __name__ == "__main__":  # pragma: no cover
    payload = run()
    print(json.dumps({k: {kk: vv["metrics"]["test"]["mae"] for kk, vv in v.items()} for k, v in payload.items()}, indent=2))
