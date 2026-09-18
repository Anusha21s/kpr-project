-- CreateTable
CREATE TABLE "ArrivalLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT,
    "patientNumber" TEXT,
    "source" TEXT NOT NULL DEFAULT 'AMBULANCE',
    "priority" "Priority" NOT NULL DEFAULT 'Medium',
    "department" TEXT,
    "triage" TEXT NOT NULL DEFAULT 'ESI 3',
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArrivalLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArrivalLog_arrivedAt_idx" ON "ArrivalLog"("arrivedAt");

-- CreateIndex
CREATE INDEX "ArrivalLog_source_idx" ON "ArrivalLog"("source");

-- AddForeignKey
ALTER TABLE "ArrivalLog" ADD CONSTRAINT "ArrivalLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
