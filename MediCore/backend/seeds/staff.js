/**
 * Staff roster — 30 doctors, 70 nurses, with duty state.
 *
 * Duty status is a first-class column here because the optimizer may only
 * allocate ON_DUTY staff (§14, §17). A few staff are deliberately OFF_DUTY /
 * LEAVE / UNAVAILABLE so the eligibility rule is demonstrable:
 *   DOC-1081 Dr. Rajesh Iyer  — General Surgery — ON_DUTY   (eligible)
 *   DOC-1082 Dr. Neha Kulkarni— General Surgery — OFF_DUTY  (must never be proposed)
 */

const { SHIFTS, NURSE_WORKLOAD_LIMIT, DOCTOR_WORKLOAD_LIMIT } = require('./constants');

const MORNING = SHIFTS.MORNING;
const EVENING = SHIFTS.EVENING;

/* id, name, specialty, department, dutyStatus, availability, workload, patients, assignment, since, contact, shiftBlock */
const DOCTOR_ROWS = [
  ['DOC-1042', 'Dr. Kumar', 'Cardiology', 'Cardiology', 'ON_DUTY', 'Available', 'Moderate', 12, 'Cardiology OPD — ward round', '08:05', 'Ext. 1042', 'MORNING'],
  ['DOC-1043', 'Dr. Sudha Ramachandran', 'Cardiology', 'Cardiology', 'ON_DUTY', 'Assigned', 'High', 16, 'CCU — post-angioplasty monitoring', '08:00', 'Ext. 1043', 'MORNING'],
  ['DOC-1051', 'Dr. Shalini Rao', 'Emergency Medicine', 'Emergency', 'ON_DUTY', 'Available', 'Moderate', 7, 'Emergency triage desk', '08:00', 'Ext. 1051', 'MORNING'],
  ['DOC-1052', 'Dr. Arun Balakrishnan', 'Emergency Medicine', 'Emergency', 'ON_DUTY', 'Assigned', 'High', 18, 'Resuscitation bay — critical intake', '07:55', 'Ext. 1052', 'MORNING'],
  ['DOC-1053', 'Dr. Kavya Menon', 'Emergency Medicine', 'Emergency', 'ON_DUTY', 'InProcedure', 'High', 14, 'Emergency OT — procedure support', '08:00', 'Ext. 1053', 'MORNING'],
  ['DOC-1061', 'Dr. Harish Prabhu', 'Anaesthesiology', 'Theatre Complex', 'ON_DUTY', 'Available', 'Low', 4, 'Pre-operative assessment room', '08:00', 'Ext. 1061', 'MORNING'],
  ['DOC-1062', 'Dr. Nandini Sen', 'Anaesthesiology', 'Theatre Complex', 'ON_DUTY', 'Assigned', 'Moderate', 8, 'OT-02 anaesthesia cover', '08:10', 'Ext. 1062', 'MORNING'],
  ['DOC-1063', 'Dr. Meera Nair', 'Anaesthesiology', 'Theatre Complex', 'ON_DUTY', 'InProcedure', 'High', 11, 'OT-01 anaesthesia — emergency laparotomy', '08:00', 'Ext. 1063', 'MORNING'],
  ['DOC-1071', 'Dr. Farhan Qureshi', 'General Medicine', 'Internal Medicine', 'ON_DUTY', 'Available', 'Low', 6, 'Acute medical ward — admission reviews', '08:10', 'Ext. 1071', 'MORNING'],
  ['DOC-1072', 'Dr. Meenakshi Iyer', 'General Medicine', 'Internal Medicine', 'ON_DUTY', 'Assigned', 'Moderate', 13, 'Ward rounds — general medicine', '08:00', 'Ext. 1072', 'MORNING'],
  ['DOC-1081', 'Dr. Rajesh Iyer', 'General Surgery', 'General Surgery', 'ON_DUTY', 'InProcedure', 'High', 15, 'OT-01 emergency laparotomy (in progress)', '08:00', 'Ext. 1081', 'MORNING'],
  ['DOC-1082', 'Dr. Neha Kulkarni', 'General Surgery', 'General Surgery', 'OFF_DUTY', 'Unavailable', 'Low', 0, 'Shift completed — not assignable', '—', 'Ext. 1082', 'MORNING'],
  ['DOC-1083', 'Dr. Suresh Menon', 'General Surgery', 'General Surgery', 'ON_DUTY', 'Available', 'Low', 2, 'Surgical assessment bay — new referrals', '08:15', 'Ext. 1083', 'MORNING'],
  ['DOC-1091', 'Dr. Vikram Sethi', 'Orthopaedics', 'Orthopaedics', 'ON_DUTY', 'Available', 'Moderate', 9, 'Fracture clinic — post-op reviews', '08:00', 'Ext. 1091', 'MORNING'],
  ['DOC-1092', 'Dr. Sameer Khan', 'Orthopaedics', 'Orthopaedics', 'ON_DUTY', 'InProcedure', 'High', 12, 'OT-02 femoral fixation — pre-op hold', '08:00', 'Ext. 1092', 'MORNING'],
  ['DOC-1101', 'Dr. Anitha Menon', 'Paediatrics', 'Maternity & Paediatrics', 'ON_DUTY', 'Available', 'Low', 5, 'Paediatric ward — outpatient reviews', '08:00', 'Ext. 1101', 'MORNING'],
  ['DOC-1102', 'Dr. Ravi Shankar', 'Paediatrics', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 'Moderate', 10, 'Paediatric ward rounds', '08:05', 'Ext. 1102', 'MORNING'],
  ['DOC-1111', 'Dr. Lakshmi Narayan', 'Pulmonology', 'Internal Medicine', 'ON_DUTY', 'Available', 'Moderate', 8, 'Respiratory care unit — ventilator reviews', '08:00', 'Ext. 1111', 'MORNING'],
  ['DOC-1112', 'Dr. Anil Thomas', 'Pulmonology', 'Internal Medicine', 'ON_DUTY', 'Assigned', 'High', 14, 'Respiratory ward — NIV rounds', '08:00', 'Ext. 1112', 'MORNING'],
  ['DOC-1121', 'Dr. Priya Raghavan', 'Neurology', 'Neurosciences', 'ON_DUTY', 'Available', 'Low', 4, 'Neurology OPD', '08:00', 'Ext. 1121', 'MORNING'],
  ['DOC-1131', 'Dr. Sanjay Verma', 'Nephrology', 'Internal Medicine', 'ON_DUTY', 'Assigned', 'Moderate', 9, 'Dialysis unit supervision', '08:00', 'Ext. 1131', 'MORNING'],
  ['DOC-1141', 'Dr. Fatima Sheikh', 'Obstetrics & Gynaecology', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 'Moderate', 11, 'Labour room cover', '08:00', 'Ext. 1141', 'MORNING'],
  ['DOC-1151', 'Dr. George Mathew', 'Cardiothoracic Surgery', 'Theatre Complex', 'ON_DUTY', 'Available', 'Low', 3, 'Cardiac theatre on standby', '08:00', 'Ext. 1151', 'MORNING'],
  ['DOC-1161', 'Dr. Ritu Agarwal', 'Critical Care', 'Intensive Care', 'ON_DUTY', 'Assigned', 'High', 15, 'ICU morning round — ventilated patients', '07:45', 'Ext. 1161', 'MORNING'],
  ['DOC-1162', 'Dr. Deepak Nair', 'Critical Care', 'Intensive Care', 'ON_DUTY', 'Assigned', 'Moderate', 10, 'ICU step-down reviews', '08:00', 'Ext. 1162', 'MORNING'],
  ['DOC-1171', 'Dr. Sneha Pillai', 'Radiology', 'Diagnostics', 'ON_DUTY', 'Assigned', 'Moderate', 9, 'CT / ultrasound reporting', '08:00', 'Ext. 1171', 'MORNING'],
  ['DOC-1181', 'Dr. Mohammed Aslam', 'Gastroenterology', 'Internal Medicine', 'LEAVE', 'Unavailable', 'Low', 0, 'On approved leave', '—', 'Ext. 1181', 'MORNING'],
  ['DOC-1191', 'Dr. Pooja Bhatt', 'Dermatology', 'Specialties OPD', 'OFF_DUTY', 'Unavailable', 'Low', 0, 'Shift completed', '—', 'Ext. 1191', 'MORNING'],
  ['DOC-1201', 'Dr. Karthik Subramanian', 'Endocrinology', 'Internal Medicine', 'UNAVAILABLE', 'Unavailable', 'Low', 0, 'In mandatory training — not assignable', '—', 'Ext. 1201', 'MORNING'],
  ['DOC-1211', 'Dr. Leela Krishnan', 'General Medicine', 'Internal Medicine', 'ON_DUTY', 'Available', 'Low', 3, 'Evening intake — handover received', '16:00', 'Ext. 1211', 'EVENING'],
];

