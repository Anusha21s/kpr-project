"""Attribution for infeasible optimization problems.

When CP-SAT cannot satisfy every hard constraint, the honest answer is
"there is no feasible allocation" plus the reason. This module works out which
resources blocked the plan by testing the demand against each resource class
independently, and produces the escalation options a command centre can act on.

Nothing here invents capacity or relaxes a constraint.
"""

from __future__ import annotations

from ai.optimization import bed_optimizer, ot_optimizer, staff_optimizer


def attribute(patients: list[dict], resources: dict) -> dict:
    beds = resources.get("beds", [])
    doctors = resources.get("doctors", [])
    nurses = resources.get("nurses", [])
    theatres = resources.get("theatres", [])
    equipment = resources.get("equipment", [])

    conflicts: list[dict] = []
    blocking: list[str] = []
    escalation: list[str] = []

    # ---- beds and ICU ------------------------------------------------------
    icu_demand = [patient for patient in patients if patient.get("requiresIcu")]
    free_icu = [bed for bed in beds if bed.get("available") and (bed.get("kind") or "").lower() == "icu"]
    if len(icu_demand) > len(free_icu):
        blocking.append("icu")
        conflicts.append(
            {
                "resource": "icu",
                "currentCapacity": len(free_icu),
                "demand": len(icu_demand),
                "gap": len(icu_demand) - len(free_icu),
                "severity": "CRITICAL",
                "affectedPatients": [patient.get("patientNumber") or patient["id"] for patient in icu_demand],
                "detail": "ICU capacity is exhausted. No ICU bed is free for the requested placements.",
            }
        )
        escalation.append(
            "Escalation review: open the ICU step-down review with the treating teams (a clinical decision), "
            "and pre-alert the retrieval/transfer service."
        )

    unplaced_beds = [patient for patient in patients if not bed_optimizer.eligible_beds(patient, beds)]
    if unplaced_beds:
        blocking.append("beds")
        conflicts.append(
            {
                "resource": "beds",
                "currentCapacity": sum(1 for bed in beds if bed.get("available")),
                "demand": len(unplaced_beds),
                "gap": len(unplaced_beds),
                "severity": "HIGH",
                "affectedPatients": [patient.get("patientNumber") or patient["id"] for patient in unplaced_beds],
                "detail": "No clinically suitable free bed exists for these patients in the requested ward.",
            }
        )
        escalation.append("Open the discharge-review round for clinically stable inpatients (ward team decision, not automated).")

    # ---- clinicians --------------------------------------------------------
    eligible_doctors = [doctor for doctor in doctors if staff_optimizer._eligible(doctor)]  # noqa: SLF001
    doctor_capacity = sum(
        max(0, int(doctor.get("maxOperationalLoad") or 6) - int(doctor.get("load") or 0)) for doctor in eligible_doctors
    )
    if len(patients) > doctor_capacity:
        blocking.append("doctors")
        conflicts.append(
            {
                "resource": "doctors",
                "currentCapacity": doctor_capacity,
                "demand": len(patients),
                "gap": len(patients) - doctor_capacity,
                "severity": "HIGH",
                "affectedPatients": [patient.get("patientNumber") or patient["id"] for patient in patients],
                "detail": "On-duty doctor capacity (within configured workload limits) is below the demand.",
            }
        )
        escalation.append("Call in the off-duty rota for the affected department through the normal staffing process.")

    eligible_nurses = [nurse for nurse in nurses if staff_optimizer._eligible(nurse)]  # noqa: SLF001
    nurse_capacity = sum(max(0, int(nurse.get("maxOperationalLoad") or 4) - int(nurse.get("load") or 0)) for nurse in eligible_nurses)
    if len(patients) > nurse_capacity:
        blocking.append("nurses")
        conflicts.append(
            {
                "resource": "nurses",
                "currentCapacity": nurse_capacity,
                "demand": len(patients),
                "gap": len(patients) - nurse_capacity,
                "severity": "HIGH",
                "affectedPatients": [patient.get("patientNumber") or patient["id"] for patient in patients],
                "detail": "Nursing capacity (within configured limits) is below the demand.",
            }
        )
        escalation.append("Redeploy the surge nursing pool or hold elective admissions until cover improves.")

    # ---- equipment ---------------------------------------------------------
    for entry in equipment:
        required = sum(
            1
            for patient in patients
            if entry["categoryId"] in ("ventilators", "monitors")
            and (
                (entry["categoryId"] == "ventilators" and patient.get("requiresVentilator"))
                or (entry["categoryId"] == "monitors" and (patient.get("requiresIcu") or patient.get("requiresMonitoring")))
            )
        )
        available = int(entry.get("available") or 0)
        if required > available:
            blocking.append(f"equipment:{entry['categoryId']}")
            conflicts.append(
                {
                    "resource": "equipment",
                    "categoryId": entry["categoryId"],
                    "currentCapacity": available,
                    "demand": required,
                    "gap": required - available,
                    "severity": "HIGH",
                    "affectedPatients": [
                        patient.get("patientNumber") or patient["id"]
                        for patient in patients
                        if (entry["categoryId"] == "ventilators" and patient.get("requiresVentilator"))
                        or (
                            entry["categoryId"] == "monitors"
                            and (patient.get("requiresIcu") or patient.get("requiresMonitoring"))
                        )
                    ],
                    "detail": f"{entry.get('name', entry['categoryId'])} availability is below demand.",
                }
            )
            escalation.append(f"Release or locally source additional {entry.get('name', entry['categoryId'])}.")

    # ---- theatres ----------------------------------------------------------
    surgical = [patient for patient in patients if ot_optimizer.unmet_need(patient, theatres)]
    if surgical:
        blocking.append("ot")
        for unmet in surgical:
            conflicts.append(
                {
                    "resource": "ot",
                    "currentCapacity": len([t for t in theatres if (t.get("status") or "").upper() == "AVAILABLE"]),
                    "demand": len(surgical),
                    "gap": len(surgical),
                    "severity": "HIGH",
                    "affectedPatients": [unmet["patientId"]],
                    "detail": unmet["reason"],
                }
            )
        escalation.append("Theatre coordinator reviews the list for a genuine gap; no scheduled procedure is cancelled automatically.")

    if not conflicts:
        conflicts.append(
            {
                "resource": "combination",
                "currentCapacity": None,
                "demand": len(patients),
                "gap": None,
                "severity": "HIGH",
                "affectedPatients": [patient.get("patientNumber") or patient["id"] for patient in patients],
                "detail": (
                    "Each resource is individually sufficient, but no combination satisfies the duty, workload and "
                    "equipment constraints simultaneously."
                ),
            }
        )
        escalation.append("Command centre reviews the plan with the resource coordinator and re-scopes the placement batch.")

    return {
        "conflicts": conflicts,
        "blockingResources": sorted(set(blocking)),
        "escalationOptions": escalation,
        "requiresEscalation": True,
    }
