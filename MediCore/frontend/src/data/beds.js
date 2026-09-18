/**
 * Bed inventory.
 *
 * Ward totals: General 60 + ICU 10 + Emergency 10 + Maternity & Paediatrics 20 = 100 configured beds.
 * Baseline occupancy: 45 + 9 + 8 + 10 = 72 occupied, 28 available — this is the single
 * source of truth for the command center KPI cards and the bed capacity page.
 *
 * `BED_UNITS` is generated from `WARDS` so ward-level and unit-level numbers can never drift apart.
 */

export const BED_STATUS = {
  AVAILABLE: 'Available',
  OCCUPIED: 'Occupied',
  RESERVED: 'Reserved',
  CLEANING: 'Cleaning',
  MAINTENANCE: 'Maintenance',
};

export const WARDS = [
  {
    id: 'general',
    name: 'General Ward',
    code: 'GW',
    total: 60,
    occupied: 45,
    department: 'General Medicine',
    bedType: 'General Bed',
    shortLabel: 'General',
    notes: 'Multi-speciality inpatient beds GW-01 to GW-60',
  },
  {
    id: 'icu',
    name: 'Intensive Care Unit',
    code: 'ICU',
    total: 10,
    occupied: 9,
    department: 'Critical Care',
    bedType: 'ICU Bed',
    shortLabel: 'ICU',
    notes: 'Level-3 critical care. ICU-08 is the only vacant bed.',
  },
  {
    id: 'emergency',
    name: 'Emergency Ward',
    code: 'ER',
    total: 10,
    occupied: 8,
    department: 'Emergency',
    bedType: 'Emergency Bed',
    shortLabel: 'Emergency',
    notes: 'Monitored emergency bays with central oxygen — ER-09 and ER-10 vacant.',
  },
  {
    id: 'maternity',
    name: 'Maternity & Paediatrics',
    code: 'MP',
    total: 20,
    occupied: 10,
    department: 'Obstetrics & Paediatrics',
    bedType: 'General Bed',
    shortLabel: 'Maternity',
    notes: 'Labour rooms, post-natal and paediatric bays MP-01 to MP-20',
  },
];

export const TOTAL_BEDS = WARDS.reduce((sum, ward) => sum + ward.total, 0);
export const TOTAL_OCCUPIED = WARDS.reduce((sum, ward) => sum + ward.occupied, 0);
export const TOTAL_AVAILABLE = TOTAL_BEDS - TOTAL_OCCUPIED;

/** Bed numbers that are vacant at baseline, per ward. */
const VACANT_BEDS = {
  general: Array.from({ length: 15 }, (_, index) => `GW-${String(index + 1).padStart(2, '0')}`),
  icu: ['ICU-08'],
  emergency: ['ER-09', 'ER-10'],
  maternity: Array.from({ length: 10 }, (_, index) => `MP-${String(index + 1).padStart(2, '0')}`),
};

const OCCUPANT_POOL = [
  'IP-2210 R. Sharma',
  'IP-2211 A. Fernandes',
  'IP-2214 M. Iqbal',
  'IP-2217 S. Bhatt',
  'IP-2221 K. Raman',
  'IP-2225 J. Dias',
  'IP-2229 P. Nandini',
  'IP-2233 V. Prakash',
  'IP-2238 L. Thomas',
  'IP-2242 D. Kaur',
  'IP-2247 N. Suresh',
  'IP-2251 G. Menon',
  'IP-2256 H. Prasad',
  'IP-2260 T. Zacharia',
  'IP-2264 B. Ahuja',
  'IP-2268 F. Rasheed',
];

