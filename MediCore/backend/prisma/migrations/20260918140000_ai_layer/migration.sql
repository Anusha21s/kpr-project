-- HE-02 AI layer persistence.
--
-- An advisory run and every prediction inside it are stored with their
-- provenance, so an operational decision can always be traced back to the model
-- version — or the rule-based fallback — that produced the number behind it.
-- Identifiers and model metadata only: no secrets, no patient clinical detail.

CREATE TABLE "AiRun" (
  "id"          TEXT NOT NULL,
  "reference"   TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "requestedBy" TEXT,
  "actorName"   TEXT,
  "actorRole"   TEXT,
  "status"      TEXT NOT NULL DEFAULT 'COMPLETED',
  "durationMs"  INTEGER,
  "aiServiceUp" BOOLEAN NOT NULL DEFAULT false,
  "payload"     JSONB NOT NULL DEFAULT '{}',
  "summary"     JSONB NOT NULL DEFAULT '{}',
  "findings"    JSONB NOT NULL DEFAULT '[]',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiRun_reference_key" ON "AiRun"("reference");
CREATE INDEX "AiRun_kind_createdAt_idx" ON "AiRun"("kind", "createdAt");
CREATE INDEX "AiRun_createdAt_idx" ON "AiRun"("createdAt");

CREATE TABLE "AiPrediction" (
  "id"            TEXT NOT NULL,
  "reference"     TEXT NOT NULL,
  "runId"         TEXT,
  "modelName"     TEXT NOT NULL,
  "modelVersion"  TEXT,
  "algorithm"     TEXT,
  "target"        TEXT NOT NULL,
  "horizon"       TEXT,
  "source"        TEXT NOT NULL,
  "value"         DOUBLE PRECISION,
  "valueText"     TEXT,
  "probability"   JSONB,
  "context"       JSONB NOT NULL DEFAULT '{}',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiPrediction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiPrediction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AiPrediction_reference_key" ON "AiPrediction"("reference");
CREATE INDEX "AiPrediction_modelName_createdAt_idx" ON "AiPrediction"("modelName", "createdAt");
CREATE INDEX "AiPrediction_target_createdAt_idx" ON "AiPrediction"("target", "createdAt");
CREATE INDEX "AiPrediction_runId_idx" ON "AiPrediction"("runId");
