"""Metrics for the CP-SAT optimisation runs and the what-if simulator.

These describe *operational quality* — did the plan respect every constraint,
how long do patients wait, how loaded do staff become. Nothing here evaluates a
clinical decision, because the optimizer never makes one.
"""

from __future__ import annotations

from statistics import mean


def constraint_violations(plan: dict, hard_constraints: dict) -> dict:
    """Check a produced plan against the hard constraints it was given.

    The optimizer is required to be *feasible*: a plan that breaks a hard
    constraint must be reported here, never silently returned as valid.
    """
    violations: list[dict] = []
    assignments = plan.get("assignments", [])

    bed_capacity = hard_constraints.get("bed_capacity", {})
    used_by_ward: dict[str, int] = {}
    for item in assignments:
        if item.get("bed"):
            ward = item["bed"]["wardId"]
            used_by_ward[ward] = used_by_ward.get(ward, 0) + 1
    for ward, used in used_by_ward.items():
        capacity = bed_capacity.get(ward)
        if capacity is not None and used > capacity:
            violations.append({"constraint": "bed_capacity", "resource": ward, "used": used, "capacity": capacity})

    icu_capacity = hard_constraints.get("icu_capacity")
    icu_used = sum(1 for item in assignments if item.get("requiresIcu"))
    if icu_capacity is not None and icu_used > icu_capacity:
        violations.append({"constraint": "icu_capacity", "used": icu_used, "capacity": icu_capacity})

    for item in assignments:
        doctor = item.get("doctor")
        if doctor and doctor.get("dutyStatus") != "ON_DUTY":
            violations.append({"constraint": "doctor_duty_status", "resource": doctor.get("id")})
        if doctor and doctor.get("load", 0) > doctor.get("maxOperationalLoad", 6):
            violations.append(
                {
                    "constraint": "doctor_workload_limit",
                    "resource": doctor.get("id"),
                    "load": doctor.get("load"),
                    "limit": doctor.get("maxOperationalLoad"),
                }
            )
        nurse = item.get("nurse")
        if nurse and nurse.get("dutyStatus") != "ON_DUTY":
            violations.append({"constraint": "nurse_duty_status", "resource": nurse.get("id")})
        if nurse and nurse.get("load", 0) > nurse.get("maxOperationalLoad", 4):
            violations.append(
                {
                    "constraint": "nurse_workload_limit",
                    "resource": nurse.get("id"),
                    "load": nurse.get("load"),
                    "limit": nurse.get("maxOperationalLoad"),
                }
            )
        equipment = item.get("equipment") or []
        for unit in equipment:
            if unit.get("available", 0) < unit.get("required", 0):
                violations.append(
                    {"constraint": "equipment_availability", "resource": unit.get("categoryId"), "shortfall": unit["required"] - unit["available"]}
                )

    return {"violations": violations, "violation_count": len(violations), "feasible": not violations}


def plan_metrics(plan: dict) -> dict:
    """Waiting-time, utilisation and balance figures for one plan."""
    assignments = plan.get("assignments", [])
    waiting = [item.get("projectedWaitMinutes", 0) for item in assignments]
    critical_waiting = [
        item.get("projectedWaitMinutes", 0) for item in assignments if item.get("clinicalPriority") in ("Critical", "High")
    ]
    doctor_loads = [item["doctor"]["load"] for item in assignments if item.get("doctor")]
    nurse_loads = [item["nurse"]["load"] for item in assignments if item.get("nurse")]

    def utilisation(values, capacity):
        return round(100.0 * sum(values) / capacity, 2) if capacity else None

    return {
        "patientsScheduled": len(assignments),
        "patientsDeferred": plan.get("deferred", []).__len__(),
        "averageWaitMinutes": round(mean(waiting), 1) if waiting else 0.0,
        "maxWaitMinutes": round(max(waiting), 1) if waiting else 0.0,
        "highPriorityAverageWaitMinutes": round(mean(critical_waiting), 1) if critical_waiting else 0.0,
        "doctorLoadSpread": round(max(doctor_loads) - min(doctor_loads), 2) if doctor_loads else 0.0,
        "nurseLoadSpread": round(max(nurse_loads) - min(nurse_loads), 2) if nurse_loads else 0.0,
        "meanDoctorLoad": round(mean(doctor_loads), 2) if doctor_loads else 0.0,
        "meanNurseLoad": round(mean(nurse_loads), 2) if nurse_loads else 0.0,
        "bedUtilisation": plan.get("utilisation", {}).get("beds"),
        "icuUtilisation": plan.get("utilisation", {}).get("icu"),
        "objectiveValue": plan.get("objectiveValue"),
        "solverStatus": plan.get("solverStatus"),
        "optimisationConflicts": len(plan.get("conflicts", [])),
        "equipmentShortfalls": len([c for c in plan.get("conflicts", []) if c.get("resource") == "equipment"]),
        "theatreShortfalls": len([c for c in plan.get("conflicts", []) if c.get("resource") == "ot"]),
    }


def compare_plans(baseline: dict, optimised: dict) -> dict:
    """Before/after comparison of two plans, expressed as operational deltas."""
    before = plan_metrics(baseline)
    after = plan_metrics(optimised)
    deltas = {}
    for key in ("averageWaitMinutes", "maxWaitMinutes", "highPriorityAverageWaitMinutes", "doctorLoadSpread", "nurseLoadSpread"):
        deltas[key] = round(after.get(key, 0) - before.get(key, 0), 2)
    deltas["patientsScheduled"] = after["patientsScheduled"] - before["patientsScheduled"]
    return {"before": before, "after": after, "delta": deltas}


def solver_report(solver, plan: dict) -> dict:
    """Status of one CP-SAT solve, in the form the API reports it."""
    from ortools.sat.python import cp_model

    status_names = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "UNKNOWN",
    }
    status = status_names.get(solver.StatusName() if hasattr(solver, "StatusName") else None, None)
    if status is None:
        raw = solver.StatusName() if hasattr(solver, "StatusName") else str(getattr(solver, "status", "UNKNOWN"))
        status = raw.upper() if isinstance(raw, str) else "UNKNOWN"
    return {
        "solverStatus": status,
        "objectiveValue": float(solver.ObjectiveValue()) if status in ("OPTIMAL", "FEASIBLE") else None,
        "wallTimeSeconds": round(float(getattr(solver, "WallTime", lambda: 0.0)()), 3),
        "conflicts": plan.get("conflicts", []),
        "numSearchBranches": int(getattr(solver, "NumBranches", lambda: 0)()) if status in ("OPTIMAL", "FEASIBLE") else 0,
    }
