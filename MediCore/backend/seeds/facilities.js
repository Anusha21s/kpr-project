/**
 * Beds, equipment, emergency resources and operating theatres.
 *
 * Occupancy is data, not a dashboard constant: the overview endpoint counts
 * `Bed` rows by status, so changing a bed here changes every screen.
 */

const { WARDS, SEED_OCCUPANCY } = require('./constants');

const WARD_FEATURES = {
  general: ['Oxygen outlet', 'Nurse call', 'Attached toilet'],
  icu: ['Ventilator point', 'Central monitoring', 'Infusion pumps', 'Negative pressure capable'],
  emergency: ['Resuscitation trolley', 'Defibrillator', 'Suction', 'Monitored bay'],
  maternity: ['Foetal monitor', 'Warming crib', 'Nurse call'],
};

const pad = (value) => String(value).padStart(2, '0');

/**
 * 100 beds: 60 general, 10 ICU, 10 emergency (2 of them ICU step-down
 * escalation bays), 20 maternity — seeded with realistic occupancy.
 */
function buildBeds() {
  const beds = [];
  WARDS.forEach((ward) => {
    const { occupied, reserved } = SEED_OCCUPANCY[ward.id];
    for (let index = 1; index <= ward.configured; index += 1) {
      const id = `${ward.prefix}-${pad(index)}`;
      let status = 'AVAILABLE';
      if (index <= occupied) status = 'OCCUPIED';
      else if (index <= occupied + reserved) status = 'RESERVED';
      // One general bed is out of service for maintenance.
      if (ward.id === 'general' && index === ward.configured) status = 'MAINTENANCE';
      // One maternity bed is being cleaned between cases.
      if (ward.id === 'maternity' && index === ward.configured) status = 'CLEANING';

      const escalation = ward.id === 'emergency' && index <= 2;
      beds.push({
        id,
        wardId: ward.id,
        ward: ward.name,
        unit: ward.unit,
        bedType: escalation ? 'ICU Step-down Bay' : ward.bedType,
        status,
        // Occupancy is owned by the bed row; clinical records are linked for the
        // beds that belong to a patient in this dataset (see patients.js).
        patientRef: status === 'OCCUPIED' ? `IP-${3000 + index}` : null,
        heldFor: status === 'RESERVED' ? (ward.id === 'icu' ? 'Provisional hold — P009 (highest acuity)' : 'Provisional hold — incoming emergency case') : null,
        availableFrom:
          status === 'CLEANING'
            ? new Date(Date.now() + 45 * 60 * 1000)
            : status === 'MAINTENANCE'
              ? new Date(Date.now() + 6 * 60 * 60 * 1000)
              : null,
        escalation,
        features: escalation ? ['Monitored bay', 'Cardiac monitor', 'Ventilator point'] : WARD_FEATURES[ward.id],
        notes: escalation ? 'Escalation bay — ICU-governed step-down capacity.' : null,
      });
    }
  });
  return beds;
}

/* ------------------------------------------------------------------ equipment */

