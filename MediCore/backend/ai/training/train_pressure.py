"""Model 4 — Operational pressure classification (XGBoost Classifier).

Classes: NORMAL, MODERATE, HIGH, CRITICAL — the hospital's approved pressure
bands (<70, 70–85, 85–95, >95). The labels are the *policy* outcome for the
operational picture, which is a real, operational signal recorded in the
timeline; they are not invented.

The classifier reports the probability of each band. The Node backend's
transparent rule engine stays the authority for the headline band, and remains
the fallback whenever this model is unavailable.
"""

from __future__ import annotations

import json

from ai.features import feature_engineering as fe
from ai.training import common

FAMILY = "pressure_classifier"
MODEL_NAME = "pressure_xgboost"
MODEL_KEY = "pressure"


def run(verbose: bool = True) -> dict:
    frame = fe.load_prepared("pressure")
    metadata = common.train_classifier(
        family=FAMILY,
        model_name=MODEL_NAME,
        model_key=MODEL_KEY,
        frame=frame,
        features=fe.PRESSURE_FEATURES,
        target="pressure_label",
        labels=common.config.PRESSURE_LABELS,
    )
    if verbose:
        print(common.summarise(metadata))
    return metadata


if __name__ == "__main__":  # pragma: no cover
    payload = run()
    print(json.dumps(payload["metrics"]["test"], indent=2))
