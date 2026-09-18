"""Model registry.

Every trained artifact is recorded here with its algorithm, dataset version,
feature version, target, metrics and status. A newly trained model is written
with status ``candidate``; the training report decides whether it is promoted
to ``active``. An active model is never silently replaced — promotion is an
explicit, logged decision, and the previous version stays in the registry so it
can be rolled back.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from ai import config


def _read() -> dict:
    if not config.REGISTRY_PATH.exists():
        return {"registry_version": "1.0.0", "updated_at": None, "models": {}}
    return json.loads(config.REGISTRY_PATH.read_text(encoding="utf-8"))


def _write(payload: dict) -> None:
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    config.REGISTRY_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def register(
    *,
    model_name: str,
    model_version: str,
    algorithm: str,
    target: str,
    metrics: dict,
    artifact_path: str,
    dataset_version: str = config.DATASET_VERSION,
    feature_version: str = config.FEATURE_VERSION,
    horizon: str | None = None,
    training_rows: int | None = None,
    notes: str | None = None,
    synthetic_data: bool = True,
    status: str = "candidate",
) -> dict:
    """Record one trained model version. Returns the stored entry."""
    registry = _read()
    entries = registry["models"].setdefault(model_name, {"versions": []})

    for entry in entries["versions"]:
        if entry["model_version"] == model_version:
            # Re-training the same version refreshes its metrics and artifact but
            # must NOT change its lifecycle status: only promote() may move a
            # version between candidate / active / superseded. Otherwise a
            # re-training run would silently de-activate the model in service.
            entry.update(
                {
                    "algorithm": algorithm,
                    "target": target,
                    "metrics": metrics,
                    "artifact_path": artifact_path,
                    "trained_at": datetime.now(timezone.utc).isoformat(),
                    "training_rows": training_rows,
                    "notes": notes,
                }
            )
            _write(registry)
            return entry

    entry = {
        "model_name": model_name,
        "model_version": model_version,
        "algorithm": algorithm,
        "target": target,
        "horizon": horizon,
        "dataset_version": dataset_version,
        "feature_version": feature_version,
        "training_date": datetime.now(timezone.utc).isoformat(),
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_rows": training_rows,
        "metrics": metrics,
        "artifact_path": artifact_path,
        "status": status,
        "synthetic_data": synthetic_data,
        "notes": notes,
    }
    entries["versions"].append(entry)
    entries["active_version"] = entries.get("active_version")
    _write(registry)
    return entry


def promote(model_name: str, model_version: str | None = None) -> dict:
    """Promote a version to active. The previous active version is kept."""
    registry = _read()
    entries = registry["models"].get(model_name)
    if not entries or not entries["versions"]:
        raise KeyError(f"No model registered under {model_name}.")
    if model_version is None:
        candidate = entries["versions"][-1]
    else:
        matches = [entry for entry in entries["versions"] if entry["model_version"] == model_version]
        if not matches:
            raise KeyError(f"{model_name} has no version {model_version}.")
        candidate = matches[0]

    for entry in entries["versions"]:
        if entry["status"] == "active" and entry is not candidate:
            entry["status"] = "superseded"
            entry["superseded_at"] = datetime.now(timezone.utc).isoformat()
    candidate["status"] = "active"
    candidate["promoted_at"] = datetime.now(timezone.utc).isoformat()
    entries["active_version"] = candidate["model_version"]
    _write(registry)
    return candidate


def active_entry(model_name: str) -> dict | None:
    """The version currently serving this model, or None to mean "use the fallback".

    The active version is the only thing that may be loaded for inference. If the
    registry has no active version — or its status disagrees with the recorded
    active version — the model is treated as unavailable and the caller falls
    back to the rule-based path rather than guessing which artifact to trust.
    """
    entries = _read()["models"].get(model_name)
    if not entries:
        return None
    version = entries.get("active_version")
    if not version:
        return None
    for entry in entries["versions"]:
        if entry["model_version"] == version and entry["status"] == "active":
            return entry
    return None


def consistency_check() -> list[dict]:
    """Report registry entries whose status and active_version disagree."""
    issues: list[dict] = []
    for name, entries in _read()["models"].items():
        version = entries.get("active_version")
        active_entries = [entry for entry in entries["versions"] if entry["status"] == "active"]
        if version and not active_entries:
            issues.append({"model_name": name, "issue": "active_version set but no version marked active", "active_version": version})
        if len(active_entries) > 1:
            issues.append({"model_name": name, "issue": "more than one version marked active", "count": len(active_entries)})
        if not version and active_entries:
            issues.append({"model_name": name, "issue": "version marked active but no active_version recorded"})
    return issues


def active_artifact_path(model_name: str) -> Path | None:
    entry = active_entry(model_name)
    if not entry:
        return None
    path = Path(entry["artifact_path"])
    return path if path.exists() else None


def all_models() -> dict:
    return _read()


def summary() -> dict:
    """Compact overview used by GET /api/ai/models and the health endpoint."""
    registry = _read()
    models: dict = {}
    for name, entries in registry["models"].items():
        active = entries.get("active_version")
        entry = next((item for item in entries["versions"] if item["model_version"] == active), None)
        models[name] = {
            "active_version": active,
            "algorithm": entry["algorithm"] if entry else None,
            "status": entry["status"] if entry else "unavailable",
            "target": entry["target"] if entry else None,
            "metrics": entry.get("metrics", {}) if entry else {},
            "trained_at": entry.get("trained_at") if entry else None,
            "feature_version": entry.get("feature_version") if entry else None,
            "dataset_version": entry.get("dataset_version") if entry else None,
            "synthetic_data": entry.get("synthetic_data") if entry else None,
            "versions": [item["model_version"] for item in entries["versions"]],
            "artifact_present": bool(entry and Path(entry["artifact_path"]).exists()) if entry else False,
        }
    return {"registry_version": registry.get("registry_version"), "updated_at": registry.get("updated_at"), "models": models}
