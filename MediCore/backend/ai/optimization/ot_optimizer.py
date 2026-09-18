"""Operating theatre terms for the CP-SAT model.

The optimizer may plan a theatre slot for a surgical case. It may **not**
cancel, move or re-time a procedure that already exists — those slots are hard
constraints, held by the hospital's own booking process, and any change to them
is a human decision made by the theatre coordinator.
"""

from __future__ import annotations

from ortools.sat.python import cp_model

HORIZON_MINUTES = 240
AVERAGE_CASE_MINUTES = 90


def eligible_theatres(patient: dict, theatres: list[dict]) -> list[dict]:
    """Theatres that can take a new case inside the planning horizon.

    A theatre that is running a case, held for an emergency review, or under
    maintenance cannot be planned — and nothing is cancelled to make room.
    """
    if not patient.get("needsOt"):
        return []
    options: list[dict] = []
    for theatre in theatres:
        status = (theatre.get("status") or "").upper()
        if status in ("AVAILABLE", "FREE", "STANDBY"):
            options.append(theatre)
    return options


def build(model: cp_model.CpModel, data: dict, bed_variables: dict):
    """Create theatre variables with one new case per theatre in the horizon."""
    patients = [patient for patient in data["patients"] if patient.get("needsOt")]
    theatres = data["resources"]["theatres"]
    variables: dict[tuple[str, str], cp_model.IntVar] = {}

    for patient in patients:
        for theatre in eligible_theatres(patient, theatres):
            variables[(patient["id"], theatre["id"])] = model.NewBoolVar(f"ot_{patient['id']}_{theatre['id']}")

    for patient in patients:
        patient_variables = [var for (patient_id, theatre_id), var in variables.items() if patient_id == patient["id"]]
        if patient_variables:
            model.Add(sum(patient_variables) <= 1)

    # A theatre can hold at most one new case in this planning horizon; the
    # remaining theatre time belongs to the existing schedule.
    for theatre in theatres:
        theatre_variables = [var for (patient_id, theatre_id), var in variables.items() if theatre_id == theatre["id"]]
        if theatre_variables:
            model.Add(sum(theatre_variables) <= 1)

    return {"theatreVariables": variables}


def assignment_terms(patient: dict, theatre: dict) -> dict:
    weight = -30  # using a genuinely free theatre is preferred over deferring surgery
    reasons = [f"{theatre.get('id')} is free inside the planning horizon"]
    if patient.get("clinicalPriority") in ("Critical", "High"):
        weight -= 20
        reasons.append(f"{patient['clinicalPriority'].lower()}-priority surgical case")
    return {"weight": weight, "reasons": reasons}


def unmet_need(patient: dict, theatres: list[dict]) -> dict | None:
    """Describe a surgical case that cannot be planned inside the horizon."""
    if not patient.get("needsOt") or eligible_theatres(patient, theatres):
        return None
    return {
        "patientId": patient.get("patientNumber") or patient.get("id"),
        "clinicalPriority": patient.get("clinicalPriority"),
        "resource": "ot",
        "reason": "No theatre is free inside the planning horizon — the surgical list is a human decision.",
        "options": [
            "Theatre coordinator reviews the existing list for a genuine gap.",
            "Open the escalation theatre if staffing allows.",
            "Emergency case escalated to the on-call surgeon for immediate clinical review.",
        ],
        "requiresEscalation": True,
    }
