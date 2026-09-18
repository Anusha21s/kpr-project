/**
 * Emergency resource inventory — beds, resuscitation capacity, ambulances,
 * emergency kits and specialist response resources.
 */

export const EMERGENCY_RESOURCES = [
  {
    id: 'em-beds',
    name: 'Emergency Beds',
    category: 'Capacity',
    description: 'Monitored emergency bays with central oxygen',
    total: 10,
    inUse: 8,
    location: 'Emergency Ward',
    criticalFor: 'Emergency stabilisation and monitoring',
  },
  {
    id: 'resus',
    name: 'Resuscitation Bays',
    category: 'Capacity',
    description: 'Resus bays with crash cart and defibrillator',
    total: 3,
    inUse: 2,
    location: 'Emergency Ward',
    criticalFor: 'Cardiac arrest and unstable resuscitation cases',
  },
  {
    id: 'em-rooms',
    name: 'Emergency Rooms',
    category: 'Capacity',
    description: 'Assessment and procedure rooms',
    total: 6,
    inUse: 5,
    location: 'Emergency Ward',
    criticalFor: 'Assessment, suturing and minor procedures',
  },
  {
    id: 'ambulances',
    name: 'Ambulances',
    category: 'Transport',
    description: 'Advanced life support ambulances',
    total: 4,
    inUse: 3,
    location: 'Ambulance Bay',
    criticalFor: 'Inter-facility transfer and pre-hospital response',
  },
  {
    id: 'resus-kits',
    name: 'Resuscitation Kits',
    category: 'Consumables',
    description: 'Sealed airway and resuscitation kits',
    total: 12,
    inUse: 7,
    location: 'Emergency Ward',
    criticalFor: 'Airway management and resuscitation',
  },
  {
    id: 'trauma-kits',
    name: 'Trauma Kits',
    category: 'Consumables',
    description: 'Trauma packs with chest drains and immobilisation',
    total: 10,
    inUse: 8,
    location: 'Emergency Ward',
    criticalFor: 'Polytrauma and haemorrhage control',
  },
  {
    id: 'defibrillators',
    name: 'Defibrillators',
    category: 'Equipment',
    description: 'Biphasic defibrillators with pacing',
    total: 6,
    inUse: 4,
    location: 'Emergency Ward / ICU',
    criticalFor: 'Rhythm control and cardiac emergencies',
  },
  {
    id: 'emergency-specialists',
    name: 'Emergency Specialist Slots',
    category: 'Staffing',
    description: 'On-call specialist consultation slots',
    total: 6,
    inUse: 5,
    location: 'Emergency Ward',
    criticalFor: 'Immediate specialist review of emergency cases',
  },
];

export const AMBULANCE_FLEET = [
  { id: 'ALS-01', type: 'Advanced Life Support', status: 'On Call', crew: '2 paramedics', location: 'City Centre transfer' },
  { id: 'ALS-02', type: 'Advanced Life Support', status: 'In Use', crew: '2 paramedics', location: 'Inbound — Surge Intake' },
  { id: 'BLS-01', type: 'Basic Life Support', status: 'In Use', crew: '2 paramedics', location: 'Inbound — Surge Intake' },
  { id: 'BLS-02', type: 'Basic Life Support', status: 'Available', crew: '2 paramedics', location: 'Ambulance Bay' },
];

/** Emergency desk workflow stages shown on the command center workflow strip. */
export const WORKFLOW_STAGES = [
  { id: 'arrival', label: 'Patient arrives', detail: 'Ambulance / walk-in registered at emergency desk' },
  { id: 'assessment', label: 'Clinical assessment', detail: 'Triage score assigned by emergency team' },
  { id: 'requirement', label: 'Required resource recorded', detail: 'Doctor records the clinical requirement' },
  { id: 'visibility', label: 'MediCore receives the operational requirement', detail: 'Queue and hospital state updated' },
  { id: 'analysis', label: 'Multi-resource analysis', detail: 'Demand, capacity, staffing and equipment compared' },
  { id: 'recommendation', label: 'Recommendation issued', detail: 'Coordinator reviews the proposed allocation' },
  { id: 'confirmation', label: 'Authorised confirmation', detail: 'Allocation confirmed by the resource coordinator' },
  { id: 'feedback', label: 'Updated hospital state', detail: 'All dashboards reflect the new allocation' },
];
