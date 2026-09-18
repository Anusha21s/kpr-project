/**
 * Patient queue model.
 *
 * The emergency queue always starts with 8 patients (2 critical) so the
 * Command Center KPI cards match the operational baseline used in the demo.
 * A deterministic surge batch of 20 additional patients is defined separately
 * and injected by the simulation engine.
 *
 * `clinicalRequirementBy` records who determined the clinical requirement —
 * MediCore never decides treatment; it only coordinates the resources that
 * clinical staff have already requested.
 */

export const QUEUE_STATUS = {
  WAITING: 'Waiting',
  ASSESSMENT: 'In Assessment',
  AWAITING_ALLOCATION: 'Awaiting Allocation',
  ALLOCATION_PROPOSED: 'Allocation Proposed',
  ALLOCATED: 'Allocated',
};

export const patient = (data) => ({
  requiresVentilator: false,
  secondaryResource: null,
  source: 'Emergency Desk',
  ...data,
});

export const INITIAL_QUEUE = [
  patient({
    id: 'P001',
    age: 62,
    sex: 'Male',
    department: 'Emergency',
    priority: 'Critical',
    requiredResource: 'ICU Bed',
    specialtyRequired: 'Intensive Care',
    requiresVentilator: true,
    waitingMinutes: 4,
    status: QUEUE_STATUS.WAITING,
    triage: 'ESI 1',
    clinicalRequirementBy: 'Dr. Divya Krishnan',
    notes: 'Acute respiratory failure — ICU bed with ventilator support requested by clinical team.',
  }),
  patient({
    id: 'P002',
    age: 45,
    sex: 'Female',
    department: 'Emergency',
    priority: 'High',
    requiredResource: 'Emergency Bed',
    specialtyRequired: 'Emergency Medicine',
    waitingMinutes: 11,
    status: QUEUE_STATUS.WAITING,
    triage: 'ESI 2',
    clinicalRequirementBy: 'Dr. Shalini Rao',
    notes: 'Severe abdominal pain with tachycardia — monitored emergency bay requested.',
  }),
  patient({
    id: 'P003',
    age: 34,
    sex: 'Male',
    department: 'General Medicine',
    priority: 'Medium',
    requiredResource: 'General Bed',
    specialtyRequired: 'General Medicine',
    waitingMinutes: 20,
    status: QUEUE_STATUS.WAITING,
    triage: 'ESI 3',
    clinicalRequirementBy: 'Dr. Harish Patel',
    notes: 'Admission for IV antibiotics and hydration — general ward bed requested.',
  }),
  patient({
    id: 'P004',
    age: 58,
    sex: 'Male',
    department: 'Emergency',
    priority: 'Critical',
    requiredResource: 'Resuscitation Bay',
    secondaryResource: 'ICU Bed',
    specialtyRequired: 'Emergency Medicine',
    requiresVentilator: true,
    waitingMinutes: 6,
    status: QUEUE_STATUS.ASSESSMENT,
    triage: 'ESI 1',
    clinicalRequirementBy: 'Dr. Divya Krishnan',
    notes: 'Post-resuscitation, unstable vitals. ICU bed flagged as next-step requirement.',
  }),
  patient({
    id: 'P005',
    age: 71,
    sex: 'Female',
    department: 'General Surgery',
    priority: 'High',
    requiredResource: 'ICU Bed',
    specialtyRequired: 'Intensive Care',
    waitingMinutes: 14,
    status: QUEUE_STATUS.AWAITING_ALLOCATION,
    triage: 'ESI 2',
    clinicalRequirementBy: 'Dr. Rajesh Iyer',
    notes: 'Post-operative monitoring requested by surgical team following emergency laparotomy.',
  }),
  patient({
    id: 'P006',
    age: 29,
    sex: 'Female',
    department: 'Emergency',
    priority: 'High',
    requiredResource: 'Emergency Bed',
    specialtyRequired: 'Emergency Medicine',
    waitingMinutes: 16,
    status: QUEUE_STATUS.WAITING,
    triage: 'ESI 2',
    clinicalRequirementBy: 'Dr. Anil Mathew',
    notes: 'Suspected fracture with head injury — monitored emergency bay requested.',
  }),
  patient({
    id: 'P007',
    age: 66,
    sex: 'Male',
    department: 'Cardiology',
    priority: 'Medium',
    requiredResource: 'General Bed',
    specialtyRequired: 'Cardiology',
    waitingMinutes: 22,
    status: QUEUE_STATUS.WAITING,
    triage: 'ESI 3',
    clinicalRequirementBy: 'Dr. Kumar',
    notes: 'Chest pain rule-out, telemetry monitoring requested on general ward.',
  }),
  patient({
    id: 'P008',
    age: 52,
    sex: 'Female',
    department: 'Orthopaedics',
    priority: 'Low',
    requiredResource: 'General Bed',
    specialtyRequired: 'Orthopaedics',
    waitingMinutes: 27,
    status: QUEUE_STATUS.WAITING,
    triage: 'ESI 4',
    clinicalRequirementBy: 'Dr. Vikram Sethi',
    notes: 'Closed fracture reduction completed — ward bed for observation requested.',
  }),
];

