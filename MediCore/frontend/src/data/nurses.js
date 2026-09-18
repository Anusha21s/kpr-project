import { getCurrentShiftBlock, getNextShiftBlock } from './hospitalData';

const ACTIVE_SHIFT = getCurrentShiftBlock();
const INCOMING_SHIFT = getNextShiftBlock();

/**
 * Nurse roster. Availability and patient load are the operational inputs used
 * by the workload constraints in the optimization engine.
 * workload: 'Low' (1–2 patients) | 'Moderate' (3–4) | 'High' (5+)
 */
const nurse = (id, name, department, assignedPatients, workload, availability, currentAssignment) => ({
  id,
  name,
  department,
  shift: ACTIVE_SHIFT.label,
  shiftBlock: ACTIVE_SHIFT.id,
  dutyStatus: 'ON_DUTY',
  assignedPatients,
  workload,
  availability,
  currentAssignment,
});

const offShift = (id, name, department, currentAssignment) => ({
  id,
  name,
  department,
  shift: INCOMING_SHIFT.label,
  shiftBlock: INCOMING_SHIFT.id,
  dutyStatus: 'OFF_DUTY',
  assignedPatients: 0,
  workload: 'Low',
  availability: 'Unavailable',
  currentAssignment,
});

const nextShiftLabel = INCOMING_SHIFT.label;

