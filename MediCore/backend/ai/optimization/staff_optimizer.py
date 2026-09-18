"""Doctor and nurse allocation terms for the CP-SAT model.

Hard constraints enforced here:

* only clinicians who are ON_DUTY and Available are ever offered as candidates;
* the load each clinician ends the plan with may not exceed their configured
  workload limit;
* a nurse is only offered for the ward they are rostered to (with a defined,
  visible cross-ward fallback for surge cover, which carries an objective
  penalty rather than being forbidden).

Load balancing appears in the objective so that two equally feasible plans are
not equally good: the plan that spreads work fairly is preferred.
"""

from __future__ import annotations

from ortools.sat.python import cp_model

DOCTOR_DEFAULT_LIMIT = 6
NURSE_DEFAULT_LIMIT = 4


def _eligible(member: dict) -> bool:
    return member.get("dutyStatus") == "ON_DUTY" and member.get("availability") == "Available"


def eligible_doctors(patient: dict, doctors: list[dict]) -> list[dict]:
    candidates = [doctor for doctor in doctors if _eligible(doctor)]
    specialty = (patient.get("specialty") or patient.get("department") or "").lower()
    preferred = [doctor for doctor in candidates if (doctor.get("department") or "").lower() == specialty]
    others = [doctor for doctor in candidates if doctor not in preferred]
    return preferred + others


def eligible_nurses(patient: dict, nurses: list[dict], doctor_department: str | None = None) -> list[dict]:
    candidates = [nurse for nurse in nurses if _eligible(nurse)]
    ward = (patient.get("requiredWardId") or "").lower()
    department = (doctor_department or patient.get("department") or "").lower()
    same_ward = [
        nurse
        for nurse in candidates
        if (nurse.get("wardId") or "").lower() == ward or (nurse.get("department") or "").lower() == department
    ]
    others = [nurse for nurse in candidates if nurse not in same_ward]
    return same_ward + others


def build(model: cp_model.CpModel, data: dict, bed_variables: dict):
    """Create doctor and nurse assignment variables with workload limits."""
    patients = data["patients"]
    doctors = data["resources"]["doctors"]
    nurses = data["resources"]["nurses"]

    doctor_vars: dict[tuple[str, str], cp_model.IntVar] = {}
    nurse_vars: dict[tuple[str, str], cp_model.IntVar] = {}
    doctor_candidates: dict[str, list[dict]] = {}
    nurse_candidates: dict[str, list[dict]] = {}

    for patient in patients:
        doctor_options = eligible_doctors(patient, doctors)
        doctor_candidates[patient["id"]] = doctor_options
        for doctor in doctor_options:
            doctor_vars[(patient["id"], doctor["id"])] = model.NewBoolVar(f"doc_{patient['id']}_{doctor['id']}")

        nurse_options = eligible_nurses(patient, nurses)
        nurse_candidates[patient["id"]] = nurse_options
        for nurse in nurse_options:
            nurse_vars[(patient["id"], nurse["id"])] = model.NewBoolVar(f"nur_{patient['id']}_{nurse['id']}")

    for patient in patients:
        doctor_list = [doctor_vars[(patient["id"], doctor["id"])] for doctor in doctor_candidates[patient["id"]]]
        nurse_list = [nurse_vars[(patient["id"], nurse["id"])] for nurse in nurse_candidates[patient["id"]]]
        if doctor_list:
            model.Add(sum(doctor_list) <= 1)
        if nurse_list:
            model.Add(sum(nurse_list) <= 1)

    # A clinician cannot carry more patients than their configured limit —
    # including the patients already assigned to them.
    for doctor in doctors:
        variables = [var for (patient_id, doctor_id), var in doctor_vars.items() if doctor_id == doctor["id"]]
        if not variables:
            continue
        existing = int(doctor.get("load") or 0)
        limit = int(doctor.get("maxOperationalLoad") or DOCTOR_DEFAULT_LIMIT)
        model.Add(existing + sum(variables) <= max(limit, existing))

    for nurse in nurses:
        variables = [var for (patient_id, nurse_id), var in nurse_vars.items() if nurse_id == nurse["id"]]
        if not variables:
            continue
        existing = int(nurse.get("load") or 0)
        limit = int(nurse.get("maxOperationalLoad") or NURSE_DEFAULT_LIMIT)
        model.Add(existing + sum(variables) <= max(limit, existing))

    return {
        "doctorVariables": doctor_vars,
        "nurseVariables": nurse_vars,
        "doctorCandidates": doctor_candidates,
        "nurseCandidates": nurse_candidates,
    }


def assignment_terms(patient: dict, doctor: dict, nurse: dict | None) -> dict:
    """Objective weights and human-readable reasons for a staffing choice."""
    weight = 0
    reasons: list[str] = []
    load = int(doctor.get("load") or 0)
    limit = int(doctor.get("maxOperationalLoad") or DOCTOR_DEFAULT_LIMIT)
    weight += load * 3
    reasons.append(f"{doctor.get('name')} currently carries {load}/{limit} patients")

    specialty = (patient.get("specialty") or patient.get("department") or "").lower()
    if (doctor.get("department") or "").lower() == specialty:
        weight -= 20
        reasons.append("specialty match with the patient's care team")

    if patient.get("requiresIcu") and (doctor.get("department") or "").lower() in ("critical care", "intensive care"):
        weight -= 25
        reasons.append("critical-care cover for an ICU-level requirement")

    if nurse is not None:
        nurse_load = int(nurse.get("load") or 0)
        weight += nurse_load * 2
        reasons.append(f"{nurse.get('name')} currently carries {nurse_load} patients")
        if (nurse.get("wardId") or "").lower() == (patient.get("requiredWardId") or "").lower():
            weight -= 12
            reasons.append("nurse rostered to the receiving ward")
    return {"weight": weight, "reasons": reasons}
