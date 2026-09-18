/**
 * Equipment inventory — ventilators, patient monitors and OT equipment.
 * Totals are fixed so utilisation stays reproducible across the demo.
 */

const buildUnits = (prefix, total, inUse, extra = {}) =>
  Array.from({ length: total }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return {
      id: `${prefix}-${number}`,
      inUse: index < inUse,
      status: index < inUse ? 'In Use' : 'Available',
      ...extra,
    };
  });

export const EQUIPMENT_CATEGORIES = [
  {
    id: 'ventilators',
    name: 'Ventilators',
    description: 'ICU-grade invasive ventilation units',
    total: 15,
    inUse: 12,
    location: 'ICU / Emergency / OT Complex',
    units: buildUnits('V', 15, 12),
    reserved: 1,
    criticalFor: 'Critical patients requiring advanced airway support',
  },
  {
    id: 'monitors',
    name: 'Patient Monitors',
    description: 'Multi-parameter bedside monitors',
    total: 45,
    inUse: 38,
    location: 'All wards',
    units: buildUnits('M', 45, 38),
    reserved: 0,
    criticalFor: 'Continuous vitals monitoring',
  },
  {
    id: 'ot',
    name: 'OT Equipment',
    description: 'Anaesthesia workstations, diathermy and laparoscopic towers',
    total: 20,
    inUse: 17,
    location: 'OT Complex — OT-01 to OT-04',
    units: buildUnits('OTE', 20, 17),
    reserved: 0,
    criticalFor: 'Surgical and anaesthesia procedures',
  },
];

export const EQUIPMENT_SUBTYPES = [
  { id: 'anaesthesia', name: 'Anaesthesia Workstations', total: 4, inUse: 3, location: 'OT Complex' },
  { id: 'diathermy', name: 'Diathermy Units', total: 4, inUse: 3, location: 'OT Complex' },
  { id: 'laparoscopy', name: 'Laparoscopic Towers', total: 4, inUse: 4, location: 'OT Complex' },
  { id: 'carm', name: 'C-Arm Imaging', total: 2, inUse: 2, location: 'OT Complex' },
  { id: 'perfusion', name: 'Perfusion Units', total: 2, inUse: 1, location: 'OT Complex' },
  { id: 'infusion', name: 'Infusion Pump Sets', total: 4, inUse: 4, location: 'OT / ICU' },
];

export const getEquipmentById = (categories, id) =>
  categories.find((category) => category.id === id) || null;