export const NURSES = [
  // ICU (10)
  nurse('NUR-201', 'Nurse Priya', 'ICU', 5, 'High', 'Assigned', 'ICU-02 to ICU-06 — ventilated patients'),
  nurse('NUR-202', 'Nurse Anjali Das', 'ICU', 5, 'High', 'Assigned', 'ICU-01, ICU-03, ICU-07 to ICU-09'),
  nurse('NUR-203', 'Nurse Ramesh Pillai', 'ICU', 4, 'Moderate', 'Assigned', 'ICU-10 and step-down review'),
  nurse('NUR-204', 'Nurse Fatima Beevi', 'ICU', 0, 'Low', 'Available', 'Standby — ICU central station'),
  nurse('NUR-205', 'Nurse Suresh Kumar', 'ICU', 4, 'Moderate', 'Assigned', 'ICU arterial line care round'),
  nurse('NUR-206', 'Nurse Deepa Suresh', 'ICU', 5, 'High', 'Assigned', 'ICU-04, ICU-05 post-operative care'),
  nurse('NUR-207', 'Nurse Manoj Nair', 'ICU', 0, 'Low', 'Available', 'Standby — ICU float'),
  nurse('NUR-208', 'Nurse Rekha Menon', 'ICU', 3, 'Moderate', 'Assigned', 'ICU documentation and handover'),
  nurse('NUR-209', 'Nurse Biju Thomas', 'ICU', 3, 'Moderate', 'Assigned', 'ICU proning protocol support'),
  nurse('NUR-210', 'Nurse Saritha Raj', 'ICU', 4, 'Moderate', 'Assigned', 'ICU dialysis support'),
  // Emergency (12)
  nurse('NUR-301', 'Nurse Aisha Khan', 'Emergency', 5, 'High', 'Assigned', 'Resus bay 1 — critical patient'),
  nurse('NUR-302', 'Nurse Vinod Menon', 'Emergency', 5, 'High', 'Assigned', 'Emergency bays 2–4'),
  nurse('NUR-303', 'Nurse Lakshmi Pillai', 'Emergency', 4, 'Moderate', 'Assigned', 'Triage desk support'),
  nurse('NUR-304', 'Nurse Sandeep Rao', 'Emergency', 0, 'Low', 'Available', 'Standby — emergency intake'),
  nurse('NUR-305', 'Nurse Meena Kumari', 'Emergency', 0, 'Low', 'Available', 'Standby — emergency intake'),
  nurse('NUR-306', 'Nurse Girish Babu', 'Emergency', 4, 'Moderate', 'Assigned', 'Minor injuries bay'),
  nurse('NUR-307', 'Nurse Nithya Ramesh', 'Emergency', 3, 'Moderate', 'Assigned', 'Observation bay 1'),
  nurse('NUR-308', 'Nurse Shruti Nambiar', 'Emergency', 0, 'Low', 'Available', 'Standby — emergency float'),
  nurse('NUR-309', 'Nurse Anand Krishnan', 'Emergency', 4, 'Moderate', 'Assigned', 'Emergency documentation'),
  nurse('NUR-310', 'Nurse Preethi Suresh', 'Emergency', 5, 'High', 'Assigned', 'Resus bay 2'),
  nurse('NUR-311', 'Nurse Rahul Das', 'Emergency', 3, 'Moderate', 'Assigned', 'Ambulance handover desk'),
  nurse('NUR-312', 'Nurse Zoya Fatima', 'Emergency', 0, 'Low', 'Available', 'Standby — emergency intake'),
  // General Ward (14)
  nurse('NUR-401', 'Nurse Geetha Nair', 'General Ward', 5, 'High', 'Assigned', 'General Ward beds GW-01 to GW-08'),
  nurse('NUR-402', 'Nurse Sunil Mathew', 'General Ward', 5, 'High', 'Assigned', 'General Ward beds GW-09 to GW-16'),
  nurse('NUR-403', 'Nurse Arya Krishnan', 'General Ward', 4, 'Moderate', 'Assigned', 'General Ward beds GW-17 to GW-24'),
  nurse('NUR-404', 'Nurse Nikhil Varma', 'General Ward', 4, 'Moderate', 'Assigned', 'General Ward medication round'),
  nurse('NUR-405', 'Nurse Shilpa Menon', 'General Ward', 0, 'Low', 'Available', 'Standby — ward admissions'),
  nurse('NUR-406', 'Nurse Joseph Thomas', 'General Ward', 3, 'Moderate', 'Assigned', 'General Ward beds GW-25 to GW-30'),
  nurse('NUR-407', 'Nurse Divya Rajan', 'General Ward', 5, 'High', 'Assigned', 'General Ward acute bays'),
  nurse('NUR-408', 'Nurse Kannan Subbu', 'General Ward', 0, 'Low', 'Available', 'Standby — ward float'),
  nurse('NUR-409', 'Nurse Bhavana Rao', 'General Ward', 4, 'Moderate', 'Assigned', 'General Ward beds GW-31 to GW-38'),
  nurse('NUR-410', 'Nurse Tarun Pillai', 'General Ward', 3, 'Moderate', 'Assigned', 'General Ward dressing round'),
  nurse('NUR-411', 'Nurse Swetha Nair', 'General Ward', 0, 'Low', 'Available', 'Standby — ward admissions'),
  nurse('NUR-412', 'Nurse Irfan Ahmed', 'General Ward', 4, 'Moderate', 'Assigned', 'General Ward beds GW-39 to GW-45'),
  nurse('NUR-413', 'Nurse Vimala Devi', 'General Ward', 5, 'High', 'Assigned', 'General Ward high-dependency bays'),
  nurse('NUR-414', 'Nurse Rakesh Menon', 'General Ward', 3, 'Moderate', 'Assigned', 'General Ward night chart updates'),
  // OT complex (4)
  nurse('NUR-501', 'Nurse Sneha George', 'OT Complex', 1, 'Low', 'Assigned', 'OT-01 circulating nurse'),
  nurse('NUR-502', 'Nurse Ashok Kumar', 'OT Complex', 1, 'Low', 'Assigned', 'OT-02 scrub nurse'),
  nurse('NUR-503', 'Nurse Priyanka Das', 'OT Complex', 0, 'Low', 'Available', 'Standby — OT-03 recovery bay'),
  nurse('NUR-504', 'Nurse Harsha Vardhan', 'OT Complex', 0, 'Low', 'Available', 'Standby — OT instrument set check'),
  // Maternity & Paediatrics (6)
  nurse('NUR-601', 'Nurse Sona Mathew', 'Maternity & Paediatrics', 5, 'High', 'Assigned', 'Labour room 2'),
  nurse('NUR-602', 'Nurse Reshma Khan', 'Maternity & Paediatrics', 4, 'Moderate', 'Assigned', 'Post-natal beds MP-01 to MP-06'),
  nurse('NUR-603', 'Nurse Vinaya Ravi', 'Maternity & Paediatrics', 3, 'Moderate', 'Assigned', 'Paediatric ward beds MP-07 to MP-12'),
  nurse('NUR-604', 'Nurse Alok Nath', 'Maternity & Paediatrics', 0, 'Low', 'Available', 'Standby — paediatric admissions'),
  nurse('NUR-605', 'Nurse Chithra Suresh', 'Maternity & Paediatrics', 4, 'Moderate', 'Assigned', 'Nursery and newborn care'),
  nurse('NUR-606', 'Nurse Dileep Chandran', 'Maternity & Paediatrics', 0, 'Low', 'Available', 'Standby — maternity float'),
  // Off shift
  offShift('NUR-701', 'Nurse Beena Joseph', 'ICU', `Off duty — returns ${nextShiftLabel}`),
  offShift('NUR-702', 'Nurse Sameer Ali', 'Emergency', `Off duty — returns ${nextShiftLabel}`),
  offShift('NUR-703', 'Nurse Anupama Nair', 'General Ward', `Off duty — returns ${nextShiftLabel}`),
  offShift('NUR-704', 'Nurse Krishnan Unni', 'OT Complex', `Off duty — returns ${nextShiftLabel}`),
];

/** Nurse-to-patient workload constraint used by the allocation screens. */
export const NURSE_WORKLOAD_LIMIT = 5;

export const DEPARTMENT_ROSTER = [
  { department: 'ICU', onDuty: 10, available: 2, assigned: 8, patientLoad: 33, limit: 50 },
  { department: 'Emergency', onDuty: 12, available: 5, assigned: 7, patientLoad: 33, limit: 60 },
  { department: 'General Ward', onDuty: 14, available: 4, assigned: 10, patientLoad: 52, limit: 70 },
  { department: 'OT Complex', onDuty: 4, available: 2, assigned: 2, patientLoad: 2, limit: 20 },
  { department: 'Maternity & Paediatrics', onDuty: 6, available: 2, assigned: 4, patientLoad: 16, limit: 30 },
];

export const getNurseById = (id) => NURSES.find((entry) => entry.id === id) || null;