const unitIds = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${pad(index + 1)}`);

/** Category rows plus unit-level registers used by the allocation board. */
function buildEquipment() {
  const categories = [
    {
      id: 'ventilators',
      name: 'Ventilators',
      kind: 'VENTILATOR',
      description: 'ICU-grade invasive ventilation units',
      unitsPrefix: 'V',
      total: 15,
      inUse: 12,
      reserved: 1,
      location: 'ICU / Emergency / OT Complex',
      criticalFor: 'Critical patients requiring advanced airway support',
    },
    {
      id: 'monitors',
      name: 'Patient Monitors',
      kind: 'MONITOR',
      description: 'Multi-parameter bedside monitors',
      unitsPrefix: 'M',
      total: 45,
      inUse: 38,
      reserved: 2,
      location: 'All wards',
      criticalFor: 'Continuous monitoring of critical patients',
    },
    {
      id: 'anaesthesia',
      name: 'Anaesthesia Workstation',
      kind: 'OT_EQUIPMENT',
      description: 'Anaesthesia delivery and monitoring systems',
      unitsPrefix: 'AW',
      total: 6,
      inUse: 4,
      reserved: 1,
      location: 'OT Complex',
      criticalFor: 'Any procedure requiring anaesthesia',
    },
    {
      id: 'diathermy',
      name: 'Diathermy',
      kind: 'OT_EQUIPMENT',
      description: 'Electrosurgical units',
      unitsPrefix: 'DT',
      total: 6,
      inUse: 5,
      reserved: 0,
      location: 'OT Complex',
      criticalFor: 'Surgical haemostasis',
    },
    {
      id: 'laparoscopy',
      name: 'Laparoscopic Tower',
      kind: 'OT_EQUIPMENT',
      description: 'Minimal-access surgical stack',
      unitsPrefix: 'LT',
      total: 4,
      inUse: 3,
      reserved: 1,
      location: 'OT Complex',
      criticalFor: 'Laparoscopic procedures',
    },
    {
      id: 'carm',
      name: 'C-Arm Imaging',
      kind: 'OT_EQUIPMENT',
      description: 'Intra-operative fluoroscopy',
      unitsPrefix: 'CA',
      total: 2,
      inUse: 2,
      reserved: 0,
      location: 'OT Complex',
      criticalFor: 'Orthopaedic fixation imaging',
    },
    {
      id: 'perfusion',
      name: 'Perfusion Unit',
      kind: 'OT_EQUIPMENT',
      description: 'Cardiopulmonary bypass system',
      unitsPrefix: 'PU',
      total: 2,
      inUse: 1,
      reserved: 0,
      location: 'Cardiac theatre',
      criticalFor: 'Cardiac surgery',
    },
  ];

  return categories.map((category) => {
    const units = unitIds(category.unitsPrefix, category.total).map((id, index) => {
      const isReserved = index >= category.inUse && index < category.inUse + category.reserved;
      const isInUse = index < category.inUse;
      return {
        id,
        inUse: isInUse,
        reserved: isReserved,
        status: isInUse ? 'In Use' : isReserved ? 'Reserved' : 'Available',
        reservedFor: isReserved ? (index === category.inUse ? 'Reserved for P009 — ICU escalation' : null) : null,
      };
    });
    return {
      ...category,
      status: category.total - category.inUse - category.reserved <= 1 ? 'Critical' : category.total - category.inUse <= 3 ? 'Tight' : 'Available',
      units,
    };
  });
}

function buildEmergencyResources() {
  return [
    {
      id: 'resus',
      name: 'Resuscitation bays',
      kind: 'RESUS',
      total: 4,
      inUse: 2,
      reserved: 1,
      location: 'Emergency — resuscitation area',
      status: 'Tight',
      criticalFor: 'Immediate resuscitation and airway management',
    },
    {
      id: 'emergency_beds',
      name: 'Emergency monitored beds',
      kind: 'BAY',
      total: 10,
      inUse: 8,
      reserved: 1,
      location: 'Emergency ward',
      status: 'Tight',
      criticalFor: 'Monitored emergency admissions',
    },
    {
      id: 'trauma',
      name: 'Trauma equipment sets',
      kind: 'TRAUMA_EQUIPMENT',
      total: 6,
      inUse: 3,
      reserved: 1,
      location: 'Emergency — trauma bay',
      status: 'Available',
      criticalFor: 'Major trauma reception',
    },
    {
      id: 'emergency_ot',
      name: 'Emergency theatre',
      kind: 'OT',
      total: 1,
      inUse: 1,
      reserved: 0,
      location: 'OT-01 (emergency theatre)',
      status: 'Critical',
      criticalFor: 'Immediate surgical intervention',
    },
    {
      id: 'ambulances',
      name: 'Ambulance units',
      kind: 'TRANSPORT',
      total: 8,
      inUse: 3,
      reserved: 0,
      location: 'Ambulance bay',
      status: 'Available',
      criticalFor: 'Inter-facility transfer and pre-hospital retrieval',
    },
  ];
}

/* ------------------------------------------------------------------ theatres */

const minutesToLabel = (minutes) => {
  const hours24 = Math.floor(minutes / 60);
  const minutesPart = minutes % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${pad(hours12)}:${pad(minutesPart)} ${suffix}`;
};

