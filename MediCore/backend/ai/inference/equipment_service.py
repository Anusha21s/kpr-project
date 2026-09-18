"""Inference service — equipment demand forecasting.

Forecasts how many units of each category the hospital is likely to need in the
next one to two hours and reports the projected gap against what is actually
available.

A projected gap is an operational finding for human review. It never overrides
a clinical decision about who uses a ventilator, and it never moves equipment
between patients on its own.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ai import config
from ai.inference import base, feature_builder
from ai.inference.feature_builder import build_live_features, load_history

MODELS = {
    "1h": "equipment_demand_xgboost_units_needed_1h",
    "2h": "equipment_demand_xgboost_units_needed_2h",
}


def _fallback_units(category: dict, features: dict, horizon: str) -> float:
    """Transparent fallback: current draw, lifted by ICU and emergency demand."""
    in_use = float(category.get("inUse") or 0.0)
    total = float(category.get("total") or 0.0)
    icu_share = 0.22 * (float(features.get("icu_occupancy", 0.0)) / 100.0) * max(total, 1.0)
    emergency_share = 0.08 * float(features.get("arrivals_1h", 0.0))
    horizon_factor = 1.0 if horizon == "1h" else 1.7
    return round(min(total + 6.0, max(0.0, in_use + (icu_share + emergency_share) * horizon_factor)), 3)


def predict_demand(snapshot: dict, *, explain: bool = False) -> dict:
    """Equipment demand projection for every configured category."""
    history = load_history()
    features = build_live_features(snapshot, history)
    categories = snapshot.get("equipmentCategories") or []

    results: list[dict] = []
    for category in categories:
        category_features = dict(features)
        total = float(category.get("total") or 0.0)
        in_use = float(category.get("inUse") or 0.0)
        reserved = float(category.get("reserved") or 0.0)
        available = float(category.get("available") if category.get("available") is not None else max(total - in_use - reserved, 0.0))
        category_features.update(
            {
                "units_total": total,
                "units_in_use": in_use,
                "units_reserved": reserved,
                "units_available": available,
                "utilisation": round(100.0 * in_use / total, 3) if total else 0.0,
                "icu_demand": float(features.get("icu_occupancy", 0.0)),
                "emergency_demand": float(features.get("emergency_resource_pressure", 0.0)),
                "department_load": float(features.get("nurse_utilisation", 0.0)),
            }
        )

        one_hour = base.predict_regressor(
            MODELS["1h"],
            category_features,
            fallback=lambda c=category: _fallback_units(c, features, "1h"),
            explain=explain,
            clamp=(0.0, total + 30.0),
        )
        two_hour = base.predict_regressor(
            MODELS["2h"],
            category_features,
            fallback=lambda c=category: _fallback_units(c, features, "2h"),
            clamp=(0.0, total + 30.0),
        )

        needed = one_hour["value"]
        gap = round(needed - available, 2)
        results.append(
            {
                "categoryId": category.get("id"),
                "name": category.get("name"),
                "total": total,
                "inUse": in_use,
                "reserved": reserved,
                "available": available,
                "predictedUnitsNeeded1h": needed,
                "predictedUnitsNeeded2h": two_hour["value"],
                "projectedGap1h": gap,
                "projectedGap2h": round(two_hour["value"] - available, 2),
                "status": "PROJECTED_SHORTFALL" if gap > 0.5 else ("TIGHT" if gap > -1.0 else "SUFFICIENT"),
                "source": one_hour["source"],
                "wording": "projected",
            }
        )

    shortfalls = [item for item in results if item["status"] == "PROJECTED_SHORTFALL"]
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categories": results,
        "summary": {
            "categoriesScored": len(results),
            "projectedShortfalls": len(shortfalls),
            "projectedShortfallIds": [item["categoryId"] for item in shortfalls],
            "note": (
                "A projected shortfall is an operational gap for review by the resource coordinator. "
                "It is never an instruction to move equipment between patients."
            ),
        },
        "models": MODELS,
        "disclaimer": config.DISCLAIMER,
    }
