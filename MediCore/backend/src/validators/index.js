/**
 * Zod validators (§17).
 *
 * Every request body, query and param is validated before it reaches a service.
 * A rejected payload produces HTTP 400 with `{success:false,error:{code,message,details}}`
 * and never reaches the database.
 */

const { z } = require('zod');

const PRIORITY = z.enum(['Critical', 'High', 'Medium', 'Low']);
const DUTY_STATUS = z.enum(['ON_DUTY', 'OFF_DUTY', 'LEAVE', 'UNAVAILABLE']);
const AVAILABILITY = z.enum(['Available', 'Assigned', 'InProcedure', 'Unavailable']);
const BED_STATUS = z.enum(['Available', 'Occupied', 'Reserved', 'Cleaning', 'Maintenance']);

/* ------------------------------------------------------------------ auth */
const loginSchema = z.object({
  staffId: z.string().trim().min(2).max(32),
  password: z.string().min(4).max(128),
});

/* ------------------------------------------------------------------ ids */
const idParam = (name = 'id') => z.object({ [name]: z.string().trim().min(1).max(64) });

const codeParam = (name = 'staffId') => z.object({ [name]: z.string().trim().min(1).max(64) });

/* ------------------------------------------------------------- pagination */
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().trim().max(80).optional(),
});

/* ------------------------------------------------------------- patients */
const patientQuery = pagination.extend({
  ward: z.string().trim().max(60).optional(),
  priority: PRIORITY.optional(),
  status: z.string().trim().max(40).optional(),
  specialty: z.string().trim().max(60).optional(),
  assignedDoctor: z.string().trim().max(64).optional(),
  assignedNurse: z.string().trim().max(64).optional(),
  mine: z.enum(['true', 'false']).optional(),
  inQueue: z.enum(['true', 'false']).optional(),
});

