"""Bed, ICU and bay allocation terms for the CP-SAT model.

Builds the variables and constraints that decide which physical bed (or ICU
bed) each waiting patient is placed in. Bed capacity is a hard constraint: a
solution that would overfill a ward is not allowed to exist.
"""

from __future__ import annotations

from ortools.sat.python import cp_model


def eligible_beds(patient: dict, beds: list[dict]) -> list[dict]:
    """Free beds that can clinically hold this patient's required care level.

    Clinical suitability is a hospital rule set (ICU patients need ICU beds,
    maternity patients need maternity beds), not a model prediction.
    """
    required = (patient.get("requiredWardId") or "").lower()
    needs_icu = bool(patient.get("requiresIcu"))
    candidates: list[dict] = []
    for bed in beds:
        if not bed.get("available"):
            continue
        kind = (bed.get("kind") or "").lower()
        if needs_icu and kind != "icu":
            continue
        if not needs_icu and kind == "icu" and required != "icu":
            # A general patient may not be placed in intensive care: ICU beds
            # must stay available for ICU-level demand.
            continue
        if required and required in ("general", "icu", "emergency", "maternity") and kind != required and not needs_icu:
            if not (required == "general" and kind in ("general", "emergency")):
                continue
        candidates.append(bed)
    if candidates:
        return candidates
    # Nothing clinically suitable is free: the patient stays unassigned and the
    # infeasibility report explains why. The model never relaxes suitability.
    return []


def build(model: cp_model.CpModel, data: dict):
    """Create placement variables and capacity constraints. Returns the term store."""
    patients = data["patients"]
    beds = data["resources"]["beds"]
    bed_by_id = {bed["id"]: bed for bed in beds}
    x: dict[tuple[str, str], cp_model.IntVar] = {}
    eligible: dict[str, list[dict]] = {}

    for patient in patients:
        options = eligible_beds(patient, beds)
        eligible[patient["id"]] = options
        for bed in options:
            x[(patient["id"], bed["id"])] = model.NewBoolVar(f"bed_{patient['id']}_{bed['id']}")

    # At most one bed per patient.
    for patient in patients:
        own = [var for (patient_id, _), var in x.items() if patient_id == patient["id"]]
        if own:
            model.Add(sum(own) <= 1)

    # At most one patient per bed.
    for bed in beds:
        own = [var for (_, bed_id), var in x.items() if bed_id == bed["id"]]
        if own:
            model.Add(sum(own) <= 1)

    # Ward capacity is never exceeded: the plan cannot place more patients into a
    # ward than there are free beds in it.
    ward_capacity: dict[str, int] = {}
    for bed in beds:
        if bed.get("available"):
            ward_capacity[bed.get("wardId", "unknown")] = ward_capacity.get(bed.get("wardId", "unknown"), 0) + 1
    for ward_id, capacity in ward_capacity.items():
        ward_variables = [var for (_, bed_id), var in x.items() if bed_by_id[bed_id].get("wardId") == ward_id]
        if ward_variables:
            model.Add(sum(ward_variables) <= capacity)

    # ICU capacity is tracked separately as well, because an ICU bed consumed by
    # a general patient is the fastest way to make an ICU bed unavailable later.
    icu_bed_ids = {bed["id"] for bed in beds if (bed.get("kind") or "").lower() == "icu"}
    icu_available = sum(1 for bed in beds if bed["id"] in icu_bed_ids and bed.get("available"))
    icu_variables = [var for (_, bed_id), var in x.items() if bed_id in icu_bed_ids]
    if icu_variables:
        model.Add(sum(icu_variables) <= icu_available)

    return {
        "variables": x,
        "eligible": eligible,
        "wardCapacity": ward_capacity,
        "icuCapacity": icu_available,
    }


def assignment_terms(patient: dict, bed: dict, variables: dict) -> dict:
    """Objective weights for one patient→bed pairing, with a readable reason."""
    penalties: list[str] = []
    weight = 0
    if bed.get("wardId") != patient.get("requiredWardId") and not patient.get("requiresIcu"):
        weight += 25
        penalties.append(f"{bed.get('id')} is outside the requested ward ({patient.get('requiredWardId')})")
    if patient.get("requiresIcu") and (bed.get("kind") or "").lower() == "icu":
        weight -= 40
        penalties.append("ICU-level requirement met by an ICU bed")
    if bed.get("escalation"):
        weight += 15
        penalties.append(f"{bed.get('id')} is an escalation bay — reserved for surge capacity")
    return {"weight": weight, "reasons": penalties}
