/**
 * Patient dataset for the seeded hospital.
 *
 *   · 12 inpatients (some assigned to the demo doctor/nurse accounts)
 *   ·  8 emergency queue patients — including the multi-resource case P025
 *   · 20 surge-batch patients (P009–P028) used by the surge simulation
 *
 * Clinical priority/triage values are seeded as "recorded by clinical staff";
 * the backend never derives a diagnosis or a priority on its own.
 */

const pad = (value) => String(value).padStart(2, '0');

/** Inpatients occupying ward beds (Bed.patientId is linked at seed time). */
const INPATIENTS = [
  {
    patientNumber: 'IP-2201', bedId: 'ICU-01', name: 'A. Fernandes', age: 64, sex: 'Male', department: 'Intensive Care',
    priority: 'Critical', triage: 'ESI 1', diagnosis: 'Post-operative ventilation dependency', plan: 'Weaning trial — morning round',
    vitals: { heartRate: 108, bp: '98/62', spo2: 94, temp: '37.4°C', respiratoryRate: 22 },
    assignedDoctorId: 'DOC-1161', assignedNurseId: 'NUR-201', requiresVentilator: true,
    notes: 'Ventilated, sedation hold planned for the morning round.', tasks: ['Hourly observations', 'Ventilator charting'],
  },
  {
    patientNumber: 'IP-2202', bedId: 'ICU-02', name: 'B. Krishnan', age: 71, sex: 'Male', department: 'Intensive Care',
    priority: 'Critical', triage: 'ESI 1', diagnosis: 'Acute coronary syndrome — post PCI', plan: 'CCU monitoring, repeat ECG at 12:00',
    vitals: { heartRate: 96, bp: '112/70', spo2: 96, temp: '36.9°C', respiratoryRate: 20 },
    assignedDoctorId: 'DOC-1042', assignedNurseId: 'NUR-201', requiresVentilator: false,
    notes: 'Post-procedure monitoring, inotrope support tapering.', tasks: ['Hourly observations'],
  },
  {
    patientNumber: 'IP-2203', bedId: 'ICU-03', name: 'C. Menon', age: 58, sex: 'Female', department: 'Intensive Care',
    priority: 'Critical', triage: 'ESI 2', diagnosis: 'Severe pneumonia — ventilator dependent', plan: 'Antibiotic day 3, tracheal aspirate sent',
    vitals: { heartRate: 112, bp: '104/66', spo2: 93, temp: '38.2°C', respiratoryRate: 24 },
    assignedDoctorId: 'DOC-1111', assignedNurseId: 'NUR-201', requiresVentilator: true,
    notes: 'Ventilated; prone positioning not indicated at present.', tasks: ['Hourly observations', 'Ventilator charting', 'Medication round'],
  },
  {
    patientNumber: 'IP-2204', bedId: 'ICU-04', name: 'D. Sharma', age: 66, sex: 'Male', department: 'Intensive Care',
    priority: 'High', triage: 'ESI 2', diagnosis: 'Acute kidney injury — dialysis initiated', plan: 'Dialysis cycle review with nephrology',
    vitals: { heartRate: 88, bp: '128/78', spo2: 97, temp: '37.0°C', respiratoryRate: 18 },
    assignedDoctorId: 'DOC-1131', assignedNurseId: 'NUR-202', requiresVentilator: false,
    notes: 'Dialysis in progress under nephrology supervision.', tasks: ['Fluid balance charting'],
  },
  {
    patientNumber: 'IP-2205', bedId: 'ICU-05', name: 'E. Kaur', age: 49, sex: 'Female', department: 'Intensive Care',
    priority: 'High', triage: 'ESI 2', diagnosis: 'Post-operative monitoring — laparotomy', plan: 'Analgesia review, mobilise if stable',
    vitals: { heartRate: 84, bp: '118/74', spo2: 98, temp: '36.8°C', respiratoryRate: 17 },
    assignedDoctorId: 'DOC-1081', assignedNurseId: 'NUR-202', requiresVentilator: false,
    notes: 'Post-operative day 1 — pain score 4/10.', tasks: ['Dressing check'],
  },
  {
    patientNumber: 'IP-2206', bedId: 'ICU-06', name: 'F. Thomas', age: 62, sex: 'Male', department: 'Intensive Care',
    priority: 'Critical', triage: 'ESI 1', diagnosis: 'Septic shock — source control pending', plan: 'Vasopressor titration, repeat cultures',
    vitals: { heartRate: 118, bp: '92/58', spo2: 95, temp: '38.6°C', respiratoryRate: 23 },
    assignedDoctorId: 'DOC-1161', assignedNurseId: 'NUR-206', requiresVentilator: true,
    notes: 'Ventilated; vasopressor requirement rising.', tasks: ['Hourly observations', 'Medication round'],
  },
  {
    patientNumber: 'IP-2207', bedId: 'ICU-07', name: 'G. Pillai', age: 55, sex: 'Female', department: 'Intensive Care',
    priority: 'High', triage: 'ESI 2', diagnosis: 'Diabetic ketoacidosis — resolving', plan: 'Step-down review planned',
    vitals: { heartRate: 92, bp: '120/76', spo2: 97, temp: '37.1°C', respiratoryRate: 18 },
    assignedDoctorId: 'DOC-1211', assignedNurseId: 'NUR-203', requiresVentilator: false,
    notes: 'Biochemistry trending to normal — step-down review on the morning round.', tasks: ['Hourly observations'],
  },
  {
    patientNumber: 'IP-2208', bedId: 'ICU-08', name: 'H. Rao', age: 60, sex: 'Male', department: 'Intensive Care',
    priority: 'Critical', triage: 'ESI 1', diagnosis: 'Head injury — TBI monitoring', plan: 'Neuro obs hourly, CT review',
    vitals: { heartRate: 74, bp: '136/82', spo2: 97, temp: '36.6°C', respiratoryRate: 16 },
    assignedDoctorId: 'DOC-1121', assignedNurseId: 'NUR-205', requiresVentilator: true,
    notes: 'Ventilated, ICP-directed care. Neurosurgery review completed.', tasks: ['Hourly observations', 'Neuro obs charting'],
  },
  {
    patientNumber: 'IP-2211', bedId: 'EMG-01', name: 'I. Fernandes', age: 44, sex: 'Male', department: 'Emergency',
    priority: 'Critical', triage: 'ESI 1', diagnosis: 'Blunt abdominal trauma — theatre in progress', plan: 'Emergency laparotomy, ICU bed requested',
    vitals: { heartRate: 122, bp: '98/60', spo2: 96, temp: '36.4°C', respiratoryRate: 22 },
    assignedDoctorId: 'DOC-1081', assignedNurseId: 'NUR-301', requiresVentilator: true,
    notes: 'In OT-01. Expected ICU requirement after surgery — capacity to be reviewed.', tasks: ['Theatre support'],
  },
  {
    patientNumber: 'IP-2214', bedId: 'EMG-03', name: 'J. Nayak', age: 51, sex: 'Male', department: 'Emergency',
    priority: 'High', triage: 'ESI 2', diagnosis: 'Chest pain — rule out ACS', plan: 'Troponin series, telemetry',
    vitals: { heartRate: 88, bp: '134/84', spo2: 98, temp: '36.7°C', respiratoryRate: 16 },
    assignedDoctorId: 'DOC-1051', assignedNurseId: 'NUR-306', requiresVentilator: false,
    notes: 'Telemetry running; cardiology review requested.', tasks: ['Observation charting'],
  },
  {
    patientNumber: 'IP-2242', bedId: 'GEN-31', name: 'K. Dsouza', age: 47, sex: 'Female', department: 'General Ward',
    priority: 'Medium', triage: 'ESI 3', diagnosis: 'Post-operative observation — orthopaedic', plan: 'Scheduled for femoral fixation',
    vitals: { heartRate: 82, bp: '124/78', spo2: 98, temp: '36.9°C', respiratoryRate: 16 },
    assignedDoctorId: 'DOC-1092', assignedNurseId: 'NUR-404', requiresVentilator: false,
    notes: 'Listed for OT-02 at 11:30 AM. Pre-op checklist started.', tasks: ['Pre-operative checklist'],
  },
  {
    patientNumber: 'IP-2246', bedId: 'GEN-45', name: 'L. Menon', age: 35, sex: 'Male', department: 'General Ward',
    priority: 'Medium', triage: 'ESI 3', diagnosis: 'Wound infection — awaiting procedure', plan: 'Incision and drainage planned',
    vitals: { heartRate: 86, bp: '122/76', spo2: 98, temp: '37.8°C', respiratoryRate: 17 },
    assignedDoctorId: 'DOC-1083', assignedNurseId: 'NUR-401', requiresVentilator: false,
    notes: 'On the surgical backlog list; analgesia adequate.', tasks: ['Wound review'],
  },
];