const requirementSchema = z.object({
  requirement: z.string().trim().min(3).max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

const patientCreateSchema = z.object({
  patientNumber: z.string().trim().max(32).optional(),
  name: z.string().trim().min(1).max(80),
  age: z.coerce.number().int().min(0).max(130).optional(),
  sex: z.string().trim().max(20).optional(),
  department: z.string().trim().max(60).default('Emergency'),
  priority: PRIORITY.default('Medium'),
  triage: z.string().trim().max(60).default('ESI 3'),
  requiredResource: z.string().trim().max(80).optional(),
  secondaryResource: z.string().trim().max(80).optional(),
  specialtyRequired: z.string().trim().max(80).optional(),
  requiresVentilator: z.boolean().default(false),
  needsOt: z.boolean().default(false),
  clinicalRequirementBy: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
  diagnosis: z.string().trim().max(200).optional(),
  status: z.string().trim().max(40).default('Waiting'),
  assignedBedId: z.string().trim().max(64).nullable().optional(),
  assignedDoctorId: z.string().trim().max(64).nullable().optional(),
  assignedNurseId: z.string().trim().max(64).nullable().optional(),
});

const patientUpdateSchema = z.object({
  name: z.string().trim().max(80).optional(),
  age: z.coerce.number().int().min(0).max(130).optional(),
  sex: z.string().trim().max(20).optional(),
  department: z.string().trim().max(60).optional(),
  priority: PRIORITY.optional(),
  triage: z.string().trim().max(60).optional(),
  status: z.string().trim().max(40).optional(),
  requiredResource: z.string().trim().max(80).nullable().optional(),
  secondaryResource: z.string().trim().max(80).nullable().optional(),
  specialtyRequired: z.string().trim().max(80).nullable().optional(),
  requiresVentilator: z.boolean().optional(),
  needsOt: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
  diagnosis: z.string().trim().max(200).optional(),
  assignedBedId: z.string().trim().max(64).nullable().optional(),
  assignedDoctorId: z.string().trim().max(64).nullable().optional(),
  assignedNurseId: z.string().trim().max(64).nullable().optional(),
});

const patientDischargeSchema = z.object({
  reason: z.string().trim().max(300).default('Discharged by authorized clinical/command staff'),
});

/* --------------------------------------------------------------- queue */
const queueQuery = pagination.extend({
  priority: PRIORITY.optional(),
  resource: z.string().trim().max(60).optional(),
  specialty: z.string().trim().max(60).optional(),
  status: z.string().trim().max(40).optional(),
});

const queueEntrySchema = z.object({
  patientNumber: z.string().trim().regex(/^[A-Za-z]{1,4}-?\d{2,6}$/, 'Use a patient number such as P030 or IP-2250.'),
  name: z.string().trim().max(80).optional(),
  age: z.coerce.number().int().min(0).max(130).optional(),
  sex: z.string().trim().max(20).optional(),
  department: z.string().trim().max(60).optional(),
  priority: PRIORITY.optional(),
  triage: z.string().trim().max(20).optional(),
  requiredResource: z.string().trim().max(60).optional(),
  secondaryResource: z.string().trim().max(60).optional(),
  specialtyRequired: z.string().trim().max(60).optional(),
  requiresVentilator: z.boolean().optional(),
  needsOt: z.boolean().optional(),
  waitingMinutes: z.coerce.number().int().min(0).max(2880).optional(),
  notes: z.string().trim().max(500).optional(),
});

const escalationSchema = z.object({ reason: z.string().trim().min(4).max(300) });

/* ---------------------------------------------------------------- beds */
const BED_FILTER_STATUS = z
  .enum(['Available', 'Occupied', 'Reserved', 'Cleaning', 'Maintenance', 'AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'MAINTENANCE'])
  .optional();

const bedQuery = z.object({
  wardId: z.enum(['general', 'icu', 'emergency', 'maternity']).optional(),
  status: BED_FILTER_STATUS,
});

const bedAssignSchema = z.object({
  patientId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(300).optional(),
});

const bedReleaseSchema = z.object({ reason: z.string().trim().min(4).max(300).optional() });

const bedStatusSchema = z.object({
  status: BED_STATUS,
  heldFor: z.string().trim().max(200).optional(),
});

/* --------------------------------------------------------------- staff */
const doctorQuery = pagination.extend({
  duty: DUTY_STATUS.optional(),
  specialty: z.string().trim().max(60).optional(),
  available: z.enum(['true', 'false']).optional(),
});

const nurseQuery = pagination.extend({
  duty: DUTY_STATUS.optional(),
  department: z.string().trim().max(60).optional(),
  available: z.enum(['true', 'false']).optional(),
});

const dutySchema = z
  .object({
    dutyStatus: DUTY_STATUS.optional(),
    availability: AVAILABILITY.optional(),
    currentAssignment: z.string().trim().max(120).optional(),
    rationale: z.string().trim().max(300).optional(),
  })
  .refine((value) => value.dutyStatus || value.availability || value.currentAssignment, {
    message: 'Provide a duty status, an availability or an assignment to change.',
  });

/* ----------------------------------------------------------- equipment */
const equipmentQuery = z.object({
  kind: z.string().trim().max(40).optional(),
  categoryId: z.string().trim().max(40).optional(),
  available: z.enum(['true', 'false']).optional(),
});

const equipmentReserveSchema = z.object({
  categoryId: z.string().trim().min(1).max(40),
  quantity: z.coerce.number().int().min(1).max(50).default(1),
  unitIds: z.array(z.string().trim().max(64)).max(50).optional(),
  reservedFor: z.string().trim().min(3).max(200),
});

const equipmentReleaseSchema = z.object({
  categoryId: z.string().trim().min(1).max(40),
  unitIds: z.array(z.string().trim().max(64)).max(50).optional(),
  reason: z.string().trim().max(200).optional(),
});

/* --------------------------------------------------- emergency resources */
const emergencyReinforceSchema = z.object({
  resourceId: z.string().trim().min(1).max(60),
  action: z.enum(['hold', 'release']).default('hold'),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
  note: z.string().trim().max(200).optional(),
});

/* ------------------------------------------------------------------ OT */
const otHoldSchema = z.object({
  theatreId: z.string().trim().regex(/^OT-\d{2}$/i, 'Use a theatre id such as OT-03.'),
  patientId: z.string().trim().max(64).optional(),
  reason: z.string().trim().min(4).max(200).optional(),
  minutes: z.coerce.number().int().min(30).max(480).optional(),
});

const otReleaseSchema = z.object({ reason: z.string().trim().max(200).optional() });

/* ---------------------------------------------------------- simulation */
const simulationSchema = z.object({
  scenario: z.enum(['MASS_CASUALTY_INTAKE']).default('MASS_CASUALTY_INTAKE'),
  patientCount: z.coerce.number().int().min(1).max(30).default(20),
  offset: z.coerce.number().int().min(0).max(200).default(8),
});

/* --------------------------------------------------------------- AI layer */
const advisorySchema = z.object({
  includeSimulation: z.boolean().optional().default(false),
  surgePatientCount: z.coerce.number().int().min(1).max(200).optional().default(20),
});

const aiSimulationSchema = z.object({
  patientCount: z.coerce.number().int().min(1).max(200).default(20),
  scenario: z.enum(['MASS_CASUALTY_INTAKE', 'MULTI_VEHICLE_ACCIDENT', 'INDUSTRIAL_INCIDENT', 'SEASONAL_RESPIRATORY']).default('MASS_CASUALTY_INTAKE'),
});

const aiRunQuery = z.object({
  kind: z.enum(['ADVISORY', 'SIMULATION']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const aiPredictionQuery = z.object({
  target: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/* -------------------------------------------------------- optimization */
const optimizationSchema = z.object({
  selections: z.record(z.string(), z.string().max(60)).default({}),
  mode: z.enum(['current', 'surge']).default('current'),
  createApproval: z.boolean().default(true),
});

const rejectionSchema = z.object({ reason: z.string().trim().min(4).max(300) });

/* ----------------------------------------------------------- allocation */
const approvalDecisionSchema = z.object({
  selections: z.record(z.string(), z.string().max(60)).default({}),
  note: z.string().trim().max(300).optional(),
});

const allocationQuery = z.object({
  status: z.enum(['PROPOSED', 'PENDING_APPROVAL', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'Pending Approval', 'Confirmed', 'Rejected']).optional(),
  approvalId: z.string().trim().max(64).optional(),
});

/* --------------------------------------------------------------- alerts */
const alertQuery = pagination.extend({
  status: z.enum(['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'Active', 'Acknowledged', 'Resolved']).optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'OPERATIONAL', 'INFO']).optional(),
  category: z.string().trim().max(40).optional(),
});

/* -------------------------------------------------------- notifications */
const notificationQuery = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/* --------------------------------------------------------------- tasks */
const taskQuery = z.object({
  status: z.enum(['Open', 'Completed']).optional(),
  patientId: z.string().trim().max(64).optional(),
  department: z.string().trim().max(60).optional(),
});

const taskNoteSchema = z.object({ note: z.string().trim().min(3).max(500) });

module.exports = {
  z,
  PRIORITY,
  DUTY_STATUS,
  AVAILABILITY,
  loginSchema,
  idParam,
  codeParam,
  patientQuery,
  patientCreateSchema,
  patientUpdateSchema,
  patientDischargeSchema,
  requirementSchema,
  queueQuery,
  queueEntrySchema,
  escalationSchema,
  advisorySchema,
  aiSimulationSchema,
  aiRunQuery,
  aiPredictionQuery,
  bedQuery,
  bedAssignSchema,
  bedReleaseSchema,
  bedStatusSchema,
  doctorQuery,
  nurseQuery,
  dutySchema,
  equipmentQuery,
  equipmentReserveSchema,
  equipmentReleaseSchema,
  emergencyReinforceSchema,
  otHoldSchema,
  otReleaseSchema,
  simulationSchema,
  optimizationSchema,
  rejectionSchema,
  approvalDecisionSchema,
  allocationQuery,
  alertQuery,
  notificationQuery,
  taskQuery,
  taskNoteSchema,
};