const FEATURES = {
  icu: [
    ['Ventilator', 'Central monitor', 'Infusion pumps'],
    ['Central monitor', 'Dialysis port', 'Infusion pumps'],
    ['Ventilator', 'Central monitor', 'Isolation ready'],
    ['Central monitor', 'Infusion pumps', 'Arterial line'],
  ],
  emergency: [
    ['Oxygen outlet', 'Defibrillator access', 'Monitored bay'],
    ['Oxygen outlet', 'Monitored bay', 'Triage point'],
    ['Oxygen outlet', 'Resus trolley', 'Monitored bay'],
  ],
  general: [
    ['Oxygen outlet', 'Nurse call'],
    ['Oxygen outlet', 'Nurse call', 'Cardiac monitor'],
    ['Oxygen outlet', 'Nurse call', 'Attendant cot'],
  ],
  maternity: [
    ['Oxygen outlet', 'Nurse call', 'Infant warmer'],
    ['Oxygen outlet', 'Nurse call', 'Foetal monitor'],
    ['Oxygen outlet', 'Nurse call'],
  ],
};

/** Name of the post-operative / escalated bed types the coordinator can bring online. */
export const ESCALATION_BEDS = [
  {
    id: 'HD-01',
    label: 'HD-01',
    type: 'Critical-care step-down bay',
    ward: 'General Ward',
    wardId: 'general',
    notes: 'Cardiac-monitored step-down bay, ventilator-capable',
  },
  {
    id: 'HD-02',
    label: 'HD-02',
    type: 'Critical-care step-down bay',
    ward: 'General Ward',
    wardId: 'general',
    notes: 'Cardiac-monitored step-down bay, ventilator-capable',
  },
];

/** Overflow monitored bays opened by the surge coverage recommendation. */
export const SURGE_OVERFLOW_BEDS = Array.from(
  { length: 8 },
  (_, index) => `OV-${String(index + 1).padStart(2, '0')}`,
);

export function buildBedUnits() {
  const units = [];
  WARDS.forEach((ward) => {
    const vacant = VACANT_BEDS[ward.id] || [];
    const featureSet = FEATURES[ward.id] || FEATURES.general;
    for (let index = 1; index <= ward.total; index += 1) {
      const id = `${ward.code}-${String(index).padStart(2, '0')}`;
      const isVacant = vacant.includes(id);
      units.push({
        id,
        wardId: ward.id,
        ward: ward.name,
        bedType: ward.bedType,
        status: isVacant ? BED_STATUS.AVAILABLE : BED_STATUS.OCCUPIED,
        patient: isVacant ? null : OCCUPANT_POOL[(index + ward.total) % OCCUPANT_POOL.length],
        features: featureSet[index % featureSet.length],
        heldFor: null,
        escalation: false,
      });
    }
  });
  return units;
}

/** Ward-level stats are always derived from the bed units — never hardcoded. */
export function getWardStats(bedUnits) {
  return WARDS.map((ward) => {
    const units = bedUnits.filter((unit) => unit.wardId === ward.id);
    const available = units.filter((unit) => unit.status === BED_STATUS.AVAILABLE).length;
    const reserved = units.filter((unit) => unit.status === BED_STATUS.RESERVED).length;
    const occupied = units.filter((unit) => unit.status === BED_STATUS.OCCUPIED).length;
    const cleaning = units.filter((unit) => unit.status === BED_STATUS.CLEANING).length;
    const maintenance = units.filter((unit) => unit.status === BED_STATUS.MAINTENANCE).length;
    const escalation = units.filter((unit) => unit.escalation).length;
    return {
      ...ward,
      total: units.length,
      units: units.length,
      baseUnits: units.length - escalation,
      escalation,
      available,
      reserved,
      occupied,
      cleaning,
      maintenance,
      committed: occupied + reserved,
      occupancyPercentage: units.length
        ? Math.round(((units.length - available) / units.length) * 1000) / 10
        : 0,
    };
  });
}

export const getAvailableBedUnits = (bedUnits, wardId = null) =>
  bedUnits.filter((unit) => unit.status === BED_STATUS.AVAILABLE && (!wardId || unit.wardId === wardId));

export const getBedUnitById = (bedUnits, id) => bedUnits.find((unit) => unit.id === id) || null;
