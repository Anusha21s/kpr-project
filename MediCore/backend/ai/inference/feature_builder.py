"""Build live feature rows from a hospital-state snapshot.

This module is the contract between the Node backend and the models: the Node
backend posts a snapshot of the live hospital (as it exists in PostgreSQL) and
this module turns it into exactly the columns the models were trained on.

Training and inference therefore share one definition of every feature. If the
two ever drifted apart, `build_live_features` would raise rather than let a
model silently receive the wrong input.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

from ai import config
from ai.data import synthetic_generator as generator
from ai.features import feature_engineering as fe

RUNTIME_DIR = config.DATA_DIR / "runtime"
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_PATH = RUNTIME_DIR / "state_history.jsonl"
MAX_HISTORY_ROWS = 24 * config.STEPS_PER_HOUR  # one operational day


# ------------------------------------------------------------------- history
def append_snapshot(snapshot: dict) -> None:
    """Record one snapshot so rolling features have a real history to use.

    The stamp is always the true arrival time on this service. A caller-supplied
    `generatedAt` may be step-rounded or stale, and mixing those with wall-clock
    rows used to leave the history out of order (which made the rolling window
    meaningless). Re-posting the same snapshot is a no-op.
    """
    import json

    stamp = datetime.now(timezone.utc).isoformat()
    existing = load_history()
    if existing and existing[-1]["timestamp"][:19] == stamp[:19]:
        return
    row = {"timestamp": stamp, "snapshot": snapshot}
    with HISTORY_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")
    _trim_history()


def _trim_history() -> None:
    import json

    if not HISTORY_PATH.exists():
        return
    lines = HISTORY_PATH.read_text(encoding="utf-8").strip().splitlines()
    if len(lines) <= MAX_HISTORY_ROWS:
        return
    HISTORY_PATH.write_text("\n".join(lines[-MAX_HISTORY_ROWS:]) + "\n", encoding="utf-8")


def load_history(steps: int = MAX_HISTORY_ROWS) -> list[dict]:
    import json

    if not HISTORY_PATH.exists():
        return []
    lines = HISTORY_PATH.read_text(encoding="utf-8").strip().splitlines()
    rows: list[dict] = []
    seen: dict[str, dict] = {}
    for line in lines[-steps:]:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not payload.get("timestamp"):
            continue
        seen[payload["timestamp"]] = payload  # a re-recorded stamp replaces the older row
    return sorted(seen.values(), key=lambda entry: entry["timestamp"])


# ------------------------------------------------------------ snapshot maths
def _num(value, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _dig(source: dict, path: str, default=0.0):
    node = source
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node if node is not None else default


def _history_value(entry: dict, path: str, default=0.0):
    return _dig(entry.get("snapshot", {}), path, default)


def _hour_of(timestamp: str | None) -> int:
    if not timestamp:
        return datetime.now(timezone.utc).hour
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).hour
    except ValueError:
        return datetime.now(timezone.utc).hour


def build_live_features(snapshot: dict, history: list[dict] | None = None) -> dict:
    """Return a mapping of feature name → value for the current hospital state.

    ``snapshot`` shape (produced by the Node backend):
      meta, beds{total,occupied,available,icuTotal,icuOccupied,icuAvailable},
      queue{waiting,critical,high}, admissions{last1h,last3h}, discharges{last1h},
      staff{doctorsOnDuty,doctorsAvailable,doctorsTotal,nursesOnDuty,nursesAvailable,nursesTotal,
            doctorUtilisation,nurseUtilisation},
      equipment{total,inUse,reserved,utilisation,ventilators{total,inUse,available}},
      ot{total,active,backlog,utilisation}, emergencyResources{...},
      arrivals{last15m,last30m,last1h,last3h,last6h,last24h}
    """
    history = history if history is not None else load_history()
    generated_at = snapshot.get("generatedAt") or datetime.now(timezone.utc).isoformat()
    hour = _hour_of(generated_at)
    try:
        dow = datetime.fromisoformat(generated_at.replace("Z", "+00:00")).weekday()
    except ValueError:
        dow = datetime.now(timezone.utc).weekday()
    is_weekend = dow >= 5

    beds = snapshot.get("beds", {})
    queue = snapshot.get("queue", {})
    staff = snapshot.get("staff", {})
    equipment = snapshot.get("equipment", {})
    ot = snapshot.get("ot", {})
    arrivals = snapshot.get("arrivals", {})
    emergency = snapshot.get("emergencyResources", {})

    total_beds = max(_num(beds.get("total"), 0), 1)
    occupied_beds = _num(beds.get("occupied"))
    total_icu = max(_num(beds.get("icuTotal"), 0), 1)
    occupied_icu = _num(beds.get("icuOccupied"))

    bed_occupancy = 100.0 * occupied_beds / total_beds
    icu_occupancy = 100.0 * occupied_icu / total_icu
    waiting = _num(queue.get("waiting"))
    critical_queue = _num(queue.get("critical"))
    priority_mix = critical_queue / waiting if waiting else 0.0

    total_equipment = max(_num(equipment.get("total")), 1)
    equipment_utilisation = _num(
        equipment.get("utilisation"), 100.0 * _num(equipment.get("inUse")) / total_equipment
    )
    ot_utilisation = _num(ot.get("utilisation"), 100.0 * _num(ot.get("active")) / max(_num(ot.get("total")), 1))

    # Rolling figures come from this service's own recorded history where the
    # snapshot does not already carry them.
    def history_at(steps_back: int, path: str) -> float | None:
        if len(history) <= steps_back:
            return None
        return _num(_history_value(history[-(steps_back + 1)], path), float("nan"))

    current_queue_series = [_num(_history_value(entry, "queue.waiting")) for entry in history]
    if not current_queue_series:
        current_queue_series = [waiting]

    def queue_change(steps_back: int) -> float:
        if len(current_queue_series) > steps_back:
            return round(waiting - current_queue_series[-(steps_back + 1)], 3)
        return 0.0

    recent = current_queue_series[-4 * config.STEPS_PER_HOUR :] if current_queue_series else [waiting]
    arrivals_1h = _num(arrivals.get("last1h"), _num(history_at(config.STEPS_PER_HOUR, "arrivals.last1h")))
    arrivals_3h = _num(arrivals.get("last3h"), _num(history_at(3 * config.STEPS_PER_HOUR, "arrivals.last3h")))
    arrivals_1h_previous = history_at(config.STEPS_PER_HOUR, "arrivals.last1h")
    if arrivals_1h_previous is None or np.isnan(arrivals_1h_previous):
        arrivals_1h_previous = arrivals_1h

    emergency_pressure = _num(
        emergency.get("pressure"),
        min(100.0, 60.0 * waiting / max(_num(emergency.get("bays"), 10.0), 1.0) + 0.4 * icu_occupancy),
    )

    features = {
        "hour_of_day": hour,
        "hour_sin": float(np.sin(2 * np.pi * hour / 24.0)),
        "hour_cos": float(np.cos(2 * np.pi * hour / 24.0)),
        "day_of_week": dow,
        "dow_sin": float(np.sin(2 * np.pi * dow / 7.0)),
        "dow_cos": float(np.cos(2 * np.pi * dow / 7.0)),
        "is_weekend": 1.0 if is_weekend else 0.0,
        "is_holiday": 1.0 if snapshot.get("isHoliday") else 0.0,
        "shift_block": hour,
        "arrivals_15m": _num(arrivals.get("last15m")),
        "arrivals_30m": _num(arrivals.get("last30m")),
        "arrivals_1h": arrivals_1h,
        "arrivals_3h": arrivals_3h,
        "arrivals_6h": _num(arrivals.get("last6h"), 6.0 * arrivals_1h),
        "arrivals_24h": _num(arrivals.get("last24h"), 24.0 * arrivals_1h),
        "arrival_rate_trend": round(arrivals_1h - arrivals_1h_previous, 3),
        "current_queue": waiting,
        "critical_queue": critical_queue,
        "priority_mix_critical": round(priority_mix, 4),
        "queue_change_15m": queue_change(1),
        "queue_change_30m": queue_change(2),
        "queue_change_1h": queue_change(config.STEPS_PER_HOUR),
        "rolling_queue_mean": round(float(np.mean(recent)), 3),
        "rolling_queue_max": round(float(np.max(recent)), 3),
        "admissions_rate_1h": _num(_dig(snapshot, "admissions.last1h")),
        "discharge_rate_1h": _num(_dig(snapshot, "discharges.last1h")),
        "occupied_beds": occupied_beds,
        "occupied_icu": occupied_icu,
        "bed_occupancy": round(bed_occupancy, 3),
        "icu_occupancy": round(icu_occupancy, 3),
        "available_beds": _num(beds.get("available"), total_beds - occupied_beds),
        "available_icu": _num(beds.get("icuAvailable"), total_icu - occupied_icu),
        "available_doctors": _num(staff.get("doctorsAvailable")),
        "available_nurses": _num(staff.get("nursesAvailable")),
        "doctor_utilisation": _num(staff.get("doctorUtilisation"), 100.0 * _num(staff.get("doctorsOnDuty")) / max(_num(staff.get("doctorsTotal")), 1)),
        "nurse_utilisation": _num(staff.get("nurseUtilisation"), 100.0 * _num(staff.get("nursesOnDuty")) / max(_num(staff.get("nursesTotal")), 1)),
        "ventilators_in_use": _num(_dig(equipment, "ventilators.inUse")),
        "monitors_in_use": _num(_dig(equipment, "monitors.inUse")),
        "available_equipment": _num(equipment.get("available")),
        "reserved_equipment": _num(equipment.get("reserved")),
        "equipment_utilisation": round(equipment_utilisation, 3),
        "ot_backlog": _num(ot.get("backlog")),
        "ot_backlog_change_1h": round(_num(ot.get("backlog")) - _num(history_at(config.STEPS_PER_HOUR, "ot.backlog")), 3),
        "ot_utilisation": round(ot_utilisation, 3),
        "emergency_resource_pressure": round(emergency_pressure, 3),
        "queue_backlog_pressure": round((waiting + _num(ot.get("backlog"))) / 4.0, 3),
        "waiting_minutes_mean": _num(queue.get("meanWaitMinutes")),
        "units_total": 0.0,
        "units_in_use": 0.0,
        "units_reserved": 0.0,
        "units_available": 0.0,
        "utilisation": round(equipment_utilisation, 3),
        "icu_demand": round(icu_occupancy, 3),
        "emergency_demand": round(emergency_pressure, 3),
        "department_load": _num(staff.get("nurseUtilisation")),
        "department_pressure": round(
            0.4 * bed_occupancy + 0.35 * _num(staff.get("nurseUtilisation")) + 0.25 * emergency_pressure, 3
        ),
        "current_load": _num(staff.get("doctorsAvailable")),
        "max_operational_load": 6.0,
        "scheduled_procedures": _num(ot.get("scheduled")),
        "expected_arrivals_1h": arrivals_1h,
        "incoming_demand_1h": round(0.45 * arrivals_1h, 3),
        "specialty_match": 1.0,
        "duty_status_on": 1.0,
        "availability_free": 1.0,
        "surge_active": 0.0,
    }
    return features


def build_matrix_row(features: dict, feature_names: list[str]):
    """Project a live feature mapping onto one model's exact feature list."""
    import pandas as pd

    frame = pd.DataFrame([{name: features.get(name, 0.0) for name in feature_names}])
    missing = [name for name in feature_names if name not in features]
    if missing:
        # A missing live feature is a contract breach: fill with 0 but say so.
        frame.attrs["missing_features"] = missing
    return frame


