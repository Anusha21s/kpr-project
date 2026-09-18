"""Shared configuration for the MediCore HE-02 AI layer.

Everything the models need to agree on lives here: paths, versions, the
approved operational pressure bands, the training seed and the human-readable
labels used when a prediction is explained back to hospital staff.

Nothing in this package makes a clinical decision. The AI layer forecasts
operational load, detects operational anomalies, classifies operational
pressure and feeds the constraint optimizer. Clinical priority always comes
from authorised clinical staff.
"""

from pathlib import Path

AI_ROOT = Path(__file__).resolve().parent

# ---------------------------------------------------------------- file layout
DATA_DIR = AI_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
SYNTHETIC_DIR = DATA_DIR / "synthetic"
PROCESSED_DIR = DATA_DIR / "processed"
FEATURES_DIR = DATA_DIR / "features"
MODELS_DIR = AI_ROOT / "models"
REGISTRY_DIR = AI_ROOT / "registry"
REPORTS_DIR = AI_ROOT / "reports"

for _directory in (RAW_DIR, SYNTHETIC_DIR, PROCESSED_DIR, FEATURES_DIR, MODELS_DIR, REGISTRY_DIR, REPORTS_DIR):
    _directory.mkdir(parents=True, exist_ok=True)

# ------------------------------------------------------------------- versions
FEATURE_VERSION = "features_v2"  # v2 added cyclical time encodings + OT backlog trend; bumping this invalidates older artifacts on purpose
MODEL_VERSION = "1.0.0"
DATASET_VERSION = "synthetic_hospital_ops_v1"
REGISTRY_PATH = REGISTRY_DIR / "model_registry.json"

# Deterministic generation: the same seed always rebuilds the same dataset,
# which is what makes the reported metrics reproducible.
DEFAULT_SEED = 20260918

# Simulation resolution. One row per step; 1 hour = 4 steps, 2 hours = 8 steps.
STEP_MINUTES = 15
STEPS_PER_HOUR = 60 // STEP_MINUTES
HORIZON_STEPS = {"1h": 1 * STEPS_PER_HOUR, "2h": 2 * STEPS_PER_HOUR}

# ------------------------------------------------------- operational pressure
# The bands below are the hospital's approved pressure policy. They are part of
# the operations manual, not something a model is allowed to invent. The
# pressure classifier learns to reproduce this policy from operational data and
# falls back to the policy rules whenever a trained model is unavailable.
PRESSURE_BANDS = (
    ("NORMAL", 0.0, 70.0),
    ("MODERATE", 70.0, 85.0),
    ("HIGH", 85.0, 95.0),
    ("CRITICAL", 95.0, float("inf")),
)
PRESSURE_LABELS = ["NORMAL", "MODERATE", "HIGH", "CRITICAL"]

# ------------------------------------------------------------ feature labels
# Every feature carries a plain-language name so a prediction can explain
# itself without exposing model internals to hospital staff.
FEATURE_LABELS = {
    "hour_of_day": "hour of day",
    "hour_sin": "daily cycle (rising/falling phase)",
    "hour_cos": "daily cycle (peak/trough phase)",
    "dow_sin": "weekly cycle phase",
    "dow_cos": "weekly cycle phase",
    "day_of_week": "day of week",
    "is_weekend": "weekend",
    "is_holiday": "public holiday / mass-gathering event",
    "shift_block": "shift block",
    "arrivals_15m": "emergency arrivals in the last 15 minutes",
    "arrivals_30m": "emergency arrivals in the last 30 minutes",
    "arrivals_1h": "emergency arrivals in the last hour",
    "arrivals_3h": "emergency arrivals in the last 3 hours",
    "arrivals_6h": "emergency arrivals in the last 6 hours",
    "arrivals_24h": "emergency arrivals in the last 24 hours",
    "arrival_rate_trend": "change in arrival rate versus the previous hour",
    "current_queue": "current emergency queue",
    "queue_change_15m": "queue change over 15 minutes",
    "queue_change_30m": "queue change over 30 minutes",
    "queue_change_1h": "queue change over the last hour",
    "rolling_queue_mean": "rolling mean queue",
    "rolling_queue_max": "rolling peak queue",
    "critical_queue": "critical-priority patients waiting",
    "priority_mix_critical": "share of waiting patients triaged critical",
    "bed_occupancy": "general bed occupancy",
    "icu_occupancy": "ICU occupancy",
    "available_beds": "available general beds",
    "available_icu": "available ICU beds",
    "doctor_utilisation": "doctor utilisation",
    "nurse_utilisation": "nurse utilisation",
    "available_doctors": "doctors on duty and available",
    "available_nurses": "nurses on duty and available",
    "equipment_utilisation": "equipment utilisation",
    "available_equipment": "available equipment units",
    "reserved_equipment": "reserved equipment units",
    "ot_utilisation": "operating theatre utilisation",
    "ot_backlog": "waiting surgical cases",
    "ot_backlog_change_1h": "change in waiting surgical cases over the last hour",
    "queue_backlog_pressure": "combined waiting load (emergency queue + surgical backlog)",
    "emergency_resource_pressure": "emergency bay pressure",
    "waiting_minutes_mean": "mean waiting time in the queue",
    "admissions_rate_1h": "admissions in the last hour",
    "discharge_rate_1h": "discharges in the last hour",
    "department_pressure": "department pressure",
    "scheduled_procedures": "scheduled procedures this shift",
    "current_load": "current assigned patients",
    "max_operational_load": "configured workload limit",
    "duty_status_on": "on duty",
    "availability_free": "available (not in a procedure)",
}

# ------------------------------------------------------------ audit metadata
DISCLAIMER = (
    "Operational decision support only. MediCore forecasts demand, pressure and "
    "workload for hospital resources and never diagnoses, triages or treats a "
    "patient. Every allocation is proposed for review and applied only after an "
    "authorised staff member approves it."
)