/** Emergency queue — the operational picture the Command Center monitors. */
const QUEUE_PATIENTS = [
  {
    patientNumber: 'P001', name: 'Queue P001', age: 68, sex: 'Male', department: 'Emergency',
    priority: 'Critical', triage: 'ESI 1', requiredResource: 'ICU Bed', requiresVentilator: true,
    specialtyRequired: 'Critical Care', waitingMinutes: 18, clinicalRequirementBy: 'Dr. Shalini Rao',
    notes: 'Hypotensive with rising oxygen requirement. ICU-level monitoring recorded.',
  },
  {
    patientNumber: 'P002', name: 'Queue P002', age: 54, sex: 'Female', department: 'Emergency',
    priority: 'Critical', triage: 'ESI 1', requiredResource: 'ICU Bed', requiresVentilator: true,
    specialtyRequired: 'Internal Medicine', waitingMinutes: 26, clinicalRequirementBy: 'Dr. Shalini Rao',
    notes: 'Sepsis pathway activated. ICU requirement recorded by the treating team.',
  },
  {
    patientNumber: 'P003', name: 'Queue P003', age: 39, sex: 'Male', department: 'Emergency',
    priority: 'High', triage: 'ESI 2', requiredResource: 'Emergency Bed', requiresVentilator: false,
    specialtyRequired: 'Emergency Medicine', waitingMinutes: 12, clinicalRequirementBy: 'Dr. Kavya Menon',
    notes: 'Monitored bay required for observation.',
  },
  {
    patientNumber: 'P004', name: 'Queue P004', age: 61, sex: 'Female', department: 'Emergency',
    priority: 'High', triage: 'ESI 2', requiredResource: 'General Bed', requiresVentilator: false,
    specialtyRequired: 'General Medicine', waitingMinutes: 34, clinicalRequirementBy: 'Dr. Kavya Menon',
    notes: 'Admission planned; awaiting ward bed.',
  },
  {
    patientNumber: 'P005', name: 'Queue P005', age: 73, sex: 'Male', department: 'Emergency',
    priority: 'High', triage: 'ESI 2', requiredResource: 'ICU Bed', requiresVentilator: false,
    specialtyRequired: 'Cardiology', waitingMinutes: 41, clinicalRequirementBy: 'Dr. Shalini Rao',
    notes: 'Arrhythmia requiring monitored care; ICU review recorded.',
  },
  {
    patientNumber: 'P006', name: 'Queue P006', age: 29, sex: 'Female', department: 'Emergency',
    priority: 'Medium', triage: 'ESI 3', requiredResource: 'General Bed', requiresVentilator: false,
    specialtyRequired: 'General Medicine', waitingMinutes: 22, clinicalRequirementBy: 'Dr. Kavya Menon',
    notes: 'Observation completed; admission for hydration.',
  },
  {
    patientNumber: 'P007', name: 'Queue P007', age: 45, sex: 'Male', department: 'Emergency',
    priority: 'Medium', triage: 'ESI 3', requiredResource: 'Emergency Bed', requiresVentilator: false,
    specialtyRequired: 'Emergency Medicine', waitingMinutes: 15, clinicalRequirementBy: 'Dr. Shalini Rao',
    notes: 'Soft-tissue injury; monitored bay for analgesia.',
  },
  {
    /**
     * The multi-resource emergency case the whole demo turns on (§53):
     * ICU + emergency OT + ventilator + specialist + nurse, at once.
     */
    patientNumber: 'P025', name: 'Queue P025 — multi-resource emergency', age: 42, sex: 'Male', department: 'Emergency',
    priority: 'Critical', triage: 'ESI 1', requiredResource: 'ICU Bed', secondaryResource: 'OT Complex',
    specialtyRequired: 'General Surgery', requiresVentilator: true, needsOt: true,
    waitingMinutes: 9, clinicalRequirementBy: 'Dr. Shalini Rao',
    notes:
      'Multi-resource requirement recorded by the treating team: ICU-level bed, emergency theatre, ventilator, general surgery specialist and nursing support. Coordination review required — no resource may be taken from an existing patient without authorisation.',
  },
];

