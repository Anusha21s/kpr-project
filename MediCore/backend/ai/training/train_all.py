"""Train the whole MediCore HE-02 model set and publish a training report.

    python -m ai.training.train_all

The run is reproducible end to end: the synthetic datasets are regenerated from
the configured seed, every model is trained on the same chronological split, and
each model's metrics are written to the registry and to the training report.

Promotion rule: a model is promoted to ``active`` only if its held-out metrics
clear the quality gates below. Otherwise it stays ``candidate`` and the system
keeps using the previous active version — or the deterministic fallback, if
there has never been one.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone

from ai import config
from ai.data import synthetic_generator as generator
from ai.features import feature_engineering as fe
from ai.registry import model_registry as registry
from ai.training import train_demand, train_equipment, train_flow, train_pressure, train_resource, train_staff, train_surge

# Quality gates. A forecast has to be better than the naive "tomorrow looks
# like today" baseline, and the detectors have to be conservative enough to be
# trusted in an operations room.
GATES = {
    # A forecast must beat the naive operational assumption ("today's rate
    # holds") by this margin on held-out future data. Raw R² is reported too,
    # but for arrival counts and queue sizes it is dominated by irreducible
    # demand noise, so skill against the baseline is the honest gate.
    "regression_min_skill_vs_baseline": 0.05,
    "regression_min_r2": 0.05,
    "classification_min_macro_f1": 0.55,
    "anomaly_min_recall": 0.45,
}


def _collect(prefix: str, payload) -> list[dict]:
    """Flatten a trainer's return value into the list of trained-model metadata.

    Trainers return a metadata dict, or a mapping / sequence of them. Every shape
    is walked, so a model can never be trained and then silently skipped at the
    promotion step.
    """
    found: list[dict] = []
    if isinstance(payload, dict):
        if "metrics" in payload and "model_name" in payload:
            return [payload]
        for value in payload.values():
            found.extend(_collect(prefix, value))
    elif isinstance(payload, (list, tuple)):
        for value in payload:
            found.extend(_collect(prefix, value))
    return found


def quality_gate(metadata: dict) -> tuple[bool, str]:
    block = metadata["metrics"].get("test", {})
    if "r2" in block:
        skill = block.get("skill_vs_baseline")
        if skill is None:
            return False, "no persistence baseline recorded, cannot verify skill"
        if skill < GATES["regression_min_skill_vs_baseline"]:
            return False, (
                f"skill vs persistence baseline {round(skill * 100, 2)}% below gate "
                f"{round(GATES['regression_min_skill_vs_baseline'] * 100, 1)}%"
            )
        if block.get("r2") is not None and block["r2"] < GATES["regression_min_r2"]:
            return False, f"R² {block['r2']} below gate {GATES['regression_min_r2']}"
        return True, f"beats persistence baseline by {round(skill * 100, 2)}%"
    if "macro_f1" in block:
        if block["macro_f1"] < GATES["classification_min_macro_f1"]:
            return False, f"macro F1 {block['macro_f1']} below gate {GATES['classification_min_macro_f1']}"
        return True, "classification gate cleared"
    if "recall" in block:
        if block["recall"] < GATES["anomaly_min_recall"]:
            return False, f"anomaly recall {block['recall']} below gate {GATES['anomaly_min_recall']}"
        return True, "anomaly gate cleared"
    return False, "no comparable metric block"


def main() -> int:
    started = time.time()
    print("\nMediCore HE-02 · model training")
    print("─" * 84)

    print("[1/3] rebuilding synthetic operational datasets (deterministic seed)")
    datasets = generator.save_all_datasets()
    print(
        f"      timeline rows={datasets['timeline']['rows']} · stress scenarios="
        f"{len(datasets['scenario_library']['scenarios'])} · doctor rows={datasets['files']['doctors']['rows']} "
        f"· nurse rows={datasets['files']['nurses']['rows']} · equipment rows={datasets['files']['equipment']['rows']}"
    )

    print("[2/3] engineering features (chronological splits, no leakage)")
    manifest = fe.prepare_all()
    for table, info in manifest["tables"].items():
        split = info.get("split")
        detail = f"train={split['train_rows']} test={split['test_rows']}" if split else "operational source table"
        print(f"      {table:10s} rows={info['rows']:<6} {detail}")

    print("[3/3] training models")
    trained: list[dict] = []
    trained += _collect("demand", train_demand.run())
    trained += _collect("resource", train_resource.run())
    trained += _collect("surge", [train_surge.run()])
    trained += _collect("pressure", [train_pressure.run()])
    trained += _collect("staff", train_staff.run())
    trained += _collect("equipment", train_equipment.run())
    trained += _collect("flow", train_flow.run())

    promotions: list[dict] = []
    for metadata in trained:
        passed, reason = quality_gate(metadata)
        if passed:
            registry.promote(metadata["model_name"], metadata["model_version"])
            status = "active"
        else:
            status = "candidate"
        promotions.append(
            {
                "model_name": metadata["model_name"],
                "model_version": metadata["model_version"],
                "status": status,
                "reason": reason,
                "headline": metadata["metrics"].get("test", {}),
            }
        )

    registry_payload = registry.summary()
    consistency = registry.consistency_check()
    if consistency:
        print(f"  ! registry consistency issues: {consistency}")
    report = {
        "pipeline": "mediCore_he02_model_training",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": round(time.time() - started, 1),
        "dataset_version": config.DATASET_VERSION,
        "feature_version": config.FEATURE_VERSION,
        "model_version": config.MODEL_VERSION,
        "synthetic_data": True,
        "synthetic_warning": datasets["timeline"]["synthetic_warning"],
        "datasets": {
            "timeline_rows": datasets["timeline"]["rows"],
            "stress_scenarios": len(datasets["scenario_library"]["scenarios"]),
            "doctor_rows": datasets["files"]["doctors"]["rows"],
            "nurse_rows": datasets["files"]["nurses"]["rows"],
            "equipment_rows": datasets["files"]["equipment"]["rows"],
            "baseline_band_share": datasets["timeline"]["summary"]["band_share"],
        },
        "gates": GATES,
        "models_trained": len(trained),
        "promotions": promotions,
        "registry": registry_payload,
        "registry_consistency": consistency,
        "non_ml_components": {
            "priority_rules": "clinical priority is recorded by authorised clinical staff; timeout escalation only",
            "queue_ranking": "clinical priority first, then waiting time (Node backend)",
            "capacity_calculation": "computed from bed/staff/equipment rows at request time",
            "bottleneck_detection": "transparent constraint engine (Node backend)",
            "conflict_detection": "CFL rules over the live picture",
            "load_balancing": "CP-SAT objective term",
            "constraint_satisfaction": "Google OR-Tools CP-SAT",
            "what_if_simulation": "projected state only, live data untouched",
        },
    }
    path = __import__("ai.training.common", fromlist=["common"]).write_training_report("train_all", report)

    print("─" * 84)
    active = [item for item in promotions if item["status"] == "active"]
    candidate = [item for item in promotions if item["status"] != "active"]
    print(f"trained {len(trained)} models · active {len(active)} · candidate {len(candidate)}")
    for item in candidate:
        print(f"  ! {item['model_name']} kept as candidate — {item['reason']}")
    print(f"report  → {path}")
    print(f"registry→ {config.REGISTRY_PATH}")
    print(f"elapsed → {report['duration_seconds']}s\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