const surgePatient = (id, age, sex, data) =>
  patient({
    id,
    age,
    sex,
    source: 'Surge Intake',
    triage: 'ESI 2',
    waitingMinutes: 0,
    status: QUEUE_STATUS.WAITING,
    clinicalRequirementBy: 'Emergency triage team',
    ...data,
  });

/**
 * Deterministic surge batch — 20 additional emergency patients (P009–P028).
 * Resource mix is fixed so the optimisation output is reproducible:
 * 6 ICU + 2 ventilator-only critical + 8 emergency beds + 3 general beds + 1 resuscitation bay.
 */
export const SURGE_BATCH = [
  surgePatient('P009', 41, 'Male', { department: 'Emergency', priority: 'Critical', requiredResource: 'ICU Bed', specialtyRequired: 'Intensive Care', requiresVentilator: true, triage: 'ESI 1', notes: 'Collapse at RTA site — advanced airway support, ICU bed requested.' }),
  surgePatient('P010', 37, 'Female', { department: 'Emergency', priority: 'Critical', requiredResource: 'ICU Bed', specialtyRequired: 'Intensive Care', requiresVentilator: true, triage: 'ESI 1', notes: 'Multi-trauma with hypotension — ICU bed and ventilator requested.' }),
  surgePatient('P011', 55, 'Male', { department: 'Emergency', priority: 'Critical', requiredResource: 'ICU Bed', specialtyRequired: 'Intensive Care', requiresVentilator: true, triage: 'ESI 1', notes: 'Crush injury with metabolic acidosis — ICU bed requested.' }),
  surgePatient('P012', 63, 'Male', { department: 'Emergency', priority: 'Critical', requiredResource: 'ICU Bed', specialtyRequired: 'Intensive Care', requiresVentilator: true, triage: 'ESI 1', notes: 'Chest trauma — bilateral drain inserted, ICU monitoring requested.' }),
  surgePatient('P013', 28, 'Female', { department: 'Emergency', priority: 'Critical', requiredResource: 'ICU Bed', specialtyRequired: 'Intensive Care', requiresVentilator: true, triage: 'ESI 1', notes: 'Post-partum haemorrhage stabilised — ICU bed requested.' }),
  surgePatient('P014', 49, 'Male', { department: 'Emergency', priority: 'Critical', requiredResource: 'ICU Bed', specialtyRequired: 'Intensive Care', requiresVentilator: true, triage: 'ESI 1', notes: 'Head injury with GCS 9 — ICU bed requested by clinical team.' }),
  surgePatient('P015', 60, 'Male', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'Emergency Medicine', triage: 'ESI 2', notes: 'Blunt abdominal trauma — monitored emergency bay requested.' }),
  surgePatient('P016', 33, 'Female', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'Emergency Medicine', triage: 'ESI 2', notes: 'Multiple long-bone injuries — monitored emergency bay requested.' }),
  surgePatient('P017', 46, 'Male', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'Orthopaedics', triage: 'ESI 2', notes: 'Open fracture — emergency bay with orthopaedic review requested.' }),
  surgePatient('P018', 24, 'Male', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'Emergency Medicine', triage: 'ESI 2', notes: 'Chest contusion with hypoxia — monitored bay requested.' }),
  surgePatient('P019', 70, 'Female', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'Cardiology', triage: 'ESI 2', notes: 'Suspected acute coronary syndrome — monitored emergency bay requested.' }),
  surgePatient('P020', 38, 'Male', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'Emergency Medicine', triage: 'ESI 2', notes: 'Scalp laceration with concussion — emergency bay requested.' }),
  surgePatient('P021', 52, 'Female', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'Emergency Medicine', triage: 'ESI 2', notes: 'Smoke inhalation, mild distress — monitored bay requested.' }),
  surgePatient('P022', 44, 'Male', { department: 'Emergency', priority: 'High', requiredResource: 'Emergency Bed', specialtyRequired: 'General Surgery', triage: 'ESI 2', notes: 'Penetrating abdominal injury — emergency bay requested pending surgical review.' }),
  surgePatient('P023', 31, 'Female', { department: 'Emergency', priority: 'Medium', requiredResource: 'General Bed', specialtyRequired: 'General Medicine', triage: 'ESI 3', notes: 'Soft tissue injuries with dehydration — general ward bed requested.' }),
  surgePatient('P024', 27, 'Male', { department: 'General Medicine', priority: 'Medium', requiredResource: 'General Bed', specialtyRequired: 'General Medicine', triage: 'ESI 3', notes: 'Observation admission after trauma screening — general bed requested.' }),
  surgePatient('P025', 35, 'Male', { department: 'Emergency', priority: 'Critical', requiredResource: 'ICU Bed', secondaryResource: 'OT Complex', specialtyRequired: 'Anaesthesiology', requiresVentilator: true, triage: 'ESI 1', needsOt: true, notes: 'Polytrauma with internal bleeding — ICU bed, emergency OT, specialist and ventilator all requested.' }),
  surgePatient('P026', 40, 'Male', { department: 'Emergency', priority: 'Critical', requiredResource: 'Ventilator', secondaryResource: 'ICU Bed', specialtyRequired: 'Pulmonology', requiresVentilator: true, triage: 'ESI 1', notes: 'Respiratory failure — ventilator and ICU bed requested.' }),
  surgePatient('P027', 68, 'Female', { department: 'Emergency', priority: 'Critical', requiredResource: 'Ventilator', secondaryResource: 'ICU Bed', specialtyRequired: 'Pulmonology', requiresVentilator: true, triage: 'ESI 1', notes: 'COPD decompensation — non-invasive ventilation escalated, ICU bed requested.' }),
  surgePatient('P028', 56, 'Male', { department: 'Emergency', priority: 'Critical', requiredResource: 'Resuscitation Bay', specialtyRequired: 'Cardiology', requiresVentilator: true, triage: 'ESI 1', notes: 'Cardiac arrest, ROSC achieved — resuscitation bay and cardiology support requested.' }),
];

/** The single case used by the multi-resource conflict detector. */
export const CONFLICT_CASE_ID = 'P025';

export const getPatientById = (patients, id) => patients.find((entry) => entry.id === id) || null;

export const countByPriority = (patients, priority) =>
  patients.filter((entry) => entry.priority === priority).length;

export const countRequiringResource = (patients, resource) =>
  patients.filter(
    (entry) => entry.requiredResource === resource || entry.secondaryResource === resource,
  ).length;