/** Surge batch — introduced as a simulation snapshot, never as live data (§28–29). */
const SURGE_PATIENTS = Array.from({ length: 20 }, (_, index) => {
  const number = index + 9; // P009 … P028
  const critical = index < 8;
  const high = index >= 8 && index < 14;
  const triage = critical ? 'ESI 1' : high ? 'ESI 2' : 'ESI 3';
  const priority = critical ? 'Critical' : high ? 'High' : 'Medium';
  const resource = critical ? 'ICU Bed' : high ? 'Emergency Bed' : 'General Bed';
  const specialty = ['Emergency Medicine', 'General Surgery', 'Internal Medicine', 'Pulmonology'][index % 4];
  return {
    patientNumber: `P${pad(number)}`,
    name: `Surge case P${pad(number)}`,
    age: 25 + ((index * 7) % 55),
    sex: index % 2 === 0 ? 'Male' : 'Female',
    department: 'Emergency',
    priority,
    triage,
    requiredResource: resource,
    secondaryResource: index % 3 === 0 ? 'OT Complex' : null,
    specialtyRequired: specialty,
    requiresVentilator: critical && index % 2 === 0,
    needsOt: index % 5 === 0,
    waitingMinutes: index < 12 ? 9 + index : 0,
    clinicalRequirementBy: index % 2 === 0 ? 'Dr. Shalini Rao' : 'Dr. Kavya Menon',
    notes: 'Mass-casualty intake — requirement recorded at triage.',
  };
});

/** Clinical tasks (nurse/doctor duty lists) — see seeds/tasks.js for the table. */

module.exports = { INPATIENTS, QUEUE_PATIENTS, SURGE_PATIENTS };