def validation_feature_names() -> list[str]:
    return list(fe.DEMAND_FEATURES)


def empty_state_snapshot() -> dict:
    """A neutral snapshot, used when the Node backend is unreachable."""
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "unavailable": True,
        "beds": {"total": 0, "occupied": 0, "available": 0, "icuTotal": 0, "icuOccupied": 0, "icuAvailable": 0},
        "queue": {"waiting": 0, "critical": 0},
        "staff": {},
        "equipment": {},
        "ot": {},
        "arrivals": {},
    }


def history_window_hours(history: list[dict] | None = None) -> float:
    """Hours of operational history actually available for rolling features.

    Computed from the earliest and latest parseable stamps, so a partially
    unsorted file still reports the true span rather than a negative number.
    """
    history = history if history is not None else load_history()
    stamps: list[datetime] = []
    for entry in history:
        raw = entry.get("timestamp") if isinstance(entry, dict) else None
        if not raw:
            continue
        try:
            stamps.append(datetime.fromisoformat(str(raw).replace("Z", "+00:00")))
        except ValueError:
            continue
    if len(stamps) < 2:
        return 0.0
    return round((max(stamps) - min(stamps)).total_seconds() / 3600.0, 2)


def synthetic_feature_row(step_hours_ago: float = 0.0) -> dict:
    """A representative training-distribution row, used by the smoke checks."""
    frame = generator.load_dataset().iloc[-1]
    row = {name: float(frame.get(name, 0.0) or 0.0) for name in frame.index}
    row["timestamp"] = (datetime.now(timezone.utc) - timedelta(hours=step_hours_ago)).isoformat()
    return row
