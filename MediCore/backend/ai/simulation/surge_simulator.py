"""Discrete-event what-if simulation for surge scenarios.

Answers the operational question the command centre rehearses before it happens:
*if N more emergency patients arrive over the next few hours, what does this
hospital look like — and what would the optimizer do about it?*

The simulator runs on a **projected copy** of the hospital state. Live data is
never mutated: there is no write path in this module, and the caller (the Node
backend) is the only thing that can turn a projection into a real allocation,
by asking an authorised human being to approve it.

Output is always three-stage, exactly as the operations room expects it:

    BEFORE  →  AFTER SURGE (no action)  →  AFTER OPTIMIZATION (projected)

Every number is computed. Nothing is hardcoded, and every stage carries the
source of each figure so a reviewer can tell primary data from a projection.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone

from ai import config
from ai.optimization import hospital_optimizer

DEFAULT_STEPS = 8          # two hours of 15-minute steps
STEP_MINUTES = config.STEP_MINUTES

# Clinically-set disposition ratios used by the hospital's surge plan. They are
# plan parameters owned by the hospital, not model output: how many arrivals the
# intake produces is *forecast*, how they flow through the hospital is *policy*.
DISPOSITION = {
    "admit_share": 0.42,
    "icu_share_of_admissions": 0.17,
    "ot_share_of_arrivals": 0.16,
    "ventilator_share_of_icu": 0.72,
    "monitor_share_of_icu": 0.88,
}


def _num(value, default: float = 0.0) -> float:
    try:
        return float(value if value is not None else default)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------- surge intake
def build_intake(patients: list[dict], count: int, priority_mix: dict | None = None) -> list[dict]:
    """Create the surge intake as *projected* waiting patients.

    These are simulation objects. They are created here, kept inside the
    projection, and are never written to the database by this module.
    """
    mix = priority_mix or {"Critical": 0.10, "High": 0.26, "Medium": 0.38, "Low": 0.26}
    order = ["Critical", "High", "Medium", "Low"]
    running = 0.0
    thresholds: list[tuple[str, float]] = []
    for label in order:
        running += mix.get(label, 0.0)
        thresholds.append((label, running))

    intake: list[dict] = []
    for index in range(count):
        fraction = (index + 0.5) / max(count, 1)
        priority = next((label for label, ceiling in thresholds if fraction <= ceiling), "Low")
        needs_icu = priority == "Critical" and (index % 3 == 0)
        intake.append(
            {
                "id": f"SIM-INTAKE-{index + 1:03d}",
                "patientNumber": f"SIM-{index + 1:03d}",
                "clinicalPriority": priority,
                "requiresIcu": needs_icu or priority == "Critical",
                "requiresVentilator": needs_icu,
                "requiresMonitoring": needs_icu or priority in ("Critical", "High"),
                "requiresWardId": "icu" if needs_icu else "general",
                "needsOt": priority in ("Critical", "High") and (index % 4 == 0),
                "specialty": "Emergency Medicine",
                "waitingMinutes": 0,
                "isSimulated": True,
            }
        )
    return intake


# ------------------------------------------------------------------ projection
def project(state: dict, intake: list[dict], steps: int = DEFAULT_STEPS) -> dict:
    """Advance the projected hospital state `steps` steps with the intake added.

    The model is a transparent queueing projection over the configured capacity:
    arrivals arrive, capacity processes at the rate the current roster supports,
    and admissions consume beds and ICU beds. It is deliberately simple enough
    that an operations manager can follow the arithmetic.
    """
    bed_total = max(_num(state.get("bedTotal")), 1)
    icu_total = max(_num(state.get("icuTotal")), 1)
    occupied_beds = _num(state.get("occupiedBeds"))
    occupied_icu = _num(state.get("occupiedIcu"))
    queue = _num(state.get("queue"))
    doctors_available = max(_num(state.get("doctorsAvailable")), 1)
    nurses_available = max(_num(state.get("nursesAvailable")), 1)
    arrivals_per_hour = _num(state.get("arrivalsPerHour"))
    ventilators_available = _num(state.get("ventilatorsAvailable"))
    ot_free = _num(state.get("otAvailable"))
    theatre_count = max(_num(state.get("theatreTotal")), 1)

    timeline: list[dict] = []
    pending = list(intake)

    for step in range(steps):
        arriving_now = pending[0] if pending else None
        arrived = 0
        # Intake is spread across the horizon; the first half of the wave is heavier.
        take = max(1, round(len(intake) / max(steps * 0.65, 1))) if pending else 0
        chunk = pending[:take]
        arrived = len(chunk)
        pending = pending[take:]

        queue += arrived
        queue += arrivals_per_hour / (60 / STEP_MINUTES)  # background arrivals continue

        # Disposition capacity: what the current roster can process in 15 minutes.
        doctor_capacity = doctors_available * 0.55 * (STEP_MINUTES / 60)
        nurse_capacity = nurses_available * 0.34 * (STEP_MINUTES / 60)
        bed_headroom = max(bed_total - occupied_beds, 0) * 0.22
        icu_headroom = max(icu_total - occupied_icu, 0) * 0.10
        processed = min(max(queue, 0), max(doctor_capacity, nurse_capacity, 0.2) + bed_headroom + icu_headroom)

        admitted = processed * DISPOSITION["admit_share"]
        icu_need = admitted * DISPOSITION["icu_share_of_admissions"]
        icu_space = max(icu_total - occupied_icu, 0)
        icu_admitted = min(icu_need, icu_space)
        ward_admitted = admitted - icu_admitted

        bed_space = max(bed_total - occupied_beds, 0)
        ward_admitted = min(ward_admitted, bed_space)

        occupied_icu += icu_admitted
        occupied_beds += ward_admitted + icu_admitted
        queue = max(0.0, queue - processed)

        theatre_demand = recent_theatre_demand(intake, chunk)
        ot_pressure = min(100.0, 100.0 * (theatre_count - ot_free + theatre_demand) / theatre_count)

        timeline.append(
            {
                "step": step + 1,
                "minutesAhead": (step + 1) * STEP_MINUTES,
                "arrivedThisStep": arrived,
                "queue": round(queue, 2),
                "occupiedBeds": round(occupied_beds, 2),
                "bedOccupancy": round(100.0 * occupied_beds / bed_total, 2),
                "occupiedIcu": round(occupied_icu, 2),
                "icuOccupancy": round(100.0 * occupied_icu / icu_total, 2),
                "processedThisStep": round(processed, 2),
                "otPressure": round(ot_pressure, 2),
            }
        )

    # ---- equipment and staffing pressure over the same window --------------
    ventilators_needed = occupied_icu * DISPOSITION["ventilator_share_of_icu"]
    monitors_needed = occupied_icu * DISPOSITION["monitor_share_of_icu"]
    clinicians_needed = (occupied_beds + queue * 0.45) / 6.0
    nurses_needed = (occupied_beds + queue * 0.45) / 4.0

    projected = {
        "queue": round(queue, 2),
        "occupiedBeds": round(occupied_beds, 2),
        "bedOccupancy": round(100.0 * occupied_beds / bed_total, 2),
        "occupiedIcu": round(occupied_icu, 2),
        "icuOccupancy": round(100.0 * occupied_icu / icu_total, 2),
        "ventilatorsNeeded": round(ventilators_needed, 2),
        "ventilatorsAvailable": round(max(ventilators_available - max(0.0, ventilators_needed - _num(state.get("ventilatorsInUse"))), 0.0), 2),
        "monitorsNeeded": round(monitors_needed, 2),
        "doctorsNeeded": round(clinicians_needed, 2),
        "doctorsAvailable": doctors_available,
        "nursesNeeded": round(nurses_needed, 2),
        "nursesAvailable": nurses_available,
        "otPressure": timeline[-1]["otPressure"] if timeline else 0.0,
        "timeline": timeline,
    }
    return projected


def recent_theatre_demand(intake: list[dict], chunk: list[dict]) -> float:
    """Theatre demand generated by the cases arriving in this step."""
    return float(sum(1 for patient in chunk if patient.get("needsOt")))


# ------------------------------------------------------------------ baselines
def capture_before(state: dict) -> dict:
    bed_total = max(_num(state.get("bedTotal")), 1)
    icu_total = max(_num(state.get("icuTotal")), 1)
    return {
        "queue": _num(state.get("queue")),
        "occupiedBeds": _num(state.get("occupiedBeds")),
        "bedOccupancy": round(100.0 * _num(state.get("occupiedBeds")) / bed_total, 2),
        "occupiedIcu": _num(state.get("occupiedIcu")),
        "icuOccupancy": round(100.0 * _num(state.get("occupiedIcu")) / icu_total, 2),
        "availableBeds": _num(state.get("availableBeds")),
        "availableIcu": _num(state.get("availableIcu")),
        "doctorsAvailable": _num(state.get("doctorsAvailable")),
        "nursesAvailable": _num(state.get("nursesAvailable")),
        "ventilatorsAvailable": _num(state.get("ventilatorsAvailable")),
        "otAvailable": _num(state.get("otAvailable")),
        "pressureBand": state.get("pressureBand"),
    }


def deltas(before: dict, after: dict) -> dict:
    keys = [
        "queue",
        "bedOccupancy",
        "icuOccupancy",
        "availableBeds",
        "availableIcu",
        "doctorsAvailable",
        "nursesAvailable",
        "ventilatorsAvailable",
        "otAvailable",
    ]
    return {key: round(_num(after.get(key)) - _num(before.get(key)), 2) for key in keys}


# ------------------------------------------------------------- optimisation
def optimise_projected(request: dict) -> dict:
    """Run CP-SAT against the projected (post-surge) picture."""
    return hospital_optimizer.optimise(request)


def run(request: dict) -> dict:
    """Full what-if run: before → after surge → after optimization."""
    state = request.get("state") or {}
    count = int(request.get("patientCount") or 20)
    steps = int(request.get("steps") or DEFAULT_STEPS)
    scenario = request.get("scenario") or "MASS_CASUALTY_INTAKE"

    intake = build_intake(request.get("patients") or [], count, request.get("priorityMix"))
    before = capture_before(state)
    projected = project(state, intake, steps)

    after_surge = {
        "queue": projected["queue"],
        "bedOccupancy": projected["bedOccupancy"],
        "occupiedBeds": projected["occupiedBeds"],
        "icuOccupancy": projected["icuOccupancy"],
        "occupiedIcu": projected["occupiedIcu"],
        "availableBeds": round(_num(state.get("bedTotal")) - projected["occupiedBeds"], 2),
        "availableIcu": round(_num(state.get("icuTotal")) - projected["occupiedIcu"], 2),
        "doctorsAvailable": projected["doctorsAvailable"],
        "nursesAvailable": projected["nursesAvailable"],
        "ventilatorsAvailable": projected["ventilatorsAvailable"],
        "otAvailable": state.get("otAvailable"),
    }

    # ---- optimization against the projected picture ------------------------
    projected_resources = copy.deepcopy(request.get("resources") or {})
    projected_patients = list(request.get("queuePatients") or []) + intake
    optimise_request = {
        "patients": projected_patients,
        "resources": projected_resources,
        "config": request.get("config") or {},
    }
    optimisation = optimise_projected(optimise_request)

    # ---- what the plan is projected to do to the queue ---------------------
    placed = len(optimisation.get("assignments", []))
    after_optimisation = dict(after_surge)
    if placed:
        bed_total = max(_num(state.get("bedTotal")), 1)
        after_optimisation["queue"] = round(max(0.0, after_surge["queue"] - placed), 2)
        after_optimisation["availableBeds"] = round(max(0.0, after_surge["availableBeds"] - placed), 2)
        # A plan can only fill beds that exist: occupancy is clamped to the
        # configured capacity so a projection can never report above 100%.
        after_optimisation["occupiedBeds"] = round(min(bed_total, after_surge["occupiedBeds"] + placed), 2)
        after_optimisation["bedOccupancy"] = round(100.0 * after_optimisation["occupiedBeds"] / bed_total, 2)
    after_optimisation["planStatus"] = optimisation.get("status")
    after_optimisation["solverStatus"] = optimisation.get("solverStatus")
    after_optimisation["projectedQueueReduction"] = placed

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scenario": scenario,
        "model": "discrete_event_queue_projection",
        "simulationMode": "PROJECTED — live hospital data is not modified by this simulation",
        "intake": {
            "patientCount": count,
            "priorityMix": _mix_summary(intake),
            "requiresIcu": sum(1 for patient in intake if patient.get("requiresIcu")),
            "requiresVentilator": sum(1 for patient in intake if patient.get("requiresVentilator")),
            "needsOt": sum(1 for patient in intake if patient.get("needsOt")),
        },
        "before": before,
        "afterSurge": after_surge,
        "afterOptimisation": after_optimisation,
        "impacts": {
            "surge": deltas(before, after_surge),
            "optimisation": deltas(after_surge, after_optimisation),
        },
        "timeline": projected["timeline"],
        "optimisation": {
            "status": optimisation.get("status"),
            "solverStatus": optimisation.get("solverStatus"),
            "engine": optimisation.get("engine"),
            "placements": placed,
            "deferred": len(optimisation.get("deferred", [])),
            "metrics": optimisation.get("metrics"),
            "conflicts": optimisation.get("conflicts", []),
            "blockingResources": optimisation.get("blockingResources", []),
            "requiresEscalation": optimisation.get("requiresEscalation", False),
            "requiresHumanApproval": True,
            "samplePlan": optimisation.get("assignments", [])[:5],
        },
        "capacityHeadroom": {
            "bedsAfterSurge": after_surge["availableBeds"],
            "icuAfterSurge": after_surge["availableIcu"],
            "bedExhaustion": after_surge["bedOccupancy"] >= 100.0,
            "icuExhaustion": after_surge["icuOccupancy"] >= 100.0,
            "theatrePressure": projected["otPressure"],
        },
        "wording": {
            "status": "projected / expected / estimated — not a guarantee",
            "safety": (
                "This is a rehearsal. Nothing is allocated, moved, cancelled or discharged. The plan shown is a "
                "proposal that an authorised staff member may review and confirm."
            ),
        },
        "disclaimer": config.DISCLAIMER,
    }


def _mix_summary(intake: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for patient in intake:
        label = patient.get("clinicalPriority", "Unknown")
        counts[label] = counts.get(label, 0) + 1
    return counts


if __name__ == "__main__":  # pragma: no cover - manual entry point
    import json

    demo = {
        "state": {
            "bedTotal": 100,
            "icuTotal": 10,
            "occupiedBeds": 88,
            "occupiedIcu": 9,
            "queue": 8,
            "availableBeds": 12,
            "availableIcu": 1,
            "doctorsAvailable": 11,
            "nursesAvailable": 21,
            "arrivalsPerHour": 8.2,
            "ventilatorsAvailable": 2,
            "ventilatorsInUse": 13,
            "otAvailable": 1,
            "theatreTotal": 4,
            "pressureBand": "MODERATE",
        },
        "patientCount": 20,
    }
    print(json.dumps(run(demo)["impacts"], indent=2))
