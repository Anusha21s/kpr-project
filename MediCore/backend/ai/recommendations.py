"""Structured recommendation and explanation builder.

Every recommendation the system produces is assembled here, in one place, from
the structured outputs of the ML layer and the CP-SAT plan. The rules:

* the recommendation is always ``requiresHumanApproval: true``;
* it names the resource, the current capacity, the demand, the gap and the
  severity, so it can be read at a glance in an operations room;
* the explanation is generated from the structured fields by fixed templates —
  no language model is in the decision path. If a language model is ever
  attached (optional, see ``AI_LLM_*``), it only re-phrases these fields.

The wording is deliberately operational. Nothing here diagnoses, treats,
triages or overrides a clinician.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ai import config

SEVERITY_WORDING = {
    "CRITICAL": "critical",
    "HIGH": "high",
    "MEDIUM": "moderate",
    "OPERATIONAL": "operational, for review",
}


WARD_LABELS = {
    "icu": "ICU",
    "general": "the general ward",
    "emergency": "the emergency ward",
    "maternity": "maternity & paediatrics",
}


def _one(value) -> float:
    """Round a projection to one decimal — the precision an operations lead reads."""
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return value


DECISION_SUPPORT_NOTE = (
    "Operational decision support only. This is a recommendation for review — it has no effect until an "
    "authorised staff member approves it. It does not diagnose or treat any patient, and it never cancels or "
    "re-schedules clinical work on its own."
)

SEVERITY_ORDER = {"CRITICAL": 3, "HIGH": 2, "OPERATIONAL": 1, "INFO": 0}


def _band(value: float) -> str:
    for label, low, high in config.PRESSURE_BANDS:
        if low <= value < high:
            return label
    return config.PRESSURE_LABELS[-1]


def build_resource_findings(
    *,
    resource_pressure: dict | None,
    equipment_demand: dict | None,
    staff_workload: dict | None,
    surge: dict | None,
) -> list[dict]:
    """Turn the model outputs into a single, ranked list of operational findings."""
    findings: list[dict] = []

    for entry in (resource_pressure or {}).get("resources", []):
        projected = entry["predicted1h"]
        current = entry["current"]
        if projected < 70.0 and entry["currentBand"] == "NORMAL":
            continue
        severity = "CRITICAL" if projected >= 95 else "HIGH" if projected >= 85 else "OPERATIONAL"
        findings.append(
            {
                "id": f"FND-{entry['resource'].upper()}",
                "resource": entry["resource"],
                "label": entry["label"],
                "currentCapacity": round(100.0 - current, 2),
                "currentUtilisation": current,
                "demand": projected,
                "gap": round(projected - current, 2),
                "severity": severity,
                "trend": entry["direction"],
                "projectedBand": entry["predictedBand1h"],
                "source": entry["source"],
                "wording": "projected",
                "detail": (
                    f"{entry['label']} is at {_one(current)}% now and is projected to reach {_one(projected)}% "
                    f"within the hour ({entry['direction']})."
                ),
            }
        )

    for entry in (equipment_demand or {}).get("categories", []):
        if entry["status"] != "PROJECTED_SHORTFALL":
            continue
        findings.append(
            {
                "id": f"FND-EQP-{str(entry['categoryId']).upper()}",
                "resource": "equipment",
                "label": entry["name"],
                "currentCapacity": entry["available"],
                "demand": entry["predictedUnitsNeeded1h"],
                "gap": entry["projectedGap1h"],
                "severity": "HIGH" if entry["projectedGap1h"] >= 2 else "OPERATIONAL",
                "trend": "rising",
                "source": entry["source"],
                "wording": "projected",
                "detail": (
                    f"{entry['name']}: {entry['available']} unit(s) free, {_one(entry['predictedUnitsNeeded1h'])} projected "
                    f"to be needed within the hour — a gap of {_one(entry['projectedGap1h'])}."
                ),
            }
        )

    staff = staff_workload or {}
    if staff.get("summary", {}).get("projectedOverLimit"):
        summary = staff["summary"]
        findings.append(
            {
                "id": "FND-STAFF-WORKLOAD",
                "resource": "staffing",
                "label": "Clinician workload",
                "currentCapacity": summary.get("eligibleNow"),
                "demand": summary.get("meanProjectedLoad1h"),
                "gap": summary.get("projectedOverLimit"),
                "severity": "HIGH" if summary["projectedOverLimit"] >= 3 else "OPERATIONAL",
                "trend": "rising",
                "source": staff.get("staff", [{}])[0].get("source") if staff.get("staff") else None,
                "wording": "projected",
                "detail": summary.get("warning"),
            }
        )

    if surge and surge.get("afterSurge"):
        after = surge["afterSurge"]
        before = surge["before"]
        if after["icuOccupancy"] >= 100 or after["bedOccupancy"] >= 100:
            findings.append(
                {
                    "id": "FND-SURGE-CAPACITY",
                    "resource": "capacity",
                    "label": "Capacity under the simulated surge",
                    "currentCapacity": before["availableBeds"],
                    "demand": after["occupiedBeds"],
                    "gap": round(after["bedOccupancy"] - before["bedOccupancy"], 2),
                    "severity": "CRITICAL" if after["icuOccupancy"] >= 100 else "HIGH",
                    "trend": "rising",
                    "source": "discrete_event_queue_projection",
                    "wording": "projected",
                    "detail": (
                        f"Under the simulated intake, general bed occupancy is projected to reach "
                        f"{after['bedOccupancy']}% and ICU occupancy {after['icuOccupancy']}%."
                    ),
                }
            )

    order = {"CRITICAL": 0, "HIGH": 1, "OPERATIONAL": 2, "INFO": 3}
    findings.sort(key=lambda item: (order.get(item["severity"], 3), -(item.get("gap") or 0)))
    for index, finding in enumerate(findings, start=1):
        finding["rank"] = index
    return findings


def build_recommendations(
    *,
    optimization: dict,
    findings: list[dict],
    demand: dict | None = None,
    surge: dict | None = None,
) -> list[dict]:
    """Convert a CP-SAT plan into reviewable recommendations."""
    recommendations: list[dict] = []
    assignments = optimization.get("assignments", [])

    if assignments:
        by_ward: dict[str, list[dict]] = {}
        for item in assignments:
            by_ward.setdefault(item["bed"]["wardId"] or "general", []).append(item)

        for ward, items in by_ward.items():
            critical = [item for item in items if item["clinicalPriority"] in ("Critical", "High")]
            doctors = {item["doctor"]["id"] for item in items if item.get("doctor")}
            nurses = {item["nurse"]["id"] for item in items if item.get("nurse")}
            equipment_used = sorted({entry["categoryId"] for item in items for entry in item.get("equipment", [])})
            recommendations.append(
                {
                    "id": f"REC-PLACE-{ward.upper()}",
                    "type": "PLACEMENT",
                    "title": f"Place {len(items)} waiting patient(s) into {WARD_LABELS.get(ward, ward)} capacity",
                    "status": "PENDING_HUMAN_APPROVAL",
                    "priority": "CRITICAL" if any(item["requiresIcu"] for item in items) else "HIGH",
                    "summary": {
                        "patients": len(items),
                        "highPriority": len(critical),
                        "icuRequired": sum(1 for item in items if item["requiresIcu"]),
                        "doctorsEngaged": len(doctors),
                        "nursesEngaged": len(nurses),
                        "equipmentEngaged": equipment_used,
                    },
                    "recommendationIds": [item["patientNumber"] for item in items],
                    "detail": (
                        f"{len(items)} waiting patient(s) — {len(critical)} of them critical or high priority — have a "
                        f"feasible placement in {ward}. The plan engages {len(doctors)} doctor(s), {len(nurses)} nurse(s)"
                        + (f" and {', '.join(equipment_used)}." if equipment_used else ".")
                    ),
                    "projectedEffect": {
                        "queueReduction": len(items),
                        "ward": ward,
                        "note": "projected — the effect is confirmed after the placement is applied",
                    },
                    "requiresHumanApproval": True,
                    "confidence": _confidence(optimization),
                    "basis": f"Google OR-Tools CP-SAT · solver {optimization.get('solverStatus')}",
                }
            )

    if optimization.get("deferred"):
        deferred = optimization["deferred"]
        recommendations.append(
            {
                "id": "REC-DEFERRED",
                "type": "ESCALATION",
                "title": f"{len(deferred)} patient(s) could not be placed by the optimizer",
                "status": "REQUIRES_HUMAN_REVIEW",
                "priority": "CRITICAL" if any(item.get("clinicalPriority") == "Critical" for item in deferred) else "HIGH",
                "summary": {"deferred": len(deferred)},
                "recommendationIds": [item["patientId"] for item in deferred],
                "detail": "; ".join(dict.fromkeys(item["reason"] for item in deferred))[:600],
                "projectedEffect": None,
                "requiresHumanApproval": True,
                "confidence": None,
                "basis": "constraint attribution over the live picture",
            }
        )

    for finding in findings[:6]:
        recommendations.append(
            {
                "id": f"REC-{finding['id'].replace('FND-', '')}",
                "type": "RESOURCE_PRESSURE",
                "title": f"{finding['label']} — projected pressure is {SEVERITY_WORDING.get(finding['severity'], finding['severity'].lower())}",
                "status": "REQUIRES_HUMAN_REVIEW",
                "priority": finding["severity"],
                "summary": {
                    "resource": finding["resource"],
                    "current": finding["currentUtilisation"] if "currentUtilisation" in finding else finding["currentCapacity"],
                    "projected": finding["demand"],
                    "gap": finding["gap"],
                },
                "recommendationIds": [],
                "detail": finding["detail"],
                "projectedEffect": {"note": "operational pressure — review with the resource coordinator"},
                "requiresHumanApproval": True,
                "confidence": None,
                "basis": f"model source: {finding.get('source') or 'policy rules'}",
            }
        )

    return recommendations


def _confidence(optimization: dict) -> dict:
    """Report solver confidence, not model confidence."""
    return {
        "kind": "solver_status",
        "value": optimization.get("solverStatus"),
        "constraintsRespected": (optimization.get("constraintCheck") or {}).get("feasible", None),
        "note": "feasibility is verified against the hard constraints; projected effects are estimates",
    }


def summarise(
    *,
    pressure: dict | None,
    demand: dict | None,
    surge_detection: dict | None,
    findings: list[dict],
    optimization: dict | None,
) -> dict:
    """A plain-language operational summary of everything the AI layer just saw.

    This is the text an operations lead would read first. It is assembled from
    structured fields by fixed templates, so it cannot drift from the numbers.
    """
    lines: list[str] = []

    if pressure:
        lines.append(
            f"Hospital pressure is {pressure['pressure']} (index {pressure['pressureIndex']}; main driver: "
            f"{pressure['explanation']['main_driver']})."
        )
    if surge_detection and surge_detection.get("anomaly_detected"):
        policy_severity = surge_detection["severity"]
        detector_view = surge_detection.get("modelSeverity")
        detector = (
            f" The detector reads this pattern as {detector_view}, above the policy level, so it is worth a look."
            if surge_detection.get("modelEscalatedAbovePolicy")
            else ""
        )
        lines.append(
            f"Operational anomaly detected — policy severity {policy_severity}: "
            f"{surge_detection.get('trigger') or 'unusual pattern'}.{detector}"
        )
    if demand:
        summary = demand["summary"]
        lines.append(
            f"Emergency demand: {summary['currentArrivalsPerHour']} arrivals/hour now, "
            f"{_one(summary['predictedArrivals1h'])} projected over the next hour and "
            f"{_one(summary['predictedArrivals2h'])} over two; "
            f"queue {summary['currentQueue']} now → {_one(summary['predictedQueue1h'])} projected in one hour."
        )
    if optimization:
        placed = len(optimization.get("assignments", []))
        deferred = len(optimization.get("deferred", []))
        if optimization.get("status") == "NO_FEASIBLE_ALLOCATION":
            lines.append(
                "No feasible allocation exists under the current constraints — the blocking resources are listed for escalation."
            )
        else:
            lines.append(f"The optimizer found a feasible plan for {placed} patient(s)" + (f" with {deferred} deferred." if deferred else "."))
    if findings:
        worst = findings[0]
        lines.append(f"Highest-severity finding: {worst['label']} — {worst['detail']}")

    return {
        "headline": lines[0] if lines else "No operational findings.",
        "lines": lines,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": "deterministic template over structured model and optimizer output (no language model in the decision path)",
        "disclaimer": DECISION_SUPPORT_NOTE,
    }


def ai_event_payloads(
    *,
    pressure: dict | None,
    surge_detection: dict | None,
    optimization: dict | None,
    findings: list[dict],
) -> list[dict]:
    """The socket events the AI layer publishes, in publish order."""
    events: list[dict] = []

    if pressure:
        events.append(
            {
                "event": "ai:pressure",
                "payload": {
                    "pressure": pressure["pressure"],
                    "pressureIndex": pressure["pressureIndex"],
                    "projectedBand1h": (pressure.get("projections") or {}).get("projectedBand1h"),
                    "mainDriver": pressure["explanation"]["main_driver"],
                    "source": pressure["source"],
                },
            }
        )
    if surge_detection and surge_detection.get("anomaly_detected"):
        events.append(
            {
                "event": "ai:surge",
                "payload": {
                    "severity": surge_detection["severity"],
                    "trigger": surge_detection.get("trigger"),
                    "anomalyScore": surge_detection.get("anomaly_score"),
                    "source": surge_detection["model"]["source"],
                },
            }
        )
    if findings:
        events.append(
            {
                "event": "ai:findings",
                "payload": {
                    "count": len(findings),
                    "highest": findings[0]["id"],
                    "severity": findings[0]["severity"],
                },
            }
        )
    if optimization:
        events.append(
            {
                "event": "ai:plan",
                "payload": {
                    "status": optimization.get("status"),
                    "solverStatus": optimization.get("solverStatus"),
                    "placements": len(optimization.get("assignments", [])),
                    "deferred": len(optimization.get("deferred", [])),
                    "requiresHumanApproval": True,
                },
            }
        )
    return events
