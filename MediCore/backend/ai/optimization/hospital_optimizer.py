"""Central multi-resource optimization — Google OR-Tools CP-SAT.

This is the component that answers the operational question a hospital
administrator actually has: *given everything that is constrained right now,
what is the best feasible way to place these patients?*

It evaluates beds, ICU, doctors, nurses, equipment, theatres, clinical priority
and staff duty constraints **simultaneously**, because allocating them one at a
time produces plans that are locally sensible and globally infeasible.

Two rules are structural, not configurable:

* hard constraints are never relaxed — an infeasible problem returns
  ``NO_FEASIBLE_ALLOCATION`` with the blocking resources named, never a
  "close enough" plan;
* every plan is a **recommendation**. It is returned with
  ``requiresHumanApproval: true`` and is applied only after an authorised staff
  member approves it in the Node backend.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from ortools.sat.python import cp_model

from ai import config
from ai.evaluation import optimization_metrics as om
from ai.optimization import bed_optimizer, equipment_optimizer, ot_optimizer, staff_optimizer

PRIORITY_WEIGHTS = {"Critical": 1000, "High": 300, "Medium": 80, "Low": 20}
DEFAULT_MAX_SECONDS = 8.0

EXPLANATION_HEADLINE = (
    "CP-SAT plan: patients are matched to a bed, a doctor, a nurse and any required equipment together, "
    "under the hospital's duty and workload constraints."
)


def _priority_weight(patient: dict) -> int:
    return int(PRIORITY_WEIGHTS.get(patient.get("clinicalPriority"), 50))


def _fallback_priority_rank(patient: dict) -> int:
    order = {"Critical": 4, "High": 3, "Medium": 2, "Low": 1}
    return order.get(patient.get("clinicalPriority"), 1)


def optimise(request: dict) -> dict:
    """Run the CP-SAT model and return a human-reviewable plan."""
    started = time.time()
    patients: list[dict] = list(request.get("patients") or [])
    resources = request.get("resources") or {}
    options = request.get("config") or {}
    max_seconds = float(options.get("maxSolveSeconds", DEFAULT_MAX_SECONDS))

    # Queue order is preserved: clinical priority first, then waiting time.
    patients.sort(
        key=lambda patient: (
            -_priority_weight(patient),
            -(patient.get("waitingMinutes") or 0),
            patient.get("id") or "",
        )
    )

    if not patients:
        return _empty_plan(request, started, "no waiting patients were supplied")

    model = cp_model.CpModel()
    beds = bed_optimizer.build(model, {"patients": patients, "resources": resources})
    staff = staff_optimizer.build(model, {"patients": patients, "resources": resources}, beds)
    equipment = equipment_optimizer.build(model, {"patients": patients, "resources": resources}, beds)
    theatres = ot_optimizer.build(model, {"patients": patients, "resources": resources}, beds)

    # ---- matched[p] : the patient is placed in a bed -----------------------
    matched: dict[str, cp_model.IntVar] = {}
    for patient in patients:
        variables = [beds["variables"][(patient["id"], bed["id"])] for bed in beds["eligible"][patient["id"]]]
        matched[patient["id"]] = model.NewBoolVar(f"matched_{patient['id']}")
        if variables:
            model.Add(sum(variables) == matched[patient["id"]])
        else:
            model.Add(matched[patient["id"]] == 0)

    # ---- objective ---------------------------------------------------------
    terms: list = []
    reasons_by_patient: dict[str, list[str]] = {}

    for patient in patients:
        weight = _priority_weight(patient)
        reasons: list[str] = []
        # Leaving a patient waiting costs more the higher the clinical priority
        # and the longer they have already waited.
        wait_component = int(weight * (1 + (patient.get("waitingMinutes") or 0)))
        terms.append((1 - matched[patient["id"]]) * wait_component)

        for bed in beds["eligible"][patient["id"]]:
            variable = beds["variables"][(patient["id"], bed["id"])]
            detail = bed_optimizer.assignment_terms(patient, bed, beds)
            terms.append(variable * int(detail["weight"]))
            if detail["reasons"]:
                reasons.extend(detail["reasons"][:1])

        for doctor in staff["doctorCandidates"][patient["id"]]:
            variable = staff["doctorVariables"][(patient["id"], doctor["id"])]
            nurse_options = staff["nurseCandidates"][patient["id"]]
            nurse = nurse_options[0] if nurse_options else None
            detail = staff_optimizer.assignment_terms(patient, doctor, nurse)
            terms.append(variable * int(detail["weight"]))
        for nurse in staff["nurseCandidates"][patient["id"]]:
            variable = staff["nurseVariables"][(patient["id"], nurse["id"])]
            terms.append(variable * int(nurse.get("load") or 0) * 2)

        for category_id in equipment_optimizer.category_for(patient):
            if (patient["id"], category_id) not in equipment["equipmentVariables"]:
                continue
            category = next((c for c in resources.get("equipment", []) if c["categoryId"] == category_id), {})
            detail = equipment_optimizer.assignment_terms(patient, category_id, category)
            terms.append(equipment["equipmentVariables"][(patient["id"], category_id)] * int(detail["weight"]))

        if patient.get("needsOt"):
            for theatre in ot_optimizer.eligible_theatres(patient, resources.get("theatres", [])):
                detail = ot_optimizer.assignment_terms(patient, theatre)
                terms.append(theatres["theatreVariables"][(patient["id"], theatre["id"])] * int(detail["weight"]))
            unmet = ot_optimizer.unmet_need(patient, resources.get("theatres", []))
            if unmet:
                # Reported in the plan's conflict list; no synthetic objective term.
                reasons.append("no theatre free inside the horizon")

        reasons_by_patient[patient["id"]] = reasons

    # ---- load balancing: prefer the plan that spreads work evenly ----------
    doctor_counts: list[cp_model.IntVar] = []
    for doctor in resources.get("doctors", []):
        variables = [var for (patient_id, doctor_id), var in staff["doctorVariables"].items() if doctor_id == doctor["id"]]
        if variables:
            count = model.NewIntVar(0, len(patients), f"load_{doctor['id']}")
            model.Add(count == sum(variables))
            doctor_counts.append(count)
    if len(doctor_counts) > 1:
        maximum = model.NewIntVar(0, len(patients), "max_doctor_load")
        model.AddMaxEquality(maximum, doctor_counts)
        terms.append(maximum * 8)

    model.Minimize(sum(terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_seconds
    solver.parameters.num_search_workers = 2
    solver.parameters.random_seed = config.DEFAULT_SEED % 100000
    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    if status_name in ("INFEASIBLE", "MODEL_INVALID", "UNKNOWN"):
        return _no_feasible_allocation(request, patients, resources, status_name, started)

    assignments = _extract(solver, patients, beds, staff, equipment, theatres, resources, reasons_by_patient)
    plan = {
        "patients": patients,
        "assignments": assignments,
        "deferred": [
            {
                "patientId": patient.get("patientNumber") or patient["id"],
                "clinicalPriority": patient.get("clinicalPriority"),
                "waitingMinutes": patient.get("waitingMinutes"),
                "reason": _deferral_reason(patient, beds, staff, equipment, resources),
            }
            for patient in patients
            if not any(item["patientId"] == patient["id"] for item in assignments)
        ],
        "resources": resources,
        "solverStatus": status_name,
        "objectiveValue": float(solver.ObjectiveValue()) if status_name in ("OPTIMAL", "FEASIBLE") else None,
    }
    plan["utilisation"] = _utilisation(plan, resources)
    plan["conflicts"] = _conflicts(plan, resources)
    return _response(plan, started, solver)


# ------------------------------------------------------------------ internals
def _extract(
    solver,
    patients,
    beds,
    staff,
    equipment,
    theatres,
    resources,
    reasons_by_patient,
) -> list[dict]:
    """Read the solved model back into a plan an operations room can review."""
    equipment_catalogue = {entry["categoryId"]: entry for entry in resources.get("equipment", [])}
    assignments: list[dict] = []

    for patient in patients:
        chosen_bed = next(
            (bed for bed in beds["eligible"][patient["id"]] if solver.Value(beds["variables"][(patient["id"], bed["id"])]) == 1),
            None,
        )
        if not chosen_bed:
            continue

        doctor = next(
            (
                candidate
                for candidate in staff["doctorCandidates"][patient["id"]]
                if solver.Value(staff["doctorVariables"][(patient["id"], candidate["id"])]) == 1
            ),
            None,
        )
        nurse = next(
            (
                candidate
                for candidate in staff["nurseCandidates"][patient["id"]]
                if solver.Value(staff["nurseVariables"][(patient["id"], candidate["id"])]) == 1
            ),
            None,
        )

        required_equipment = [
            {
                "categoryId": category_id,
                "name": equipment_catalogue.get(category_id, {}).get("name", category_id.replace("_", " ")),
                "required": 1,
                "available": equipment["equipmentAvailability"].get(category_id, 0),
            }
            for category_id in equipment_optimizer.category_for(patient)
            if (patient["id"], category_id) in equipment["equipmentVariables"]
            and solver.Value(equipment["equipmentVariables"][(patient["id"], category_id)]) == 1
        ]

        theatre_choice = next(
            (
                theatre
                for theatre in ot_optimizer.eligible_theatres(patient, resources.get("theatres", []))
                if (patient["id"], theatre["id"]) in theatres["theatreVariables"]
                and solver.Value(theatres["theatreVariables"][(patient["id"], theatre["id"])]) == 1
            ),
            None,
        )

        assignments.append(
            {
                "patientId": patient["id"],
                "patientNumber": patient.get("patientNumber"),
                "clinicalPriority": patient.get("clinicalPriority"),
                "requiresIcu": bool(patient.get("requiresIcu")),
                "waitingMinutes": patient.get("waitingMinutes"),
                "projectedWaitMinutes": max(0, int((patient.get("waitingMinutes") or 0) * 0.35)),
                "bed": {
                    "id": chosen_bed["id"],
                    "wardId": chosen_bed.get("wardId"),
                    "ward": chosen_bed.get("ward"),
                    "kind": chosen_bed.get("kind"),
                    "escalation": bool(chosen_bed.get("escalation")),
                },
                "doctor": None
                if not doctor
                else {
                    "id": doctor["id"],
                    "name": doctor.get("name"),
                    "department": doctor.get("department"),
                    "dutyStatus": doctor.get("dutyStatus"),
                    "load": int(doctor.get("load") or 0) + 1,
                    "maxOperationalLoad": int(doctor.get("maxOperationalLoad") or staff_optimizer.DOCTOR_DEFAULT_LIMIT),
                },
                "nurse": None
                if not nurse
                else {
                    "id": nurse["id"],
                    "name": nurse.get("name"),
                    "department": nurse.get("department"),
                    "wardId": nurse.get("wardId"),
                    "dutyStatus": nurse.get("dutyStatus"),
                    "load": int(nurse.get("load") or 0) + 1,
                    "maxOperationalLoad": int(nurse.get("maxOperationalLoad") or staff_optimizer.NURSE_DEFAULT_LIMIT),
                },
                "equipment": required_equipment,
                "theatre": None if not theatre_choice else {"id": theatre_choice["id"], "status": theatre_choice.get("status")},
                "reasons": list(dict.fromkeys(reasons_by_patient.get(patient["id"], [])))[:4],
                "wording": "projected placement — requires review and approval",
            }
        )
    return assignments


def _utilisation(plan: dict, resources: dict) -> dict:
    free_beds = sum(1 for bed in resources.get("beds", []) if bed.get("available"))
    used_beds = len(plan["assignments"])
    free_icu = sum(1 for bed in resources.get("beds", []) if bed.get("available") and (bed.get("kind") or "").lower() == "icu")
    used_icu = sum(1 for item in plan["assignments"] if item.get("requiresIcu"))
    staff_used = len({item["doctor"]["id"] for item in plan["assignments"] if item.get("doctor")})
    return {
        "beds": round(100.0 * used_beds / free_beds, 1) if free_beds else None,
        "icu": round(100.0 * used_icu / free_icu, 1) if free_icu else None,
        "bedsUsed": used_beds,
        "icuUsed": used_icu,
        "doctorsEngaged": staff_used,
        "nursesEngaged": len({item["nurse"]["id"] for item in plan["assignments"] if item.get("nurse")}),
    }


def _conflicts(plan: dict, resources: dict) -> list[dict]:
    conflicts = list(equipment_optimizer.shortfall_terms({"patients": plan["patients"], "resources": resources}))
    for patient in plan["patients"]:
        unmet = ot_optimizer.unmet_need(patient, resources.get("theatres", []))
        if unmet:
            conflicts.append(unmet)
    return conflicts


def _deferral_reason(patient, beds, staff, equipment, resources) -> str:
    if not beds["eligible"][patient["id"]]:
        if patient.get("requiresIcu"):
            return "No ICU bed is free — escalation review required (the model does not move or discharge any patient)."
        return "No clinically suitable bed is free in the requested ward."
    if not staff["doctorCandidates"][patient["id"]]:
        return "No eligible on-duty doctor is available under the configured workload limits."
    return "Capacity was matched to higher clinical priority first; this patient stays on the waiting list."


def _response(plan: dict, started: float, solver) -> dict:
    feasible = om.constraint_violations(
        {
            "assignments": [
                {
                    **item,
                    "doctor": None
                    if not item.get("doctor")
                    else {**item["doctor"], "load": item["doctor"]["load"] - 1, "maxOperationalLoad": item["doctor"]["maxOperationalLoad"]},
                    "nurse": None
                    if not item.get("nurse")
                    else {**item["nurse"], "load": item["nurse"]["load"] - 1, "maxOperationalLoad": item["nurse"]["maxOperationalLoad"]},
                }
                for item in plan["assignments"]
            ]
        },
        {
            "bed_capacity": {},
            "icu_capacity": None,
        },
    )
    metrics = om.plan_metrics(plan)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "engine": "Google OR-Tools CP-SAT",
        "status": "OPTIMAL" if plan["solverStatus"] == "OPTIMAL" else "FEASIBLE",
        "solverStatus": plan["solverStatus"],
        "objectiveValue": plan["objectiveValue"],
        "wallTimeSeconds": round(time.time() - started, 3),
        "assignments": plan["assignments"],
        "deferred": plan["deferred"],
        "utilisation": plan["utilisation"],
        "metrics": metrics,
        "constraintCheck": feasible,
        "conflicts": plan["conflicts"],
        "requiresHumanApproval": True,
        "decisionSupportOnly": True,
        "explanation": EXPLANATION_HEADLINE,
        "wording": {
            "values": "projected / estimated",
            "approval": "This plan has no effect until an authorised staff member approves it.",
            "safety": (
                "The optimizer places patients into operational capacity only. It does not diagnose, treat, "
                "discharge, cancel procedures or move an existing patient without authorisation."
            ),
        },
        "disclaimer": config.DISCLAIMER,
    }


def _empty_plan(request: dict, started: float, reason: str) -> dict:
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "engine": "Google OR-Tools CP-SAT",
        "status": "NO_WAITING_PATIENTS",
        "solverStatus": "NOT_RUN",
        "assignments": [],
        "deferred": [],
        "utilisation": {},
        "metrics": om.plan_metrics({"assignments": []}),
        "conflicts": [],
        "requiresHumanApproval": True,
        "note": reason,
        "wallTimeSeconds": round(time.time() - started, 3),
        "disclaimer": config.DISCLAIMER,
    }


# ------------------------------------------------- infeasibility attribution
def _no_feasible_allocation(request: dict, patients: list[dict], resources: dict, status: str, started: float) -> dict:
    """Return NO_FEASIBLE_ALLOCATION with the blocking constraints named.

    The system must never fabricate a feasible plan. Instead it explains which
    resources blocked the allocation, so the command centre can escalate —
    which is the only safe response when capacity genuinely does not exist.
    """
    from ai.optimization import no_feasible

    conflict_report = no_feasible.attribute(patients, resources)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "engine": "Google OR-Tools CP-SAT",
        "status": "NO_FEASIBLE_ALLOCATION",
        "solverStatus": status,
        "assignments": [],
        "deferred": [
            {
                "patientId": patient.get("patientNumber") or patient["id"],
                "clinicalPriority": patient.get("clinicalPriority"),
                "waitingMinutes": patient.get("waitingMinutes"),
                "reason": "No feasible allocation exists under the current hard constraints.",
            }
            for patient in patients
        ],
        "conflicts": conflict_report["conflicts"],
        "blockingResources": conflict_report["blockingResources"],
        "requiresEscalation": True,
        "humanReviewRequired": True,
        "requiresHumanApproval": True,
        "escalationOptions": conflict_report["escalationOptions"],
        "explanation": (
            "The constraints could not be satisfied together. Nothing was allocated and nothing was changed; "
            "the blocking resources are listed for escalation."
        ),
        "wallTimeSeconds": round(time.time() - started, 3),
        "disclaimer": config.DISCLAIMER,
    }
