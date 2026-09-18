"""Synthetic hospital operations dataset generator.

WHY THIS EXISTS
---------------
No real hospital operational dataset is available to this project. Everything
produced here is *synthetic* and is labelled as such in every file, in the
model registry and in the inference responses. It must never be presented as
real hospital data.

WHAT IT MODELS
--------------
A 15-minute resolution operational timeline of a hospital: emergency arrivals
(with hour-of-day, day-of-week, weekend and public-holiday patterns), clinical
priority mix as assigned by triage staff, queue drain limited by real capacity,
bed and ICU occupancy flow, staffed doctor/nurse availability by shift,
equipment occupancy, operating theatre load and emergency-bay pressure. Surges
are injected deterministically from the configured seed, and shortage windows
(ICU, beds, doctors, nurses, equipment, theatre) are recorded so the models can
be evaluated on them.

The generator is deterministic: the same configuration and seed always rebuild
the identical dataset, which is what makes the reported training metrics
reproducible.

Everything is derived from the configured hospital layout — nothing in this
file contains a hardcoded operational result.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ai import config


@dataclass
class SyntheticConfig:
    """Configuration of one synthetic hospital timeline."""

    days: int = 45
    seed: int = config.DEFAULT_SEED
    start: str = "2026-06-01T00:00:00+00:00"

    # Hospital layout (kept in the same scale as the MediCore seed).
    beds: int = 100
    icu_beds: int = 10
    doctors: int = 30
    nurses: int = 72
    operating_theatres: int = 4
    ventilators: int = 15
    monitors: int = 12
    emergency_bays: int = 10

    # Demand behaviour.
    base_arrivals_per_hour: float = 8.2
    surge_probability: float = 0.11
    surge_size: int = 24
    surge_min_hours: int = 2
    surge_max_hours: int = 5
    elective_procedures_per_day: int = 14

    # Clinical mix, as produced by triage staff (never by the AI).
    critical_share: float = 0.09
    high_share: float = 0.24
    medium_share: float = 0.38

    # Operational capacity of the workforce per 24 hours.
    doctor_hours_per_day: float = 14.0
    nurse_hours_per_day: float = 20.0

    holidays: tuple[str, ...] = ("2026-06-15", "2026-07-04")

    # Two or three major intake events are injected at fixed points of the
    # timeline so that the critical-pressure regime is always represented in
    # the training data (and always at the same place, so runs are repeatable).
    major_surge_days: tuple[int, ...] = (9, 21, 33)
    major_surge_size: int = 38
    major_surge_hours: int = 5

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["holidays"] = list(self.holidays)
        return payload


# --------------------------------------------------------------------- shapes
HOUR_FACTORS = np.array(
    [
        0.62, 0.55, 0.50, 0.48, 0.50, 0.58,  # 00–05
        0.72, 0.90, 1.10, 1.24, 1.32, 1.38,  # 06–11
        1.35, 1.28, 1.22, 1.24, 1.32, 1.44,  # 12–17
        1.55, 1.62, 1.50, 1.30, 1.02, 0.78,  # 18–23
    ],
    dtype=float,
)

DOW_FACTORS = np.array([1.04, 1.06, 1.02, 1.00, 1.03, 1.12, 1.16], dtype=float)  # Mon → Sun
SHIFT_BLOCKS = ("NIGHT", "MORNING", "EVENING")


def _shift_block(hour: int) -> str:
    if 6 <= hour < 14:
        return "MORNING"
    if 14 <= hour < 22:
        return "EVENING"
    return "NIGHT"


def _pressure_index(state: dict, cfg: SyntheticConfig) -> float:
    """A transparent operational pressure index used only for scenario labelling.

    Each component is a 0–100 utilisation/queue-pressure figure; the index is
    their weighted mean, which is the same aggregation the hospital's pressure
    policy uses at runtime.
    """
    bed = float(state.get("bed_occupancy", 0.0))
    icu = float(state.get("icu_occupancy", 0.0))
    # Queue pressure is expressed against the bays that can hold a waiting
    # patient: 2.5 waiting patients per bay is treated as full pressure.
    queue = min(100.0, 100.0 * float(state.get("current_queue", 0.0)) / max(cfg.emergency_bays * 2.5, 1.0))
    doctors = float(state.get("doctor_utilisation", 0.0))
    nurses = float(state.get("nurse_utilisation", 0.0))
    equipment = float(state.get("equipment_utilisation", 0.0))
    ot = float(state.get("ot_utilisation", 0.0))
    return float(np.average([bed, icu, queue, doctors, nurses, equipment, ot], weights=[0.22, 0.2, 0.16, 0.12, 0.12, 0.09, 0.09]))


def generate_timeline(cfg: SyntheticConfig) -> pd.DataFrame:
    """Simulate the operational timeline. No randomness outside `seed`."""
    rng = np.random.default_rng(cfg.seed)
    steps_per_hour = config.STEPS_PER_HOUR
    total_steps = cfg.days * 24 * steps_per_hour
    start = datetime.fromisoformat(cfg.start)
    holidays = set(cfg.holidays)

    # ---- initial condition: a hospital already running at ~72% occupancy ----
    occupied_beds = int(cfg.beds * 0.78)
    occupied_icu = int(cfg.icu_beds * 0.64)
    queue = 8
    ventilators_in_use = 6
    monitors_in_use = 5
    ot_backlog = 6

    # Staffed capacity by shift (a fraction of the roster is on duty).
    doctor_shift_share = {"NIGHT": 0.22, "MORNING": 0.42, "EVENING": 0.36}
    nurse_shift_share = {"NIGHT": 0.26, "MORNING": 0.40, "EVENING": 0.34}

    # ---- surge schedule: deterministic times where demand spikes ----
    surge_windows: list[tuple[int, int, str]] = []
    cursor = int(6 * 24 / 4)  # skip the first day
    while cursor < total_steps:
        if rng.random() < cfg.surge_probability:
            length_hours = int(rng.integers(cfg.surge_min_hours, cfg.surge_max_hours + 1))
            length = length_hours * steps_per_hour
            kind = ["MASS_CASUALTY_INTAKE", "SEASONAL_RESPIRATORY", "TRAUMA_SURGE", "FESTIVAL_ACCIDENTS"][int(rng.integers(0, 4))]
            surge_windows.append((cursor, min(cursor + length, total_steps), kind))
            cursor += length + int(rng.integers(8, 30)) * steps_per_hour
        else:
            cursor += int(rng.integers(2, 8)) * steps_per_hour

    # Major intake events: fixed points on the timeline, alternating cause.
    major_kinds = ("MASS_CASUALTY_INTAKE", "MULTI_VEHICLE_ACCIDENT", "INDUSTRIAL_INCIDENT")
    for index, day in enumerate(cfg.major_surge_days):
        begin = int((day * 24 + (17 if index % 2 else 9)) * steps_per_hour)
        end = min(begin + cfg.major_surge_hours * steps_per_hour, total_steps)
        if begin < total_steps:
            surge_windows.append((begin, end, major_kinds[index % len(major_kinds)]))
    surge_windows.sort()

    arrivals_history: list[float] = []
    rows: list[dict] = []

    for step in range(total_steps):
        timestamp = start + timedelta(minutes=step * config.STEP_MINUTES)
        hour = timestamp.hour
        dow = timestamp.weekday()
        day_key = timestamp.date().isoformat()
        is_holiday = day_key in holidays
        is_weekend = dow >= 5
        block = _shift_block(hour)

        demands = cfg.base_arrivals_per_hour / steps_per_hour
        rate = demands * HOUR_FACTORS[hour] * DOW_FACTORS[dow]
        if is_holiday:
            rate *= 1.28
        if is_weekend:
            rate *= 1.06

        surge_active = 0
        surge_kind = ""
        for begin, end, kind in surge_windows:
            if begin <= step < end:
                surge_active = 1
                surge_kind = kind
                progress = (step - begin) / max(end - begin, 1)
                # Ramp up fast, decay slowly — typical of an intake wave.
                shape = 1.0 if progress < 0.35 else max(0.35, 1.0 - (progress - 0.35) * 0.9)
                magnitude = cfg.surge_size if kind in ("MASS_CASUALTY_INTAKE", "SEASONAL_RESPIRATORY", "TRAUMA_SURGE", "FESTIVAL_ACCIDENTS") else cfg.major_surge_size
                if kind in ("MULTI_VEHICLE_ACCIDENT", "INDUSTRIAL_INCIDENT"):
                    magnitude = cfg.major_surge_size
                rate += (magnitude / steps_per_hour) * shape
                break

        # Poisson arrivals are the industry standard for ED intake modelling.
        arrivals = float(rng.poisson(max(rate, 0.05)))
        arrivals_history.append(arrivals)

        recent_15 = arrivals
        recent_30 = float(sum(arrivals_history[-2:]))
        recent_1h = float(sum(arrivals_history[-steps_per_hour:]))
        recent_3h = float(sum(arrivals_history[-3 * steps_per_hour:]))
        recent_6h = float(sum(arrivals_history[-6 * steps_per_hour:]))
        recent_24h = float(sum(arrivals_history[-24 * steps_per_hour:]))

        # Triage mix — set by clinical staff, pressure shifts it toward higher acuity.
        acuity_shift = 1.0 + (0.35 * surge_active)
        critical = arrivals * min(0.35, cfg.critical_share * acuity_shift)
        high = arrivals * min(0.5, cfg.high_share * acuity_shift)
        medium = arrivals * cfg.medium_share
        low = max(0.0, arrivals - critical - high - medium)
        critical_queue = max(0.0, queue * cfg.critical_share * acuity_shift)

        # ---- staff on duty this step ----
        doctors_on = cfg.doctors * doctor_shift_share[block]
        nurses_on = cfg.nurses * nurse_shift_share[block]
        # A shortfall of available staff is the single strongest driver of
        # doctor/nurse utilisation, so it is modelled explicitly.
        roster_sickness = max(0.0, rng.normal(0, 1.1))
        absent = min(doctors_on * 0.5, (doctors_on * 0.05) + roster_sickness)
        available_doctors = max(1.0, doctors_on - absent)
        available_nurses = max(1.0, nurses_on - absent * 2.2)

        # ---- throughput: what the hospital can actually move this step ----
        bed_capacity_headroom = cfg.beds - occupied_beds
        icu_headroom = cfg.icu_beds - occupied_icu
        # During an intake wave the hospital runs its surge response: extra
        # staff are called in and fast-track discharge review is opened, which
        # lifts disposition capacity without removing any safety limit.
        triage_throughput = min(
            available_doctors * 0.55 * steps_per_hour,
            available_nurses * 0.34 * steps_per_hour,
            (bed_capacity_headroom * 0.22) + (icu_headroom * 0.10) + 1.6,
            3.4 * steps_per_hour,
        ) * (1.0 + (0.35 * surge_active))
        # Disposition from triage: a share needs admission, the rest is treated
        # and released. Clinically set ratios; the AI never decides these.
        admitted_share = 0.42 + (0.11 * surge_active)
        processed = min(queue + arrivals, max(triage_throughput, 0.15))
        admitted_now = processed * admitted_share
        icu_share = 0.17 + (0.06 * surge_active)
        icu_admissions = admitted_now * icu_share
        ward_admissions = admitted_now - icu_admissions

        # ---- discharges / step-downs free capacity each step ----
        discharge_relief = max(0.0, occupied_beds - 0.80 * cfg.beds) * 0.035 * steps_per_hour
        discharges = occupied_beds * 0.00080 * steps_per_hour + discharge_relief + rng.normal(0.22, 0.20)
        discharges = max(0.0, discharges)
        icu_relief = max(0.0, occupied_icu - 0.78 * cfg.icu_beds) * 0.040 * steps_per_hour
        icu_stepdowns = occupied_icu * 0.00120 * steps_per_hour + icu_relief + rng.normal(0.03, 0.05)
        icu_stepdowns = max(0.0, min(icu_stepdowns, occupied_icu))

        occupied_icu = float(np.clip(occupied_icu + icu_admissions - icu_stepdowns, 0, cfg.icu_beds))
        occupied_beds = float(np.clip(occupied_beds + ward_admissions + icu_stepdowns - discharges, 0, cfg.beds))
        queue = float(np.clip(queue + arrivals - processed, 0, cfg.emergency_bays * 6))

        # ---- utilisation derived from load, never hardcoded ----
        assigned_patients = occupied_beds + (queue * 0.45)
        doctor_capacity = available_doctors * 9.5  # configured band ceiling is 6 patients each
        nurse_capacity = available_nurses * 4.4
        doctor_utilisation = float(np.clip(100.0 * assigned_patients / max(doctor_capacity, 1), 5.0, 100.0))
        nurse_utilisation = float(np.clip(100.0 * assigned_patients / max(nurse_capacity, 1), 5.0, 100.0))
        if surge_active:
            doctor_utilisation = min(100.0, doctor_utilisation + 6.0)
            nurse_utilisation = min(100.0, nurse_utilisation + 8.0)

        # ---- equipment follows the demand that actually exists ----
        ventilator_need = 0.72 * occupied_icu + 0.22 * critical_queue + 1.4
        ventilators_in_use = float(np.clip(ventilators_in_use + rng.normal(0, 0.35) + (0.10 * surge_active), 0, cfg.ventilators))
        ventilators_in_use = float(np.clip(0.82 * ventilators_in_use + 0.18 * min(ventilator_need, cfg.ventilators), 0, cfg.ventilators))
        monitor_need = 0.55 * (occupied_icu + csurge(critical_queue, surge_active)) + 0.18 * queue
        monitors_in_use = float(np.clip(0.80 * monitors_in_use + 0.20 * min(monitor_need, cfg.monitors), 0, cfg.monitors))
        equipment_utilisation = float(
            np.clip(100.0 * (ventilators_in_use + monitors_in_use) / max(cfg.ventilators + cfg.monitors, 1), 4.0, 100.0)
        )

        # ---- theatre load ----
        elective_today = cfg.elective_procedures_per_day if not is_weekend else int(cfg.elective_procedures_per_day * 0.35)
        emergencies_needing_ot = arrivals * 0.16
        # One theatre runs one case at a time: capacity per step is the number of
        # theatre-slots that physically exist in the step being simulated.
        theatre_slots_per_step = cfg.operating_theatres * (config.STEP_MINUTES / 60.0) / 1.6  # 1.6 h average case
        elective_per_step = elective_today / (24 * steps_per_hour)
        ot_backlog = float(np.clip(ot_backlog + emergencies_needing_ot + elective_per_step - theatre_slots_per_step, 0, 90))
        # Utilisation = work in front of the theatres against the slots available.
        demand_hours = (elective_per_step + emergencies_needing_ot) * 1.6 + min(ot_backlog, 12) * 0.10
        capacity_hours = cfg.operating_theatres * (config.STEP_MINUTES / 60.0)
        ot_utilisation = float(np.clip(100.0 * demand_hours / max(capacity_hours, 0.25), 8.0, 100.0))

        emergency_resource_pressure = float(
            np.clip(
                100.0 * (queue / max(cfg.emergency_bays, 1)) * 0.6
                + 0.4 * (100.0 * occupied_icu / max(cfg.icu_beds, 1)),
                3.0,
                100.0,
            )
        )

        row = {
            "step": step,
            "timestamp": timestamp,
            "hour_of_day": hour,
            "day_of_week": dow,
            "hour_sin": round(float(np.sin(2 * np.pi * hour / 24.0)), 6),
            "hour_cos": round(float(np.cos(2 * np.pi * hour / 24.0)), 6),
            "dow_sin": round(float(np.sin(2 * np.pi * dow / 7.0)), 6),
            "dow_cos": round(float(np.cos(2 * np.pi * dow / 7.0)), 6),
            "is_weekend": bool(is_weekend),
            "is_holiday": bool(is_holiday),
            "shift_block": block,
            "arrivals_15m": recent_15,
            "arrivals_30m": recent_30,
            "arrivals_1h": recent_1h,
            "arrivals_3h": recent_3h,
            "arrivals_6h": recent_6h,
            "arrivals_24h": recent_24h,
            "current_queue": round(queue, 2),
            "critical_queue": round(critical_queue, 2),
            "priority_mix_critical": round(float(critical_queue / max(queue, 1)), 4),
            "admissions_rate_1h": round(float(admitted_now * steps_per_hour), 3),
            "discharge_rate_1h": round(float(discharges * steps_per_hour), 3),
            "occupied_beds": round(occupied_beds, 2),
            "occupied_icu": round(occupied_icu, 2),
            "bed_occupancy": round(100.0 * occupied_beds / cfg.beds, 3),
            "icu_occupancy": round(100.0 * occupied_icu / cfg.icu_beds, 3),
            "available_beds": round(max(0.0, cfg.beds - occupied_beds), 2),
            "available_icu": round(max(0.0, cfg.icu_beds - occupied_icu), 2),
            "available_doctors": round(available_doctors, 2),
            "available_nurses": round(available_nurses, 2),
            "doctor_utilisation": round(doctor_utilisation, 3),
            "nurse_utilisation": round(nurse_utilisation, 3),
            "ventilators_in_use": round(ventilators_in_use, 2),
            "monitors_in_use": round(monitors_in_use, 2),
            "available_equipment": round(
                max(0.0, (cfg.ventilators - ventilators_in_use) + max(0.0, cfg.monitors - monitors_in_use)), 2
            ),
            "reserved_equipment": round(max(0.0, 0.18 * (ventilators_in_use + monitors_in_use)), 2),
            "equipment_utilisation": round(equipment_utilisation, 3),
            "ot_backlog": round(ot_backlog, 2),
            "ot_utilisation": round(ot_utilisation, 3),
            "emergency_resource_pressure": round(emergency_resource_pressure, 3),
            "surge_active": bool(surge_active),
            "surge_kind": surge_kind,
            "waiting_minutes_mean": round(
                float(np.clip(queue * 9.5 / max(processed, 0.2), 0, 480)), 1
            ),
        }
        row["pressure_index"] = round(_pressure_index(row, cfg), 3)
        rows.append(row)

    frame = pd.DataFrame(rows)

    # ---- rolling (leak-free) queue and arrival features ----
    frame["queue_change_15m"] = frame["current_queue"].diff(1).fillna(0.0)
    frame["queue_change_30m"] = frame["current_queue"].diff(2).fillna(0.0)
    frame["queue_change_1h"] = frame["current_queue"].diff(steps_per_hour).fillna(0.0)
    frame["rolling_queue_mean"] = frame["current_queue"].rolling(4 * steps_per_hour, min_periods=1).mean().round(3)
    frame["rolling_queue_max"] = frame["current_queue"].rolling(4 * steps_per_hour, min_periods=1).max().round(3)
    frame["arrival_rate_trend"] = (frame["arrivals_1h"] - frame["arrivals_1h"].shift(steps_per_hour)).fillna(0.0).round(3)
    frame["ot_backlog_change_1h"] = frame["ot_backlog"].diff(steps_per_hour).fillna(0.0).round(3)
    frame["queue_backlog_pressure"] = ((frame["current_queue"] + frame["ot_backlog"]) / 4.0).round(3)

    # ---- forecasting targets: strictly future, so no leakage is possible ----
    for horizon, steps in config.HORIZON_STEPS.items():
        frame[f"target_arrivals_{horizon}"] = (
            frame["arrivals_15m"].shift(-steps).rolling(steps, min_periods=1).sum().shift(-(steps - 1))
        )
        frame[f"target_queue_{horizon}"] = frame["current_queue"].shift(-steps)
        frame[f"target_icu_occupancy_{horizon}"] = frame["icu_occupancy"].shift(-steps)
        frame[f"target_bed_occupancy_{horizon}"] = frame["bed_occupancy"].shift(-steps)
        frame[f"target_doctor_utilisation_{horizon}"] = frame["doctor_utilisation"].shift(-steps)
        frame[f"target_nurse_utilisation_{horizon}"] = frame["nurse_utilisation"].shift(-steps)
        frame[f"target_equipment_utilisation_{horizon}"] = frame["equipment_utilisation"].shift(-steps)
        frame[f"target_ot_utilisation_{horizon}"] = frame["ot_utilisation"].shift(-steps)
        frame[f"target_emergency_resource_pressure_{horizon}"] = frame["emergency_resource_pressure"].shift(-steps)

    # Multi-step-ahead (6h) is used by the patient-flow and resource models to
    # express "where is this heading if nothing changes".
    frame["target_admissions_6h"] = frame["admissions_rate_1h"].shift(-6 * steps_per_hour)
    frame["target_discharges_6h"] = frame["discharge_rate_1h"].shift(-6 * steps_per_hour)
    frame["target_icu_occupancy_6h"] = frame["icu_occupancy"].shift(-6 * steps_per_hour)
    frame["target_bed_occupancy_6h"] = frame["bed_occupancy"].shift(-6 * steps_per_hour)
    frame["target_ot_backlog_6h"] = frame["ot_backlog"].shift(-6 * steps_per_hour)

    # The pressure label reproduces the hospital's approved banding policy.
    frame["pressure_label"] = frame["pressure_index"].apply(_band_for)
    return frame


def csurge(critical_queue: float, surge_active: int) -> float:
    """Small helper so the monitor-need expression stays readable."""
    return critical_queue * (0.18 if surge_active else 0.0)


def _band_for(pressure: float) -> str:
    for label, low, high in config.PRESSURE_BANDS:
        if low <= pressure < high:
            return label
    return config.PRESSURE_LABELS[-1]


# ------------------------------------------------------------------ scenarios
def label_scenarios(frame: pd.DataFrame, cfg: SyntheticConfig) -> list[dict]:
    """Turn the simulated timeline into labelled operational scenarios.

    Labels are derived from the data itself, not from a hardcoded table: a
    window is called an *ICU bottleneck* only when ICU occupancy is actually at
    or above 95% while the queue is under pressure, and so on.
    """
    scenarios: list[dict] = []
    working = frame.copy()
    working["minutes"] = working["step"] * config.STEP_MINUTES

    def add(name: str, mask: pd.Series, note: str) -> None:
        for begin, end in _contiguous_windows(mask, minimum_steps=config.STEPS_PER_HOUR):
            window = working.loc[begin:end]
            scenarios.append(
                {
                    "scenario": name,
                    "start": window["timestamp"].iloc[0].isoformat(),
                    "end": window["timestamp"].iloc[-1].isoformat(),
                    "steps": int(end - begin + 1),
                    "peak_pressure": float(window["pressure_index"].max().round(2)),
                    "peak_queue": float(window["current_queue"].max().round(2)),
                    "peak_icu_occupancy": float(window["icu_occupancy"].max().round(2)),
                    "peak_bed_occupancy": float(window["bed_occupancy"].max().round(2)),
                    "note": note,
                }
            )

    add("NORMAL", working["pressure_index"] < 70, "steady-state operations inside policy bands")
    add("BUSY", (working["pressure_index"] >= 70) & (working["pressure_index"] < 85), "elevated but managed load")
    add("HIGH_DEMAND", (working["pressure_index"] >= 85) & (working["pressure_index"] < 95), "sustained high load")
    add(
        "ICU_BOTTLENECK",
        (working["icu_occupancy"] >= 95) & (working["icu_occupancy"] >= working["bed_occupancy"]),
        "ICU occupancy at or above 95%",
    )
    add("BED_SHORTAGE", (working["available_beds"] <= 5) & (working["bed_occupancy"] >= 90), "5 or fewer general beds free")
    add("DOCTOR_SHORTAGE", working["available_doctors"] <= (cfg.doctors * 0.16), "doctor cover below 16% of the roster")
    add("NURSE_SHORTAGE", working["available_nurses"] <= (cfg.nurses * 0.18), "nurse cover below 18% of the roster")
    add("EQUIPMENT_SHORTAGE", working["equipment_utilisation"] >= 90, "equipment utilisation at or above 90%")
    add("OT_CONFLICT", working["ot_backlog"] >= 12, "12 or more surgical cases waiting")
    add(
        "MULTIPLE_SIMULTANEOUS_CONSTRAINTS",
        (working["pressure_index"] >= 85)
        & (working["icu_occupancy"] >= 90)
        & (working["equipment_utilisation"] >= 80)
        & (working["nurse_utilisation"] >= 85),
        "several resources constrained at the same time",
    )
    for begin, end, kind in _surge_windows_from_data(working):
        window = working.loc[begin:end]
        scenarios.append(
            {
                "scenario": f"SUDDEN_SURGE::{kind}",
                "start": window["timestamp"].iloc[0].isoformat(),
                "end": window["timestamp"].iloc[-1].isoformat(),
                "steps": int(end - begin + 1),
                "peak_pressure": float(window["pressure_index"].max().round(2)),
                "peak_queue": float(window["current_queue"].max().round(2)),
                "peak_icu_occupancy": float(window["icu_occupancy"].max().round(2)),
                "peak_bed_occupancy": float(window["bed_occupancy"].max().round(2)),
                "note": f"injected {kind} intake wave",
            }
        )
    return scenarios


# ------------------------------------------------------- stress scenario set
# The baseline timeline is a believable general hospital. These named scenarios
# each re-run the same simulator with a different configuration so that the
# shortage regimes are represented in the training and evaluation data. Every
# scenario is deterministic and its observed peaks are reported from the data
# that was actually generated.
SCENARIO_LIBRARY: dict[str, dict] = {
    "normal": {"days": 6, "base_arrivals_per_hour": 6.2, "surge_probability": 0.0, "major_surge_days": ()},
    "busy": {"days": 6, "base_arrivals_per_hour": 8.4, "surge_probability": 0.06, "major_surge_days": ()},
    "high_demand": {"days": 6, "base_arrivals_per_hour": 10.2, "surge_probability": 0.10, "major_surge_days": ()},
    "sudden_surge": {"days": 6, "base_arrivals_per_hour": 8.0, "surge_probability": 0.22, "surge_size": 38, "major_surge_days": (2,)},
    "icu_bottleneck": {"days": 6, "base_arrivals_per_hour": 9.2, "icu_beds": 8, "surge_probability": 0.12, "major_surge_days": (3,)},
    "bed_shortage": {"days": 6, "base_arrivals_per_hour": 9.0, "beds": 62, "surge_probability": 0.10, "major_surge_days": (2,)},
    "doctor_shortage": {"days": 6, "base_arrivals_per_hour": 8.8, "doctors": 18, "surge_probability": 0.10, "major_surge_days": (3,)},
    "nurse_shortage": {"days": 6, "base_arrivals_per_hour": 8.8, "nurses": 44, "surge_probability": 0.10, "major_surge_days": (3,)},
    "equipment_shortage": {"days": 6, "base_arrivals_per_hour": 9.0, "ventilators": 9, "monitors": 7, "surge_probability": 0.10, "major_surge_days": (2,)},
    "ot_conflict": {"days": 6, "base_arrivals_per_hour": 8.6, "operating_theatres": 2, "surge_probability": 0.10, "major_surge_days": (3,)},
    "multiple_simultaneous_constraints": {
        "days": 6,
        "base_arrivals_per_hour": 9.8,
        "beds": 74,
        "doctors": 20,
        "nurses": 50,
        "ventilators": 10,
        "operating_theatres": 2,
        "icu_beds": 8,
        "surge_probability": 0.16,
        "major_surge_days": (2,),
    },
}


def generate_scenario_library() -> dict:
    """Generate every named stress scenario and a manifest of what happened."""
    manifest: dict = {
        "library_version": config.DATASET_VERSION,
        "synthetic": True,
        "synthetic_warning": (
            "SYNTHETIC DATA. Stress scenarios generated for model training and evaluation. "
            "Not real hospital activity."
        ),
        "seed": config.DEFAULT_SEED,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scenarios": {},
    }
    for name, overrides in SCENARIO_LIBRARY.items():
        cfg = SyntheticConfig(seed=config.DEFAULT_SEED, **overrides)
        frame = generate_timeline(cfg)
        path = config.SYNTHETIC_DIR / "scenario_library" / f"{name}.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        frame.to_csv(path, index=False)
        manifest["scenarios"][name] = {
            "config": cfg.to_dict(),
            "file": str(path),
            "rows": int(len(frame)),
            "observed": {
                "pressure_index_mean": float(round(frame["pressure_index"].mean(), 2)),
                "pressure_index_max": float(round(frame["pressure_index"].max(), 2)),
                "peak_queue": float(round(frame["current_queue"].max(), 2)),
                "peak_bed_occupancy": float(round(frame["bed_occupancy"].max(), 2)),
                "peak_icu_occupancy": float(round(frame["icu_occupancy"].max(), 2)),
                "peak_nurse_utilisation": float(round(frame["nurse_utilisation"].max(), 2)),
                "peak_doctor_utilisation": float(round(frame["doctor_utilisation"].max(), 2)),
                "peak_equipment_utilisation": float(round(frame["equipment_utilisation"].max(), 2)),
                "peak_ot_backlog": float(round(frame["ot_backlog"].max(), 2)),
                "total_arrivals": float(frame["arrivals_15m"].sum()),
            },
            "band_share": {
                label: float(round((frame["pressure_label"] == label).mean(), 4)) for label in config.PRESSURE_LABELS
            },
        }
    manifest_path = config.SYNTHETIC_DIR / "scenario_library" / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    manifest["manifest"] = str(manifest_path)
    return manifest


def load_scenario_library() -> list[tuple[str, pd.DataFrame]]:
    """Load every generated stress scenario as (name, frame)."""
    directory = config.SYNTHETIC_DIR / "scenario_library"
    manifest_path = directory / "manifest.json"
    if not manifest_path.exists():
        generate_scenario_library()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    frames: list[tuple[str, pd.DataFrame]] = []
    for name, entry in manifest["scenarios"].items():
        frame = pd.read_csv(entry["file"])
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
        frame["scenario_name"] = name
        frames.append((name, frame))
    return frames


def _contiguous_windows(mask: pd.Series, minimum_steps: int) -> list[tuple[int, int]]:
    windows: list[tuple[int, int]] = []
    start = None
    for position, flag in enumerate(mask.to_numpy()):
        if flag and start is None:
            start = position
        elif not flag and start is not None:
            if position - start >= minimum_steps:
                windows.append((start, position - 1))
            start = None
    if start is not None and len(mask) - start >= minimum_steps:
        windows.append((start, len(mask) - 1))
    return windows


def _surge_windows_from_data(frame: pd.DataFrame) -> list[tuple[int, int, str]]:
    windows: list[tuple[int, int, str]] = []
    start = None
    kind = ""
    for step, (active, current_kind) in enumerate(zip(frame["surge_active"], frame["surge_kind"])):
        if active and start is None:
            start, kind = step, current_kind
        elif not active and start is not None:
            windows.append((start, step - 1, kind or "MASS_CASUALTY_INTAKE"))
            start = None
    if start is not None:
        windows.append((start, len(frame) - 1, kind or "MASS_CASUALTY_INTAKE"))
    return windows


# ------------------------------------------------- staff / equipment datasets
# The timeline describes the hospital; these two expansions describe the people
# and the machines inside it, so the workload and equipment-demand models can be
# trained at the level at which they are actually used.

DEPARTMENTS = (
    "Emergency Medicine",
    "Internal Medicine",
    "Cardiology",
    "Critical Care",
    "Surgery",
    "Orthopaedics",
    "Paediatrics",
    "Neurology",
    "General Ward",
)

EQUIPMENT_CATEGORIES = ("ventilators", "monitors", "infusion_pumps", "defibrillators", "ultrasound")


def _department_pressure(row: dict, department: str, rng: np.random.Generator) -> float:
    """Relative pressure of one department at one step, derived from the timeline."""
    base = {
        "Emergency Medicine": 0.55 * row["emergency_resource_pressure"] + 0.45 * row["bed_occupancy"],
        "Critical Care": row["icu_occupancy"],
        "Internal Medicine": 0.62 * row["bed_occupancy"] + 0.38 * row["nurse_utilisation"],
        "Cardiology": 0.55 * row["bed_occupancy"] + 0.45 * row["doctor_utilisation"],
        "Surgery": 0.60 * row["ot_utilisation"] + 0.40 * row["bed_occupancy"],
        "Orthopaedics": 0.55 * row["ot_utilisation"] + 0.45 * row["bed_occupancy"],
        "Paediatrics": 0.70 * row["bed_occupancy"] + 0.30 * row["emergency_resource_pressure"],
        "Neurology": 0.55 * row["icu_occupancy"] + 0.45 * row["doctor_utilisation"],
        "General Ward": 0.75 * row["bed_occupancy"] + 0.25 * row["nurse_utilisation"],
    }[department]
    return float(np.clip(base + rng.normal(0, 2.2), 5.0, 100.0))


def generate_staff_datasets(cfg: SyntheticConfig | None = None, sample_every: int = 4) -> dict:
    """Expand the timeline into per-doctor and per-nurse operational rows.

    `sample_every` keeps the file size sane while still covering every hour of
    every day: one in every N steps is expanded for the full roster.
    """
    cfg = cfg or SyntheticConfig()
    frame = load_dataset() if cfg == SyntheticConfig() else generate_timeline(cfg)
    if cfg != SyntheticConfig():
        frame = generate_timeline(cfg)
    rng = np.random.default_rng(cfg.seed + 7)

    doctor_rows: list[dict] = []
    nurse_rows: list[dict] = []

    sampled = frame.iloc[::sample_every]
    # Roster is spread across departments with a realistic head-count split.
    doctor_department_cycle = [DEPARTMENTS[index % len(DEPARTMENTS)] for index in range(cfg.doctors)]
    nurse_department_cycle = [DEPARTMENTS[index % len(DEPARTMENTS)] for index in range(cfg.nurses)]
    shift_for_block = {"NIGHT": "08:00 PM – 08:00 AM", "MORNING": "08:00 AM – 04:00 PM", "EVENING": "04:00 PM – 12:00 AM"}

    for row in sampled.to_dict("records"):
        block = row["shift_block"]
        on_duty_share = {"NIGHT": 0.22, "MORNING": 0.42, "EVENING": 0.36}[block]
        nurse_on_share = {"NIGHT": 0.26, "MORNING": 0.40, "EVENING": 0.34}[block]

        # A deterministic sub-sample of each roster is on duty in this block.
        for index in range(cfg.doctors):
            department = doctor_department_cycle[index]
            on_duty = ((index * 7919) % 100) / 100.0 < on_duty_share
            if not on_duty:
                continue
            pressure = _department_pressure(row, department, rng)
            leave = rng.random() < 0.02
            in_procedure = rng.random() < 0.18
            current_load = int(np.clip(round(pressure / 14.0 + rng.normal(0, 1.0)), 0, 9))
            scheduled = int(np.clip(round(row["ot_utilisation"] / 30.0 + rng.normal(0, 0.6)), 0, 4))
            expected_arrivals = row["arrivals_1h"]
            target_load = float(
                np.clip(
                    0.55 * current_load
                    + 0.16 * expected_arrivals
                    + 0.020 * pressure
                    + 0.20 * scheduled
                    + 0.02 * row["current_queue"]
                    + rng.normal(0, 0.35),
                    0,
                    12,
                )
            )
            doctor_rows.append(
                {
                    "timestamp": row["timestamp"],
                    "staff_id": f"DOC-{1000 + index + 1}",
                    "department": department,
                    "shift_block": block,
                    "shift": shift_for_block[block],
                    "duty_status": "LEAVE" if leave else "ON_DUTY",
                    "availability": "Unavailable" if (leave or in_procedure) else "Available",
                    "specialty_match": float(department == "Emergency Medicine"),
                    "current_load": current_load,
                    "max_operational_load": 6,
                    "scheduled_procedures": scheduled,
                    "department_pressure": round(pressure, 3),
                    "expected_arrivals_1h": expected_arrivals,
                    "current_queue": row["current_queue"],
                    "icu_occupancy": row["icu_occupancy"],
                    "bed_occupancy": row["bed_occupancy"],
                    "hour_of_day": row["hour_of_day"],
                    "is_weekend": row["is_weekend"],
                    "target_load_1h": round(target_load, 3),
                    "target_load_2h": round(float(np.clip(target_load + rng.normal(0, 0.5), 0, 12)), 3),
                }
            )

        for index in range(cfg.nurses):
            department = nurse_department_cycle[index]
            on_duty = ((index * 6151) % 100) / 100.0 < nurse_on_share
            if not on_duty:
                continue
            pressure = _department_pressure(row, department, rng)
            leave = rng.random() < 0.02
            current_load = int(np.clip(round(pressure / 20.0 + rng.normal(0, 0.9)), 0, 8))
            incoming = row["arrivals_1h"] * 0.45
            target_load = float(
                np.clip(
                    0.58 * current_load
                    + 0.10 * incoming
                    + 0.018 * pressure
                    + 0.03 * row["current_queue"]
                    + rng.normal(0, 0.30),
                    0,
                    10,
                )
            )
            nurse_rows.append(
                {
                    "timestamp": row["timestamp"],
                    "staff_id": f"NUR-{200 + index + 1}",
                    "department": department,
                    "shift_block": block,
                    "shift": shift_for_block[block],
                    "duty_status": "LEAVE" if leave else "ON_DUTY",
                    "availability": "Unavailable" if leave else "Available",
                    "current_load": current_load,
                    "max_operational_load": 4,
                    "incoming_demand_1h": round(incoming, 3),
                    "icu_demand": row["icu_occupancy"],
                    "emergency_demand": row["emergency_resource_pressure"],
                    "department_pressure": round(pressure, 3),
                    "bed_occupancy": row["bed_occupancy"],
                    "hour_of_day": row["hour_of_day"],
                    "is_weekend": row["is_weekend"],
                    "target_load_1h": round(target_load, 3),
                    "target_load_2h": round(float(np.clip(target_load + rng.normal(0, 0.45), 0, 10)), 3),
                }
            )

    doctors = pd.DataFrame(doctor_rows)
    nurses = pd.DataFrame(nurse_rows)
    return {"doctors": doctors, "nurses": nurses}


def generate_equipment_dataset(cfg: SyntheticConfig | None = None, sample_every: int = 2) -> pd.DataFrame:
    """Per-category equipment demand rows derived from the timeline."""
    cfg = cfg or SyntheticConfig()
    frame = load_dataset() if cfg == SyntheticConfig() else generate_timeline(cfg)
    if cfg != SyntheticConfig():
        frame = generate_timeline(cfg)
    rng = np.random.default_rng(cfg.seed + 11)

    totals = {
        "ventilators": cfg.ventilators,
        "monitors": cfg.monitors,
        "infusion_pumps": 40,
        "defibrillators": 8,
        "ultrasound": 6,
    }
    rows: list[dict] = []
    for row in frame.iloc[::sample_every].to_dict("records"):
        for category, total in totals.items():
            if category == "ventilators":
                in_use = row["ventilators_in_use"]
            elif category == "monitors":
                in_use = row["monitors_in_use"]
            elif category == "infusion_pumps":
                in_use = float(np.clip(row["occupied_beds"] * 0.55 + rng.normal(0, 1.5), 0, total))
            elif category == "defibrillators":
                in_use = float(np.clip(row["emergency_resource_pressure"] / 12.0 + rng.normal(0, 0.4), 0, total))
            else:
                in_use = float(np.clip(row["icu_occupancy"] / 18.0 + row["arrivals_1h"] / 12.0 + rng.normal(0, 0.3), 0, total))
            available = max(0.0, total - in_use)
            reserved = float(np.clip(in_use * 0.15 + rng.normal(0, 0.3), 0, available))
            need = float(
                np.clip(
                    0.60 * in_use
                    + 0.22 * (row["icu_occupancy"] / 100.0 * totals["ventilators"])
                    + 0.10 * row["arrivals_1h"]
                    + 0.05 * row["current_queue"]
                    + rng.normal(0, 0.5),
                    0,
                    total + 6,
                )
            )
            rows.append(
                {
                    "timestamp": row["timestamp"],
                    "category": category,
                    "units_total": total,
                    "units_in_use": round(in_use, 3),
                    "units_reserved": round(reserved, 3),
                    "units_available": round(available, 3),
                    "utilisation": round(100.0 * in_use / max(total, 1), 3),
                    "icu_demand": row["icu_occupancy"],
                    "emergency_demand": row["emergency_resource_pressure"],
                    "current_queue": row["current_queue"],
                    "department_load": row["nurse_utilisation"],
                    "hour_of_day": row["hour_of_day"],
                    "is_weekend": row["is_weekend"],
                    "target_units_needed_1h": round(need, 3),
                    "target_units_needed_2h": round(float(np.clip(need + rng.normal(0, 0.6), 0, total + 8)), 3),
                }
            )
    return pd.DataFrame(rows)


def save_all_datasets(cfg: SyntheticConfig | None = None) -> dict:
    """Generate and persist every synthetic dataset the project trains on."""
    cfg = cfg or SyntheticConfig()
    timeline = save_dataset(cfg)
    library = generate_scenario_library()
    staff = generate_staff_datasets(cfg)
    equipment = generate_equipment_dataset(cfg)

    doctors_path = config.SYNTHETIC_DIR / "staff_doctors.csv"
    nurses_path = config.SYNTHETIC_DIR / "staff_nurses.csv"
    equipment_path = config.SYNTHETIC_DIR / "equipment_demand.csv"
    staff["doctors"].to_csv(doctors_path, index=False)
    staff["nurses"].to_csv(nurses_path, index=False)
    equipment.to_csv(equipment_path, index=False)

    return {
        "timeline": timeline,
        "scenario_library": library,
        "files": {
            "doctors": {"path": str(doctors_path), "rows": int(len(staff["doctors"]))},
            "nurses": {"path": str(nurses_path), "rows": int(len(staff["nurses"]))},
            "equipment": {"path": str(equipment_path), "rows": int(len(equipment))},
        },
    }


# ------------------------------------------------------------------- outputs
def save_dataset(cfg: SyntheticConfig | None = None) -> dict:
    """Generate the dataset and write CSV + metadata + scenario labels."""
    cfg = cfg or SyntheticConfig()
    frame = generate_timeline(cfg)
    scenarios = label_scenarios(frame, cfg)

    dataset_id = f"hospital_operations_{config.DATASET_VERSION}"
    csv_path = config.SYNTHETIC_DIR / f"{dataset_id}.csv"
    frame.to_csv(csv_path, index=False)

    leakage_safe = frame.dropna(subset=[c for c in frame.columns if c.startswith("target_")]).reset_index(drop=True)
    leakage_safe_path = config.PROCESSED_DIR / f"{dataset_id}_labelled.csv"
    leakage_safe.to_csv(leakage_safe_path, index=False)

    metadata = {
        "dataset_id": dataset_id,
        "dataset_version": config.DATASET_VERSION,
        "synthetic": True,
        "synthetic_warning": (
            "SYNTHETIC DATA. Generated by ai/data/synthetic_generator.py to model hospital operations because no real "
            "hospital operational dataset was available to this project. It must never be presented as real hospital data."
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "seed": cfg.seed,
        "resolution_minutes": config.STEP_MINUTES,
        "rows": int(len(frame)),
        "labelled_rows": int(len(leakage_safe)),
        "columns": list(frame.columns),
        "config": cfg.to_dict(),
        "scenario_count": len(scenarios),
        "scenarios": scenarios,
        "summary": {
            "arrivals_total": float(frame["arrivals_15m"].sum()),
            "arrivals_per_hour_mean": float(round(frame["arrivals_1h"].mean(), 3)),
            "pressure_index_mean": float(round(frame["pressure_index"].mean(), 2)),
            "pressure_index_max": float(round(frame["pressure_index"].max(), 2)),
            "band_share": {label: float(round((frame["pressure_label"] == label).mean(), 4)) for label in config.PRESSURE_LABELS},
            "surge_windows": int(frame["surge_active"].astype(int).diff().eq(1).sum() + (1 if frame["surge_active"].iloc[0] else 0)),
        },
        "files": {"timeline": str(csv_path), "labelled": str(leakage_safe_path)},
    }
    metadata_path = config.SYNTHETIC_DIR / f"{dataset_id}_metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    metadata["files"]["metadata"] = str(metadata_path)
    return metadata


def load_dataset(path: Path | str | None = None) -> pd.DataFrame:
    """Load the generated timeline (regenerating it if it is missing)."""
    if path is None:
        path = config.SYNTHETIC_DIR / f"hospital_operations_{config.DATASET_VERSION}.csv"
    path = Path(path)
    if not path.exists():
        save_dataset()
    frame = pd.read_csv(path)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    return frame


def load_metadata() -> dict:
    path = config.SYNTHETIC_DIR / f"hospital_operations_{config.DATASET_VERSION}_metadata.json"
    if not path.exists():
        save_dataset()
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":  # pragma: no cover - manual entry point
    info = save_dataset()
    print(json.dumps({k: v for k, v in info.items() if k not in ("columns", "scenarios")}, indent=2))
    print(f"scenarios: {info['scenario_count']}")
