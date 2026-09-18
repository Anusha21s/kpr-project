"""Model 2 — Resource utilisation forecasting (XGBoost Regressor).

Predicts where bed, ICU, doctor, nurse, equipment and theatre utilisation are
heading over the next 1–2 hours. The output is operational pressure, never a
clinical statement about any patient.
"""

from __future__ import annotations

import json

from ai.features import feature_engineering as fe
from ai.training import common

FAMILY = "resource_forecast"

TARGETS = {
    "bed_occupancy": ("resource_utilisation_bed", "general bed occupancy over the next 1 hour"),
    "icu_occupancy": ("resource_utilisation_icu", "ICU occupancy over the next 1 hour"),
    "doctor_utilisation": ("resource_utilisation_doctor", "doctor utilisation over the next 1 hour"),
    "nurse_utilisation": ("resource_utilisation_nurse", "nurse utilisation over the next 1 hour"),
    "equipment_utilisation": ("resource_utilisation_equipment", "equipment utilisation over the next 1 hour"),
    "ot_utilisation": ("resource_utilisation_ot", "operating theatre utilisation over the next 1 hour"),
    "bed_occupancy_2h": ("resource_utilisation_bed_2h", "general bed occupancy over the next 2 hours"),
    "icu_occupancy_2h": ("resource_utilisation_icu_2h", "ICU occupancy over the next 2 hours"),
}


BASELINES = {
    "bed_occupancy": "bed_occupancy",
    "icu_occupancy": "icu_occupancy",
    "doctor_utilisation": "doctor_utilisation",
    "nurse_utilisation": "nurse_utilisation",
    "equipment_utilisation": "equipment_utilisation",
    "ot_utilisation": "ot_utilisation",
    "bed_occupancy_2h": "bed_occupancy",
    "icu_occupancy_2h": "icu_occupancy",
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
            features=fe.RESOURCE_FEATURES,
            target=fe.TARGETS["resource"][model_key],
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