/* id, name, department, dutyStatus, availability, assignedPatients, workload, assignment, loginStaffId */
const NURSE_ROWS = [
  ['NUR-201', 'Nurse Priya', 'ICU', 'ON_DUTY', 'Assigned', 5, 'High', 'ICU-02 to ICU-06 — ventilated patients', 'NUR001'],
  ['NUR-202', 'Nurse Anjali Krishnan', 'ICU', 'ON_DUTY', 'Assigned', 5, 'High', 'ICU bays 07–10 — close monitoring', null],
  ['NUR-203', 'Nurse Deepa Varghese', 'ICU', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'ICU step-down bays', null],
  ['NUR-204', 'Nurse Fatima Beevi', 'ICU', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ICU central station', null],
  ['NUR-205', 'Nurse Reshma Pillai', 'ICU', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'ICU nights — ventilation checks', null],
  ['NUR-206', 'Nurse Sunil Kumar', 'ICU', 'ON_DUTY', 'Assigned', 5, 'High', 'ICU-01 to ICU-05 — hourly observations', null],
  ['NUR-207', 'Nurse Manoj Nair', 'ICU', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ICU float', null],
  ['NUR-208', 'Nurse Sherin Thomas', 'ICU', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'ICU documentation and handover', null],
  ['NUR-209', 'Nurse Vinod Raj', 'ICU', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'ICU procedure assistance', null],
  ['NUR-210', 'Nurse Beena Suresh', 'ICU', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'ICU medication rounds', null],
  ['NUR-301', 'Nurse Lakshmi Balan', 'Emergency', 'ON_DUTY', 'Assigned', 5, 'High', 'Emergency bays 01–05', null],
  ['NUR-302', 'Nurse Rahim Khan', 'Emergency', 'ON_DUTY', 'Assigned', 5, 'High', 'Resuscitation bay — critical intake', null],
  ['NUR-303', 'Nurse Divya Chandran', 'Emergency', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Emergency triage support', null],
  ['NUR-304', 'Nurse Sandeep Rao', 'Emergency', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — emergency intake', null],
  ['NUR-305', 'Nurse Meena Kumari', 'Emergency', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — emergency intake', null],
  ['NUR-306', 'Nurse Joseph Antony', 'Emergency', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Emergency observation bays', null],
  ['NUR-307', 'Nurse Anu George', 'Emergency', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Emergency wound care', null],
  ['NUR-308', 'Nurse Shruti Nambiar', 'Emergency', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — emergency float', null],
  ['NUR-309', 'Nurse Kabir Menon', 'Emergency', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Emergency sampling and lines', null],
  ['NUR-310', 'Nurse Sneha Ravi', 'Emergency', 'ON_DUTY', 'Assigned', 5, 'High', 'Emergency documentation', null],
  ['NUR-311', 'Nurse Prakash Iyer', 'Emergency', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Emergency minor procedures', null],
  ['NUR-312', 'Nurse Zoya Fatima', 'Emergency', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — emergency intake', null],
  ['NUR-401', 'Nurse Geetha Nair', 'General Ward', 'ON_DUTY', 'Assigned', 5, 'High', 'Ward A — general beds 01–12', null],
  ['NUR-402', 'Nurse Ajay Menon', 'General Ward', 'ON_DUTY', 'Assigned', 5, 'High', 'Ward A — general beds 13–24', null],
  ['NUR-403', 'Nurse Rekha Bose', 'General Ward', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Ward B — general beds 25–36', null],
  ['NUR-404', 'Nurse Tanvi Shah', 'General Ward', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Ward B — general beds 37–48', null],
  ['NUR-405', 'Nurse Shilpa Menon', 'General Ward', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ward admissions', null],
  ['NUR-406', 'Nurse Rahul Dev', 'General Ward', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Ward C — general beds 49–60', null],
  ['NUR-407', 'Nurse Ayesha Siddiqui', 'General Ward', 'ON_DUTY', 'Assigned', 5, 'High', 'Ward C — medication rounds', null],
  ['NUR-408', 'Nurse Kannan Subbu', 'General Ward', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ward float', null],
  ['NUR-409', 'Nurse Neetu Sharma', 'General Ward', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Ward D — post-operative care', null],
  ['NUR-410', 'Nurse Bilal Ahmed', 'General Ward', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Ward D — dressings', null],
  ['NUR-411', 'Nurse Swetha Nair', 'General Ward', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ward admissions', null],
  ['NUR-412', 'Nurse Harish Babu', 'General Ward', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Ward A — observations', null],
  ['NUR-413', 'Nurse Jyoti Rane', 'General Ward', 'ON_DUTY', 'Assigned', 5, 'High', 'Ward B — high-dependency beds', null],
  ['NUR-414', 'Nurse Arun Prasad', 'General Ward', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Ward C — discharge preparation', null],
  ['NUR-501', 'Nurse Kavitha Rajan', 'OT Complex', 'ON_DUTY', 'Assigned', 1, 'Low', 'OT-01 scrub nurse — laparotomy', null],
  ['NUR-502', 'Nurse Sreelatha Menon', 'OT Complex', 'ON_DUTY', 'Assigned', 1, 'Low', 'OT-02 scrub nurse — femoral fixation', null],
  ['NUR-503', 'Nurse Priyanka Das', 'OT Complex', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — OT-03 recovery bay', 'NUR501'],
  ['NUR-504', 'Nurse Harsha Vardhan', 'OT Complex', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — OT instrument set check', null],
  ['NUR-505', 'Nurse Latha Krishnan', 'OT Complex', 'ON_DUTY', 'Assigned', 2, 'Low', 'OT running list support', null],
  ['NUR-506', 'Nurse Anoop Nambiar', 'OT Complex', 'ON_DUTY', 'Assigned', 2, 'Low', 'Recovery bay monitoring', null],
  ['NUR-601', 'Nurse Rani Mathew', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 5, 'High', 'Labour room — active cases', null],
  ['NUR-602', 'Nurse Seema Nair', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Post-natal ward', null],
  ['NUR-603', 'Nurse Pavithra Menon', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Ante-natal ward', null],
  ['NUR-604', 'Nurse Alok Nath', 'Maternity & Paediatrics', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — paediatric admissions', null],
  ['NUR-605', 'Nurse Chris Fernandes', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Paediatric ward — IV rounds', null],
  ['NUR-606', 'Nurse Dileep Chandran', 'Maternity & Paediatrics', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — maternity float', null],
  ['NUR-607', 'Nurse Sofia Thomas', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Neonatal observation', null],
  ['NUR-608', 'Nurse Rohit Pillai', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Paediatric medication rounds', null],
  ['NUR-609', 'Nurse Amala Joseph', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Post-natal counselling', null],
  ['NUR-610', 'Nurse Vishnu Prasad', 'Maternity & Paediatrics', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Paediatric admissions', null],
];

/** Additional nurses keep the roster at the seeded hospital size (70). */
const NURSE_FILLER = [
  ['NUR-701', 'Nurse Ancy Mathew', 'ICU', 'OFF_DUTY', 'Unavailable', 0, 'Low', 'Shift completed'],
  ['NUR-702', 'Nurse Rahul Menon', 'Emergency', 'OFF_DUTY', 'Unavailable', 0, 'Low', 'Shift completed'],
  ['NUR-703', 'Nurse Preeti Nair', 'General Ward', 'OFF_DUTY', 'Unavailable', 0, 'Low', 'Shift completed'],
  ['NUR-704', 'Nurse Sam Thomas', 'OT Complex', 'OFF_DUTY', 'Unavailable', 0, 'Low', 'Shift completed'],
  ['NUR-705', 'Nurse Nithya Ravi', 'Maternity & Paediatrics', 'LEAVE', 'Unavailable', 0, 'Low', 'On approved leave'],
  ['NUR-706', 'Nurse Girish Kumar', 'General Ward', 'OFF_DUTY', 'Unavailable', 0, 'Low', 'Shift completed'],
  ['NUR-707', 'Nurse Anandi Bose', 'ICU', 'OFF_DUTY', 'Unavailable', 0, 'Low', 'Shift completed'],
  ['NUR-708', 'Nurse Vimal Raj', 'Emergency', 'UNAVAILABLE', 'Unavailable', 0, 'Low', 'In mandatory training — not assignable'],
  ['NUR-709', 'Nurse Sheeja Kurian', 'General Ward', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Ward D — evening cover', ],
  ['NUR-710', 'Nurse Prakash Nambiar', 'Emergency', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'Emergency evening cover'],
  ['NUR-711', 'Nurse Rhea Dsouza', 'ICU', 'ON_DUTY', 'Assigned', 4, 'Moderate', 'ICU evening cover'],
  ['NUR-712', 'Nurse Sanjay Menon', 'General Ward', 'ON_DUTY', 'Assigned', 3, 'Moderate', 'Ward A — evening cover'],
  ['NUR-713', 'Nurse Malini Iyer', 'One-Day Care', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — day-care admissions'],
  ['NUR-714', 'Nurse Jithin Paul', 'One-Day Care', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — day-care recovery'],
  ['NUR-715', 'Nurse Sona Varghese', 'General Ward', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ward float'],
  ['NUR-716', 'Nurse Manisha Roy', 'Emergency', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — emergency intake'],
  ['NUR-717', 'Nurse Ajith Kumar', 'ICU', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ICU float'],
  ['NUR-718', 'Nurse Divya Suresh', 'Maternity & Paediatrics', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — paediatric float'],
  ['NUR-719', 'Nurse Naveen Reddy', 'General Ward', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — ward admissions'],
  ['NUR-720', 'Nurse Parvathy Nair', 'OT Complex', 'ON_DUTY', 'Available', 0, 'Low', 'Standby — OT recovery'],
];

const buildDoctors = () =>
  DOCTOR_ROWS.map(([id, name, specialty, department, dutyStatus, availability, workload, patients, currentAssignment, since, contact, shiftBlock]) => {
    const shift = shiftBlock === 'EVENING' ? EVENING : MORNING;
    return {
      id,
      name,
      specialty,
      department,
      dutyStatus,
      availability,
      workload,
      patients,
      currentAssignment,
      since,
      contact,
      shiftBlock,
      shift: shift.label,
      maxOperationalLoad: DOCTOR_WORKLOAD_LIMIT,
    };
  });

const buildNurses = () =>
  [...NURSE_ROWS, ...NURSE_FILLER].map(
    ([id, name, department, dutyStatus, availability, assignedPatients, workload, currentAssignment, loginStaffId]) => ({
      id,
      name,
      department,
      dutyStatus,
      availability,
      assignedPatients,
      workload,
      currentAssignment,
      loginStaffId: loginStaffId || null,
      shiftBlock: 'MORNING',
      shift: MORNING.label,
      maxOperationalLoad: NURSE_WORKLOAD_LIMIT,
    }),
  );

/** Sign-in accounts. Password for every seeded account is `demo123` (§ dev). */
const ACCOUNTS = [
  { staffId: 'CMD001', staffRef: 'CMD-001', name: 'Command Staff', title: 'Duty Command Center Officer', roleCode: 'command_center', department: 'Command Center' },
  { staffId: 'RES001', staffRef: 'RES-001', name: 'Resource Coordinator', title: 'Resource & Capacity Coordinator', roleCode: 'resource_coordinator', department: 'Resource Coordination' },
  { staffId: 'DOC001', staffRef: 'DOC-1042', name: 'Dr. Kumar', title: 'Senior Consultant — Cardiology', roleCode: 'doctor', department: 'Cardiology' },
  { staffId: 'DOC002', staffRef: 'DOC-1081', name: 'Dr. Rajesh Iyer', title: 'Consultant Surgeon — General Surgery', roleCode: 'doctor', department: 'General Surgery' },
  { staffId: 'DOC003', staffRef: 'DOC-1083', name: 'Dr. Suresh Menon', title: 'Consultant Surgeon — General Surgery', roleCode: 'doctor', department: 'General Surgery' },
  { staffId: 'DOC004', staffRef: 'DOC-1161', name: 'Dr. Ritu Agarwal', title: 'Consultant — Critical Care', roleCode: 'doctor', department: 'Intensive Care' },
  { staffId: 'DOC005', staffRef: 'DOC-1051', name: 'Dr. Shalini Rao', title: 'Consultant — Emergency Medicine', roleCode: 'doctor', department: 'Emergency' },
  { staffId: 'DOC006', staffRef: 'DOC-1071', name: 'Dr. Farhan Qureshi', title: 'Consultant Physician — General Medicine', roleCode: 'doctor', department: 'Internal Medicine' },
  { staffId: 'NUR001', staffRef: 'NUR-201', name: 'Nurse Priya', title: 'Staff Nurse — ICU', roleCode: 'nurse', department: 'ICU' },
  { staffId: 'NUR002', staffRef: 'NUR-204', name: 'Nurse Fatima Beevi', title: 'Staff Nurse — ICU', roleCode: 'nurse', department: 'ICU' },
  { staffId: 'NUR003', staffRef: 'NUR-301', name: 'Nurse Lakshmi Balan', title: 'Staff Nurse — Emergency', roleCode: 'nurse', department: 'Emergency' },
  { staffId: 'NUR004', staffRef: 'NUR-405', name: 'Nurse Shilpa Menon', title: 'Staff Nurse — General Ward', roleCode: 'nurse', department: 'General Ward' },
  { staffId: 'NUR501', staffRef: 'NUR-503', name: 'Nurse Priyanka Das', title: 'Staff Nurse — OT Complex', roleCode: 'nurse', department: 'OT Complex' },
];

const DOCTOR_SHIFT_BLOCKS = ['MORNING', 'EVENING', 'NIGHT'];

module.exports = { DOCTOR_ROWS, NURSE_ROWS, NURSE_FILLER, ACCOUNTS, buildDoctors, buildNurses, DOCTOR_SHIFT_BLOCKS };
