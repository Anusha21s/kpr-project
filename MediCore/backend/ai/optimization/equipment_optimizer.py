"""Equipment allocation terms for the CP-SAT model.

Equipment is allocated by *category capacity*, not by unit identity: the plan
states how many units of each category the matched patients need and refuses to
plan more than the register actually has available. Reserving individual units
with row locking stays in the Node backend, where the transaction lives.
"""

from __future__ import annotations

from ortools.sat.python import cp_model


def category_for(patient: dict) -> list[str]:
    """The equipment categories this patient's care level requires."""
    categories: list[str] = []
    if patient.get("requiresVentilator"):
        categories.append("ventilators")
    if patient.get("requiresIcu") or patient.get("requiresMonitoring"):
        categories.append("monitors")
    return categories


def build(model: cp_model.CpModel, data: dict, bed_variables: dict):
    """Create equipment variables and capacity constraints per category."""
    patients = data["patients"]
    categories = data["resources"]["equipment"]
    variables: dict[tuple[str, str], cp_model.IntVar] = {}
    availability: dict[str, int] = {}

    for category in categories:
        availability[category["categoryId"]] = int(category.get("available") or 0)

    for patient in patients:
        for category_id in category_for(patient):
            if category_id not in availability:
                continue
            variables[(patient["id"], category_id)] = model.NewBoolVar(f"eqp_{patient['id']}_{category_id}")

    for category in categories:
        category_id = category["categoryId"]
        category_variables = [var for (patient_id, cid), var in variables.items() if cid == category_id]
        if category_variables:
            model.Add(sum(category_variables) <= availability.get(category_id, 0))

    return {"equipmentVariables": variables, "equipmentAvailability": availability}


def shortfall_terms(data: dict) -> list[dict]:
    """Categories where demand already exceeds what is available.

    Reported as operational gap information alongside the plan. A shortfall
    does not stop emergency treatment: it is raised for human review.
    """
    patients = data["patients"]
    availability = {category["categoryId"]: int(category.get("available") or 0) for category in data["resources"]["equipment"]}
    demand: dict[str, int] = {}
    for patient in patients:
        for category_id in category_for(patient):
            demand[category_id] = demand.get(category_id, 0) + 1

    gaps: list[dict] = []
    for category_id, required in demand.items():
        free = availability.get(category_id)
        if free is None:
            continue
        if required > free:
            gaps.append(
                {
                    "resource": "equipment",
                    "categoryId": category_id,
                    "demand": required,
                    "capacity": free,
                    "gap": required - free,
                    "severity": "HIGH" if required - free >= 2 else "OPERATIONAL",
                    "note": "Projected equipment gap — review with the resource coordinator; clinical decisions are unaffected.",
                }
            )
    return gaps


def assignment_terms(patient: dict, category_id: str, category: dict) -> dict:
    weight = 0
    reasons: list[str] = []
    available = int(category.get("available") or 0)
    if available <= 1:
        weight += 30
        reasons.append(f"{category.get('name')} is down to its last available unit")
    if category_id == "ventilators":
        weight += 40
        reasons.append("ventilator requirement")
    return {"weight": weight, "reasons": reasons}