function buildTheatres() {
  return [
    {
      id: 'OT-01',
      name: 'OT-01 — Emergency Theatre',
      kind: 'EMERGENCY',
      status: 'ONGOING',
      notes: 'Emergency theatre — reserved for immediate surgical intervention.',
      schedule: {
        patientRef: 'IP-2211',
        patientLabel: 'IP-2211 A. Fernandes',
        procedure: 'Emergency laparotomy — exploratory',
        priority: 'Critical',
        status: 'ONGOING',
        start: '09:00 AM',
        end: '11:00 AM',
        startMinutes: 540,
        endMinutes: 660,
        surgeonId: 'DOC-1081',
        surgeonName: 'Dr. Rajesh Iyer',
        anaesthetist: 'Dr. Meera Nair',
        requiredEquipment: ['Anaesthesia Workstation', 'Diathermy', 'Laparoscopic Tower'],
        equipmentReady: true,
        nurses: ['NUR-501'],
        notes: 'Procedure overrun risk: 20 minutes. Conversion decision pending.',
        conflict: false,
      },
    },
    {
      id: 'OT-02',
      name: 'OT-02 — General Theatre',
      kind: 'GENERAL',
      status: 'SCHEDULED',
      notes: 'General surgery list.',
      schedule: {
        patientRef: 'IP-2242',
        patientLabel: 'IP-2242 D. Kaur',
        procedure: 'Orthopaedic — femoral fixation',
        priority: 'High',
        status: 'SCHEDULED',
        start: '11:30 AM',
        end: '01:30 PM',
        startMinutes: 690,
        endMinutes: 810,
        surgeonId: 'DOC-1092',
        surgeonName: 'Dr. Sameer Khan',
        anaesthetist: 'Dr. Meera Nair',
        requiredEquipment: ['Anaesthesia Workstation', 'C-Arm Imaging', 'Diathermy'],
        equipmentReady: true,
        nurses: ['NUR-502'],
        notes: 'Pre-operative checklist started. Patient in holding area.',
        conflict: false,
      },
    },
    {
      id: 'OT-03',
      name: 'OT-03 — Elective Theatre',
      kind: 'ELECTIVE',
      status: 'AVAILABLE',
      nextAvailableSlot: '02:30 PM',
      nextAvailableMinutes: 870,
      notes: 'Sterile set ready. Next available slot 02:30 PM.',
      schedule: null,
    },
    {
      id: 'OT-04',
      name: 'OT-04 — Cardiac Theatre',
      kind: 'CARDIAC',
      status: 'MAINTENANCE',
      nextAvailableSlot: 'Tomorrow 08:00 AM',
      notes: 'Perfusion unit calibration until 04:00 PM. Not available for scheduling today.',
      schedule: null,
    },
  ];
}

/**
 * Surgical requests waiting for a slot. Only patients that actually exist in
 * the seeded dataset are listed here; queued patients with `needsOt` are added
 * to the backlog dynamically once they have no theatre assigned.
 */
const OT_BACKLOG = [
  { id: 'OTS-01', patientNumber: 'IP-2207', procedure: 'Incision & drainage — abscess', priority: 'High', surgeon: 'Dr. Suresh Menon' },
  { id: 'OTS-02', patientNumber: 'IP-2212', procedure: 'Arthroscopy — knee', priority: 'Medium', surgeon: 'Dr. Vikram Sethi' },
  { id: 'OTS-03', patientNumber: 'IP-2216', procedure: 'Wound debridement', priority: 'High', surgeon: 'Dr. Rajesh Iyer' },
];

module.exports = { buildBeds, buildEquipment, buildEmergencyResources, buildTheatres, OT_BACKLOG, minutesToLabel };
