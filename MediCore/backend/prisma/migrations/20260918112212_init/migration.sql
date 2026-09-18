-- CreateEnum
CREATE TYPE "DutyStatus" AS ENUM ('ON_DUTY', 'OFF_DUTY', 'LEAVE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('Available', 'Assigned', 'InProcedure', 'Unavailable');

-- CreateEnum
CREATE TYPE "WorkloadBand" AS ENUM ('Low', 'Moderate', 'High');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('Critical', 'High', 'Medium', 'Low');

-- CreateEnum
CREATE TYPE "BedUnit" AS ENUM ('GENERAL', 'ICU', 'EMERGENCY', 'MATERNITY');

-- CreateEnum
CREATE TYPE "BedStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'ALLOCATION_PROPOSED', 'ALLOCATED', 'IN_TREATMENT', 'CLOSED');

-- CreateEnum
CREATE TYPE "TheatreStatus" AS ENUM ('AVAILABLE', 'ONGOING', 'SCHEDULED', 'MAINTENANCE', 'HELD');

-- CreateEnum
CREATE TYPE "OtSlotStatus" AS ENUM ('SCHEDULED', 'ONGOING', 'COMPLETED', 'HELD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AllocationType" AS ENUM ('BED', 'ICU_BED', 'DOCTOR', 'NURSE', 'EQUIPMENT', 'OT', 'EMERGENCY_RESOURCE');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('PROPOSED', 'PENDING_APPROVAL', 'CONFIRMED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecommendationAction" AS ENUM ('ALLOCATE', 'REALLOCATE', 'HOLD', 'ESCALATE', 'REVIEW', 'REINFORCE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('Critical', 'Operational');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('CRITICAL', 'HIGH', 'OPERATIONAL', 'INFO');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SimulationStatus" AS ENUM ('NORMAL', 'SURGE', 'COMMITTED', 'REVERTED');

-- CreateTable
CREATE TABLE "Role" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "staffRef" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "department" TEXT,
    "roleCode" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "dutyStatus" "DutyStatus" NOT NULL DEFAULT 'ON_DUTY',
    "availability" "Availability" NOT NULL DEFAULT 'Available',
    "currentAssignment" TEXT,
    "workload" "WorkloadBand" NOT NULL DEFAULT 'Moderate',
    "patients" INTEGER NOT NULL DEFAULT 0,
    "maxOperationalLoad" INTEGER NOT NULL DEFAULT 12,
    "since" TEXT,
    "contact" TEXT,
    "shiftBlock" TEXT,
    "shift" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorDuty" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "shiftBlock" TEXT NOT NULL,
    "shiftLabel" TEXT NOT NULL,
    "dutyDate" TIMESTAMP(3) NOT NULL,
    "status" "DutyStatus" NOT NULL DEFAULT 'ON_DUTY',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorDuty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nurse" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "dutyStatus" "DutyStatus" NOT NULL DEFAULT 'ON_DUTY',
    "availability" "Availability" NOT NULL DEFAULT 'Available',
    "currentAssignment" TEXT,
    "workload" "WorkloadBand" NOT NULL DEFAULT 'Low',
    "assignedPatients" INTEGER NOT NULL DEFAULT 0,
    "maxOperationalLoad" INTEGER NOT NULL DEFAULT 5,
    "shiftBlock" TEXT,
    "shift" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Nurse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NurseDuty" (
    "id" TEXT NOT NULL,
    "nurseId" TEXT NOT NULL,
    "shiftBlock" TEXT NOT NULL,
    "shiftLabel" TEXT NOT NULL,
    "dutyDate" TIMESTAMP(3) NOT NULL,
    "status" "DutyStatus" NOT NULL DEFAULT 'ON_DUTY',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NurseDuty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "patientNumber" TEXT NOT NULL,
    "name" TEXT,
    "age" INTEGER,
    "sex" TEXT,
    "department" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'Medium',
    "triage" TEXT NOT NULL DEFAULT 'ESI 3',
    "requiredResource" TEXT,
    "secondaryResource" TEXT,
    "specialtyRequired" TEXT,
    "requiresVentilator" BOOLEAN NOT NULL DEFAULT false,
    "needsOt" BOOLEAN NOT NULL DEFAULT false,
    "clinicalRequirementBy" TEXT,
    "requirementConfirmedAt" TIMESTAMP(3),
    "notes" TEXT,
    "diagnosis" TEXT,
    "plan" TEXT,
    "vitals" JSONB,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "assignedDoctorId" TEXT,
    "assignedNurseId" TEXT,
    "assignedBedId" TEXT,
    "assignedOtId" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "simulationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientQueue" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
    "waitingSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waitingMinutes" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "requiredResource" TEXT,
    "secondaryResource" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'Medium',
    "triage" TEXT NOT NULL DEFAULT 'ESI 3',
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "securedResources" JSONB NOT NULL DEFAULT '[]',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bed" (
    "id" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "ward" TEXT NOT NULL,
    "unit" "BedUnit" NOT NULL,
    "bedType" TEXT NOT NULL,
    "status" "BedStatus" NOT NULL DEFAULT 'AVAILABLE',
    "patientId" TEXT,
    "patientRef" TEXT,
    "heldFor" TEXT,
    "availableFrom" TIMESTAMP(3),
    "escalation" BOOLEAN NOT NULL DEFAULT false,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "inUse" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Available',
    "criticalFor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentUnit" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "inUse" BOOLEAN NOT NULL DEFAULT false,
    "reserved" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'Available',
    "reservedFor" TEXT,
    "patientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyResource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "inUse" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Available',
    "criticalFor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatingTheatre" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'GENERAL',
    "status" "TheatreStatus" NOT NULL DEFAULT 'AVAILABLE',
    "nextAvailableSlot" TEXT,
    "nextAvailableMinutes" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatingTheatre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtSchedule" (
    "id" TEXT NOT NULL,
    "theatreId" TEXT NOT NULL,
    "patientId" TEXT,
    "patientLabel" TEXT,
    "procedure" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'Medium',
    "status" "OtSlotStatus" NOT NULL DEFAULT 'SCHEDULED',
    "start" TEXT,
    "end" TEXT,
    "startMinutes" INTEGER,
    "endMinutes" INTEGER,
    "surgeonId" TEXT,
    "surgeonName" TEXT,
    "anaesthetist" TEXT,
    "requiredEquipment" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "equipmentReady" BOOLEAN NOT NULL DEFAULT false,
    "nurses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "conflictDetail" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "AllocationType" NOT NULL,
    "patientId" TEXT,
    "bedId" TEXT,
    "doctorId" TEXT,
    "nurseId" TEXT,
    "equipmentId" TEXT,
    "equipmentUnitId" TEXT,
    "emergencyResourceId" TEXT,
    "theatreId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "resourceLabel" TEXT,
    "status" "AllocationStatus" NOT NULL DEFAULT 'PROPOSED',
    "reason" TEXT,
    "allocatedById" TEXT,
    "approvalId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'Critical',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "recommendationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conflictsRaised" INTEGER NOT NULL DEFAULT 0,
    "impact" JSONB NOT NULL DEFAULT '[]',
    "optimizationId" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationRun" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'current',
    "status" TEXT NOT NULL DEFAULT 'RECOMMENDATION_READY',
    "selections" JSONB NOT NULL DEFAULT '{}',
    "impact" JSONB NOT NULL DEFAULT '[]',
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "pressure" JSONB NOT NULL DEFAULT '{}',
    "analysisRows" JSONB NOT NULL DEFAULT '[]',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationRecommendation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceCode" TEXT NOT NULL,
    "action" "RecommendationAction" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '[]',
    "highlight" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "score" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "rejectedReason" TEXT,
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurgeSimulation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "SimulationStatus" NOT NULL DEFAULT 'NORMAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "scenario" TEXT NOT NULL DEFAULT 'MASS_CASUALTY_INTAKE',
    "patientCount" INTEGER NOT NULL DEFAULT 20,
    "triggeredById" TEXT,
    "before" JSONB NOT NULL DEFAULT '{}',
    "after" JSONB NOT NULL DEFAULT '{}',
    "changes" JSONB NOT NULL DEFAULT '{}',
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "SurgeSimulation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalTask" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'Medium',
    "dueTime" TEXT NOT NULL,
    "department" TEXT,
    "patientNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "assignedDoctorId" TEXT,
    "assignedNurseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'OPERATIONAL',
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resource" TEXT,
    "affectedResource" TEXT,
    "actionLabel" TEXT,
    "actionTo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'Constraint engine',
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "patientId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" "AlertType" NOT NULL DEFAULT 'Operational',
    "category" TEXT NOT NULL DEFAULT 'Operations',
    "patientId" TEXT,
    "actionLabel" TEXT,
    "actionTo" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_staffId_key" ON "User"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "User_staffRef_key" ON "User"("staffRef");

-- CreateIndex
CREATE INDEX "User_roleCode_idx" ON "User"("roleCode");

-- CreateIndex
CREATE INDEX "User_department_idx" ON "User"("department");

-- CreateIndex
CREATE UNIQUE INDEX "Doctor_userId_key" ON "Doctor"("userId");

-- CreateIndex
CREATE INDEX "Doctor_specialty_idx" ON "Doctor"("specialty");

-- CreateIndex
CREATE INDEX "Doctor_dutyStatus_idx" ON "Doctor"("dutyStatus");

-- CreateIndex
CREATE INDEX "DoctorDuty_dutyDate_idx" ON "DoctorDuty"("dutyDate");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorDuty_doctorId_shiftBlock_dutyDate_key" ON "DoctorDuty"("doctorId", "shiftBlock", "dutyDate");

-- CreateIndex
CREATE UNIQUE INDEX "Nurse_userId_key" ON "Nurse"("userId");

-- CreateIndex
CREATE INDEX "Nurse_department_idx" ON "Nurse"("department");

-- CreateIndex
CREATE INDEX "Nurse_dutyStatus_idx" ON "Nurse"("dutyStatus");

-- CreateIndex
CREATE INDEX "NurseDuty_dutyDate_idx" ON "NurseDuty"("dutyDate");

-- CreateIndex
CREATE UNIQUE INDEX "NurseDuty_nurseId_shiftBlock_dutyDate_key" ON "NurseDuty"("nurseId", "shiftBlock", "dutyDate");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientNumber_key" ON "Patient"("patientNumber");

-- CreateIndex
CREATE INDEX "Patient_priority_idx" ON "Patient"("priority");

-- CreateIndex
CREATE INDEX "Patient_department_idx" ON "Patient"("department");

-- CreateIndex
CREATE INDEX "Patient_assignedDoctorId_idx" ON "Patient"("assignedDoctorId");

-- CreateIndex
CREATE INDEX "Patient_assignedNurseId_idx" ON "Patient"("assignedNurseId");

-- CreateIndex
CREATE INDEX "Patient_assignedBedId_idx" ON "Patient"("assignedBedId");

-- CreateIndex
CREATE INDEX "Patient_isSimulated_idx" ON "Patient"("isSimulated");

-- CreateIndex
CREATE UNIQUE INDEX "PatientQueue_patientId_key" ON "PatientQueue"("patientId");

-- CreateIndex
CREATE INDEX "PatientQueue_status_idx" ON "PatientQueue"("status");

-- CreateIndex
CREATE INDEX "PatientQueue_priority_idx" ON "PatientQueue"("priority");

-- CreateIndex
CREATE UNIQUE INDEX "Bed_patientId_key" ON "Bed"("patientId");

-- CreateIndex
CREATE INDEX "Bed_unit_idx" ON "Bed"("unit");

-- CreateIndex
CREATE INDEX "Bed_status_idx" ON "Bed"("status");

-- CreateIndex
CREATE INDEX "Bed_wardId_idx" ON "Bed"("wardId");

-- CreateIndex
CREATE INDEX "Equipment_kind_idx" ON "Equipment"("kind");

-- CreateIndex
CREATE INDEX "EquipmentUnit_equipmentId_idx" ON "EquipmentUnit"("equipmentId");

-- CreateIndex
CREATE INDEX "EquipmentUnit_status_idx" ON "EquipmentUnit"("status");

-- CreateIndex
CREATE INDEX "OtSchedule_status_idx" ON "OtSchedule"("status");

-- CreateIndex
CREATE INDEX "OtSchedule_startMinutes_idx" ON "OtSchedule"("startMinutes");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_reference_key" ON "Allocation"("reference");

-- CreateIndex
CREATE INDEX "Allocation_status_idx" ON "Allocation"("status");

-- CreateIndex
CREATE INDEX "Allocation_type_idx" ON "Allocation"("type");

-- CreateIndex
CREATE INDEX "Allocation_patientId_idx" ON "Allocation"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_reference_key" ON "Approval"("reference");

-- CreateIndex
CREATE INDEX "Approval_status_idx" ON "Approval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationRun_reference_key" ON "OptimizationRun"("reference");

-- CreateIndex
CREATE INDEX "OptimizationRun_generatedAt_idx" ON "OptimizationRun"("generatedAt");

-- CreateIndex
CREATE INDEX "OptimizationRecommendation_resourceCode_idx" ON "OptimizationRecommendation"("resourceCode");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationRecommendation_runId_reference_key" ON "OptimizationRecommendation"("runId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "SurgeSimulation_reference_key" ON "SurgeSimulation"("reference");

-- CreateIndex
CREATE INDEX "SurgeSimulation_active_idx" ON "SurgeSimulation"("active");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalTask_reference_key" ON "ClinicalTask"("reference");

-- CreateIndex
CREATE INDEX "ClinicalTask_status_idx" ON "ClinicalTask"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_reference_key" ON "Alert"("reference");

-- CreateIndex
CREATE INDEX "Alert_status_idx" ON "Alert"("status");

-- CreateIndex
CREATE INDEX "Alert_type_idx" ON "Alert"("type");

-- CreateIndex
CREATE INDEX "Alert_category_idx" ON "Alert"("category");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleCode_fkey" FOREIGN KEY ("roleCode") REFERENCES "Role"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorDuty" ADD CONSTRAINT "DoctorDuty_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nurse" ADD CONSTRAINT "Nurse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NurseDuty" ADD CONSTRAINT "NurseDuty_nurseId_fkey" FOREIGN KEY ("nurseId") REFERENCES "Nurse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_assignedDoctorId_fkey" FOREIGN KEY ("assignedDoctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_assignedNurseId_fkey" FOREIGN KEY ("assignedNurseId") REFERENCES "Nurse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "SurgeSimulation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientQueue" ADD CONSTRAINT "PatientQueue_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentUnit" ADD CONSTRAINT "EquipmentUnit_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtSchedule" ADD CONSTRAINT "OtSchedule_theatreId_fkey" FOREIGN KEY ("theatreId") REFERENCES "OperatingTheatre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtSchedule" ADD CONSTRAINT "OtSchedule_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtSchedule" ADD CONSTRAINT "OtSchedule_surgeonId_fkey" FOREIGN KEY ("surgeonId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_nurseId_fkey" FOREIGN KEY ("nurseId") REFERENCES "Nurse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_emergencyResourceId_fkey" FOREIGN KEY ("emergencyResourceId") REFERENCES "EmergencyResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_allocatedById_fkey" FOREIGN KEY ("allocatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_optimizationId_fkey" FOREIGN KEY ("optimizationId") REFERENCES "OptimizationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationRun" ADD CONSTRAINT "OptimizationRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationRecommendation" ADD CONSTRAINT "OptimizationRecommendation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OptimizationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurgeSimulation" ADD CONSTRAINT "SurgeSimulation_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalTask" ADD CONSTRAINT "ClinicalTask_assignedDoctorId_fkey" FOREIGN KEY ("assignedDoctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalTask" ADD CONSTRAINT "ClinicalTask_assignedNurseId_fkey" FOREIGN KEY ("assignedNurseId") REFERENCES "Nurse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
