"""Feature engineering for the MediCore AI models.

One place builds every feature matrix, so training and live inference can never
drift apart: the same function that produced the training columns produces the
columns for a live prediction from the current hospital state.

Two rules are enforced here and both are checked by the training report:

* **No leakage.** Features only ever describe the state at time *t*. Every
  target is a value from *t + horizon*. The chronological split keeps the
  future out of training.
* **No clinical judgement.** No feature in this file is a diagnosis, a triage
  decision or a treatment. Clinical priority arrives as data that authorised
  clinical staff recorded.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ai import config

# --------------------------------------------------------------- feature sets
DEMAND_FEATURES = [
    "current_queue",
    "critical_queue",
    "priority_mix_critical",
    "arrivals_15m",
    "arrivals_30m",
    "arrivals_1h",
    "arrivals_3h",
    "arrivals_6h",
    "arrivals_24h",
    "arrival_rate_trend",
    "queue_change_15m",
    "queue_change_30m",
    "queue_change_1h",
    "rolling_queue_mean",
    "rolling_queue_max",
    "hour_of_day",
    "hour_sin",
    "hour_cos",
    "day_of_week",
    "is_weekend",
    "is_holiday",
    "bed_occupancy",
    "icu_occupancy",
    "available_beds",
    "available_icu",
    "doctor_utilisation",
    "nurse_utilisation",
    "equipment_utilisation",
    "ot_utilisation",
    "available_doctors",
    "available_nurses",
]

RESOURCE_FEATURES = [
    "bed_occupancy",
    "icu_occupancy",
    "available_beds",
    "available_icu",
    "occupied_beds",
    "occupied_icu",
    "doctor_utilisation",
    "nurse_utilisation",
    "equipment_utilisation",
    "ot_utilisation",
    "ot_backlog",
    "ot_backlog_change_1h",
    "emergency_resource_pressure",
    "current_queue",
    "critical_queue",
    "arrivals_1h",
    "arrivals_3h",
    "arrivals_6h",
    "admissions_rate_1h",
    "discharge_rate_1h",
    "available_doctors",
    "available_nurses",
    "queue_change_1h",
    "rolling_queue_mean",
    "hour_of_day",
    "hour_sin",
    "hour_cos",
    "day_of_week",
    "is_weekend",
    "is_holiday",
]

FLOW_FEATURES = RESOURCE_FEATURES + ["queue_change_30m", "rolling_queue_max"]

DOCTOR_FEATURES = [
    "current_load",
    "max_operational_load",
    "scheduled_procedures",
    "department_pressure",
    "expected_arrivals_1h",
    "current_queue",
    "icu_occupancy",
    "bed_occupancy",
    "hour_of_day",
    "is_weekend",
    "specialty_match",
    "duty_status_on",
    "availability_free",
]

NURSE_FEATURES = [
    "current_load",
    "max_operational_load",
    "incoming_demand_1h",
    "icu_demand",
    "emergency_demand",
    "department_pressure",
    "bed_occupancy",
    "hour_of_day",
    "is_weekend",
    "duty_status_on",
    "availability_free",
]

EQUIPMENT_FEATURES = [
    "units_total",
    "units_in_use",
    "units_reserved",
    "units_available",
    "utilisation",
    "icu_demand",
    "emergency_demand",
    "current_queue",
    "department_load",
    "hour_of_day",
    "is_weekend",
]

# Anomaly detection works on the raw operational signals of the hospital.
ANOMALY_FEATURES = [
    "arrivals_15m",
    "arrivals_1h",
    "arrivals_3h",
    "current_queue",
    "critical_queue",
    "icu_occupancy",
    "bed_occupancy",
    "doctor_utilisation",
    "nurse_utilisation",
    "equipment_utilisation",
    "ot_utilisation",
    "ot_backlog",
    "emergency_resource_pressure",
]

PRESSURE_FEATURES = [
    "bed_occupancy",
    "icu_occupancy",
    "current_queue",
    "critical_queue",
    "doctor_utilisation",
    "nurse_utilisation",
    "equipment_utilisation",
    "ot_utilisation",
    "emergency_resource_pressure",
    "arrivals_1h",
    "arrivals_3h",
    "ot_backlog",
    "available_beds",
    "available_icu",
    "available_doctors",
    "available_nurses",
    "hour_of_day",
    "hour_sin",
    "hour_cos",
    "is_weekend",
]

TARGETS = {
    "demand": {
        "arrivals_1h": "target_arrivals_1h",
        "arrivals_2h": "target_arrivals_2h",
        "queue_1h": "target_queue_1h",
        "queue_2h": "target_queue_2h",
    },
    "resource": {
        "bed_occupancy": "target_bed_occupancy_1h",
        "icu_occupancy": "target_icu_occupancy_1h",
        "doctor_utilisation": "target_doctor_utilisation_1h",
        "nurse_utilisation": "target_nurse_utilisation_1h",
        "equipment_utilisation": "target_equipment_utilisation_1h",
        "ot_utilisation": "target_ot_utilisation_1h",
        "bed_occupancy_2h": "target_bed_occupancy_2h",
        "icu_occupancy_2h": "target_icu_occupancy_2h",
    },
    "flow": {
        "admissions_6h": "target_admissions_6h",
        "discharges_6h": "target_discharges_6h",
        "icu_occupancy_6h": "target_icu_occupancy_6h",
        "bed_occupancy_6h": "target_bed_occupancy_6h",
        "ot_backlog_6h": "target_ot_backlog_6h",
    },
    "doctors": {"load_1h": "target_load_1h", "load_2h": "target_load_2h"},
    "nurses": {"load_1h": "target_load_1h", "load_2h": "target_load_2h"},
    "equipment": {"units_needed_1h": "target_units_needed_1h", "units_needed_2h": "target_units_needed_2h"},
    "pressure": {"pressure_label": "pressure_label"},
}


# ------------------------------------------------------------------- builders
def _booleans_to_numbers(frame: pd.DataFrame) -> pd.DataFrame:
    working = frame.copy()
    for column in working.columns:
        if working[column].dtype == bool:
            working[column] = working[column].astype(int)
        elif working[column].dtype == object and column in (
            "is_weekend",
            "is_holiday",
            "duty_status_on",
            "availability_free",
        ):
            working[column] = working[column].astype(str).str.lower().isin(("true", "1", "yes")).astype(int)
    return working


def add_derived_flags(frame: pd.DataFrame) -> pd.DataFrame:
    """Flags that the live inference path also produces, so schemas stay aligned."""
    working = _booleans_to_numbers(frame)
    if "duty_status" in working.columns:
        working["duty_status_on"] = (working["duty_status"].astype(str) == "ON_DUTY").astype(int)
    if "availability" in working.columns:
        working["availability_free"] = (working["availability"].astype(str) == "Available").astype(int)
    if "specialty_match" not in working.columns and "department" in working.columns:
        working["specialty_match"] = (working["department"].astype(str) == "Emergency Medicine").astype(int)
    return working


def build_matrix(frame: pd.DataFrame, features: list[str]) -> pd.DataFrame:
    """Return the feature matrix, raising a clear error if a feature is missing."""
    working = add_derived_flags(frame)
    missing = [column for column in features if column not in working.columns]
    if missing:
        raise ValueError(
            f"Feature(s) missing from the operational data: {', '.join(missing)}. "
            "Training and inference must use the same feature contract (feature_version="
            f"{config.FEATURE_VERSION})."
        )
    matrix = working[features].astype(float)
    return matrix.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def chronological_split(frame: pd.DataFrame, train_frac: float = 0.70, validation_frac: float = 0.15):
    """Split by time, never at random — the future must stay out of training."""
    ordered = frame.sort_values("timestamp").reset_index(drop=True)
    total = len(ordered)
    train_end = int(total * train_frac)
    validation_end = int(total * (train_frac + validation_frac))
    return (
        ordered.iloc[:train_end].copy(),
        ordered.iloc[train_end:validation_end].copy(),
        ordered.iloc[validation_end:].copy(),
    )


def chronological_folds(frame: pd.DataFrame, folds: int = 3) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    """Expanding-window folds for validation: train on the past, score the next block."""
    ordered = frame.sort_values("timestamp").reset_index(drop=True)
    block = len(ordered) // (folds + 1)
    result: list[tuple[pd.DataFrame, pd.DataFrame]] = []
    for index in range(1, folds + 1):
        train = ordered.iloc[: block * index]
        test = ordered.iloc[block * index : block * (index + 1)]
        if len(train) > 50 and len(test) > 20:
            result.append((train, test))
    return result


# ------------------------------------------------------------- prepared files
def prepared_paths() -> dict[str, "config.Path"]:
    base = config.FEATURES_DIR
    return {
        "timeline": base / f"timeline_{config.FEATURE_VERSION}.csv",
        "demand": base / f"demand_{config.FEATURE_VERSION}.csv",
        "resource": base / f"resource_{config.FEATURE_VERSION}.csv",
        "flow": base / f"flow_{config.FEATURE_VERSION}.csv",
        "anomaly": base / f"anomaly_{config.FEATURE_VERSION}.csv",
        "pressure": base / f"pressure_{config.FEATURE_VERSION}.csv",
        "doctors": base / f"doctors_{config.FEATURE_VERSION}.csv",
        "nurses": base / f"nurses_{config.FEATURE_VERSION}.csv",
        "equipment": base / f"equipment_{config.FEATURE_VERSION}.csv",
        "manifest": base / f"manifest_{config.FEATURE_VERSION}.json",
    }


def prepare_all(timeline: pd.DataFrame | None = None, write: bool = True) -> dict:
    """Build every prepared training table plus a manifest describing them."""
    from ai.data import synthetic_generator as generator

    if timeline is None:
        timeline = generator.load_dataset()
    staff = generator.generate_staff_datasets()
    equipment = generator.generate_equipment_dataset()

    tables = {
        "timeline": timeline,
        "demand": timeline,
        "resource": timeline,
        "flow": timeline,
        "anomaly": timeline,
        "pressure": timeline,
        "doctors": staff["doctors"],
        "nurses": staff["nurses"],
        "equipment": equipment,
    }
    features = {
        "demand": DEMAND_FEATURES,
        "resource": RESOURCE_FEATURES,
        "flow": FLOW_FEATURES,
        "anomaly": ANOMALY_FEATURES,
        "pressure": PRESSURE_FEATURES,
        "doctors": DOCTOR_FEATURES,
        "nurses": NURSE_FEATURES,
        "equipment": EQUIPMENT_FEATURES,
    }

    manifest: dict = {
        "feature_version": config.FEATURE_VERSION,
        "dataset_version": config.DATASET_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "synthetic_source": "ai/data/synthetic_generator.py",
        "leakage_policy": "chronological split only; features describe time t, every target is a future value",
        "tables": {},
    }

    for name, frame in tables.items():
        working = add_derived_flags(frame)
        if name != "timeline":
            working = working.dropna(subset=[column for column in working.columns if column.startswith("target_")]).reset_index(drop=True)
            train, validation, test = chronological_split(working)
            manifest["tables"][name] = {
                "rows": int(len(working)),
                "features": features.get(name, []),
                "targets": TARGETS.get(name, {}),
                "split": {
                    "train_rows": int(len(train)),
                    "validation_rows": int(len(validation)),
                    "test_rows": int(len(test)),
                    "train_start": train["timestamp"].iloc[0].isoformat() if len(train) else None,
                    "test_end": test["timestamp"].iloc[-1].isoformat() if len(test) else None,
                },
            }
        else:
            manifest["tables"][name] = {"rows": int(len(working))}

        if write:
            path = prepared_paths()[name]
            working.to_csv(path, index=False)
            manifest["tables"][name]["path"] = str(path)

    if write:
        prepared_paths()["manifest"].write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def load_prepared(name: str) -> pd.DataFrame:
    path = prepared_paths()[name]
    if not path.exists():
        prepare_all()
    frame = pd.read_csv(path)
    if "timestamp" in frame.columns:
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    return frame


def human_label(feature: str) -> str:
    """Plain-language name for a feature, used when explaining a prediction."""
    return config.FEATURE_LABELS.get(feature, feature.replace("_", " "))


if __name__ == "__main__":  # pragma: no cover
    info = prepare_all()
    print(json.dumps({name: table.get("rows") for name, table in info["tables"].items()}, indent=2))
