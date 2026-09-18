import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import { createInitialState } from '../utils/hospitalState';
import {
  buildSnapshot,
  calculateHospitalMetrics,
  calculateResourcePressure,
  simulateEmergencySurge,
} from '../utils/simulationEngine';
import {
  applyRecommendations,
  buildApprovalRequest,
  detectConflicts,
  optimizeResources,
} from '../utils/optimizationEngine';
import { BED_STATUS } from '../data/beds';
import { formatTimeLabel } from '../utils/time';
import { useLiveTicker } from '../hooks/useLiveTicker';
import { useAuthContext } from './AuthContext';
import api, { BACKEND_CONFIGURED, getToken } from '../services/api';
import { connectSocket, disconnectSocket, onOperationalEvent } from '../services/socket';

/**
 * Central hospital state for the whole application.
 *
 * Every dashboard (command center, clinical staff, resource coordinator) reads
 * from this single store, so a surge, an optimisation run or a confirmed
 * allocation is immediately visible everywhere, including across roles.
 */

const HospitalContext = createContext(null);

const createAlert = (data) => ({
  id: data.id || `ALR-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  status: 'Active',
  timestamp: new Date(),
  ...data,
});

function reducer(state, action) {
  switch (action.type) {
    /* -------------------------------------------------- live ticking */
    case 'TICK_MINUTE': {
      return {
        ...state,
        queue: state.queue.map((entry) => ({ ...entry, waitingMinutes: entry.waitingMinutes + 1 })),
      };
    }

    /* -------------------------------------------------- surge simulation */
    case 'RUN_SURGE': {
      const result = simulateEmergencySurge(state);
      let next = result.state;
      const metrics = calculateHospitalMetrics(next);
      next.conflicts = detectConflicts(next, metrics);
      next.alerts = [
        createAlert({
          id: 'ALR-SURGE-01',
          type: 'Critical',
          category: 'Surge',
          title: 'Emergency queue rapidly increasing',
          description: `Emergency queue increased from ${result.before.emergencyQueue} to ${result.after.emergencyQueue} patients after a mass-casualty intake. ${result.after.criticalQueue} critical cases are under active assessment.`,
          resource: 'Emergency Queue',
          affectedResource: `Emergency — ${result.after.emergencyQueue} waiting`,
          action: { label: 'Open patient queue', to: '/command/queue' },
          source: 'Surge simulation',
        }),
        createAlert({
          id: 'ALR-SURGE-02',
          type: 'Critical',
          category: 'Capacity',
          title: 'ICU capacity critical',
          description: `ICU occupancy has risen to ${result.after.icuOccupancy}%. ${next.queue.filter((entry) => entry.requiredResource === 'ICU Bed' || entry.secondaryResource === 'ICU Bed').length} ICU-level requests are pending against ${metrics.beds.icu.available} vacant bed.`,
          resource: 'ICU Beds',
          affectedResource: `ICU — ${metrics.beds.icu.committed} / ${metrics.beds.icu.units} committed`,
          action: { label: 'View bed capacity', to: '/command/beds' },
          source: 'Capacity monitor',
        }),
        createAlert({
          id: 'ALR-SURGE-03',
          type: 'Operational',
          category: 'Workload',
          title: 'Staff workload increased',
          description: `Doctor workload index moved to ${result.after.doctorWorkload} and nurse workload index to ${result.after.nurseWorkload}. Nurse assignments remain within the configured constraint.`,
          resource: 'Staffing',
          affectedResource: `ICU / Emergency — workload band high`,
          action: { label: 'View roster', to: '/command/nurses' },
          source: 'Workload monitor',
        }),
        createAlert({
          id: 'ALR-SURGE-04',
          type: 'Operational',
          category: 'Equipment',
          title: 'Equipment utilisation high',
          description: `Aggregate equipment utilisation increased to ${result.after.equipmentUtilisation}% with monitor availability reduced to ${metrics.equipment.monitors.available} units.`,
          resource: 'Patient Monitors',
          affectedResource: `Equipment — ${metrics.equipment.utilisation}% utilised`,
          action: { label: 'Open equipment', to: '/command/equipment' },
          source: 'Equipment telemetry',
        }),
        ...state.alerts,
      ];
      next.surge = {
        ...next.surge,
        after: result.after,
        deltas: result.deltas,
        heldBeds: result.heldBeds,
      };
      next.lastUpdated = new Date().toISOString();
      return next;
    }

    case 'REFRESH': {
      /* Manual refresh: re-sync the operational snapshot timestamp. */
      return { ...state, lastUpdated: new Date().toISOString(), refreshedAt: Date.now() };
    }

    case 'RESET_DEMO': {
      return createInitialState();
    }

    case 'COMPLETE_TASK': {
      return {
        ...state,
        clinicalTasks: state.clinicalTasks.map((task) =>
          task.id === action.taskId
            ? { ...task, status: 'Completed', completedAt: new Date().toISOString(), completedBy: action.completedBy }
            : task,
        ),
      };
    }

    case 'UPDATE_TASK_NOTE': {
      return {
        ...state,
        clinicalTasks: state.clinicalTasks.map((task) =>
          task.id === action.taskId ? { ...task, note: action.note, notedAt: new Date().toISOString() } : task,
        ),
      };
    }

    /* -------------------------------------------------- optimisation */
    case 'RUN_OPTIMIZATION': {
      const optimization = optimizeResources(state, { selections: action.selections || {} });
      const approval = buildApprovalRequest(optimization, action.requestedBy || 'Command Center');
      const existing = state.approvals.filter((entry) => entry.status === 'Pending Review');
      const nextApprovals = existing.length && action.replacePending ? [] : existing;
      return {
        ...state,
        optimization,
        approvals: [approval, ...nextApprovals, ...state.approvals.filter((entry) => entry.status !== 'Pending Review')],
        alerts: [
          ...optimization.conflicts
            .filter((conflict) => conflict.id === 'CFL-01')
            .map((conflict) =>
              createAlert({
                id: 'ALR-CONF-01',
                type: 'Critical',
                category: 'Conflict',
                title: 'Multi-resource conflict detected',
                description: `${conflict.caseLabel} requires ICU, OT, specialist, nursing support and a ventilator simultaneously. Blocked resources: ${conflict.blockedResources.join(', ')}.`,
                resource: 'Multiple resources',
                affectedResource: `Case ${conflict.caseId} — multi-resource`,
                action: { label: 'Open resource optimisation', to: '/command/optimization' },
                source: 'Conflict detector',
              }),
            ),
          ...state.alerts.filter((alert) => alert.id !== 'ALR-CONF-01'),
        ],
        lastUpdated: new Date().toISOString(),
      };
    }

    /* ------------------------------------- recommendation level review (section 20) */
    case 'REJECT_RECOMMENDATION': {
      const existing = state.rejectedRecommendations || [];
      return {
        ...state,
        rejectedRecommendations: [
          ...existing.filter((entry) => entry.id !== action.recommendationId),
          {
            id: action.recommendationId,
            reason: action.reason || 'Rejected — alternative escalation required',
            at: new Date().toISOString(),
            by: action.by || 'Command Center',
          },
        ],
        lastUpdated: new Date().toISOString(),
      };
    }

    case 'RERAISE_RECOMMENDATION':
      return {
        ...state,
        rejectedRecommendations: (state.rejectedRecommendations || []).filter(
          (entry) => entry.id !== action.recommendationId,
        ),
        lastUpdated: new Date().toISOString(),
      };

    /* -------------------------------------------------- coordinator confirmation */
    case 'CONFIRM_ALLOCATION': {
      const { optimization } = state;
      if (!optimization) return state;
      const { state: confirmedState, metrics } = applyRecommendations(
        state,
        optimization.recommendations,
        action.selections || {},
        { withAllocation: true },
      );
      /* Re-detect conflicts against the new state but keep the mitigation trail. */
      const freshConflicts = detectConflicts(confirmedState, metrics);
      const conflicts = freshConflicts.map((conflict) => {
        const prior = (confirmedState.conflicts || []).find((entry) => entry.id === conflict.id);
        return prior
          ? {
              ...conflict,
              status: prior.status,
              mitigation: prior.mitigation,
              remainingBlocked: prior.remainingBlocked,
              gap: prior.gap ?? conflict.gap,
            }
          : conflict;
      });
      const next = {
        ...confirmedState,
        conflicts,
        approvals: state.approvals.map((approval) =>
          approval.id === action.approvalId
            ? {
                ...approval,
                status: 'Confirmed',
                confirmedAt: new Date().toISOString(),
                confirmedBy: action.confirmedBy || 'Resource Coordinator',
                selections: action.selections || {},
              }
            : approval,
        ),
        optimization: { ...optimization, confirmed: true, confirmedAt: new Date().toISOString() },
        surge: { ...confirmedState.surge, processed: true },
        alerts: [
          createAlert({
            id: 'ALR-CONF-02',
            type: 'Operational',
            category: 'Allocation',
            title: 'Resource allocation confirmed',
            description: `${confirmedState.allocations.length} patient placements confirmed across bed, staffing, equipment and theatre resources. ${confirmedState.queue.length} patients remain in the emergency queue awaiting capacity.`,
            resource: 'Multi-resource',
            affectedResource: `Emergency queue — ${confirmedState.queue.length} waiting`,
            action: { label: 'View allocations', to: '/resources/approvals' },
            source: 'Resource coordinator',
          }),
          ...confirmedState.alerts,
        ],
        lastUpdated: new Date().toISOString(),
      };
      next.simulationHistory = {
        ...state.simulationHistory,
        optimized: buildSnapshot(next, 'After allocation'),
      };
      return next;
    }

    case 'REJECT_ALLOCATION': {
      return {
        ...state,
        approvals: state.approvals.map((approval) =>
          approval.id === action.approvalId
            ? {
                ...approval,
                status: 'Rejected',
                rejectedAt: new Date().toISOString(),
                rejectedBy: action.rejectedBy || 'Resource Coordinator',
                rejectionReason: action.reason || 'Not specified',
              }
            : approval,
        ),
        alerts: [
          createAlert({
            id: 'ALR-REJ-01',
            type: 'Critical',
            category: 'Allocation',
            title: 'Optimisation recommendation rejected',
            description: `The resource reallocation recommendation was rejected. The surge backlog and ICU shortfall remain unresolved and require an alternative escalation path.`,
            resource: 'Multi-resource',
            affectedResource: `Emergency queue — ${state.queue.length} waiting`,
            action: { label: 'Re-run optimisation', to: '/command/optimization' },
            source: 'Resource coordinator',
          }),
          ...state.alerts,
        ],
      };
    }

    /* -------------------------------------------------- granular coordinator actions */
    case 'CONFIRM_BED_ALLOCATION': {
      const { bedId, patientId, resourceLabel } = action;
      const bedUnits = state.bedUnits.map((unit) =>
        unit.id === bedId
          ? {
              ...unit,
              status: BED_STATUS.RESERVED,
              patient: `${patientId} (confirmed)`,
              heldFor: `Allocation confirmed for ${patientId}`,
            }
          : unit,
      );
      const queue = state.queue.map((entry) =>
        entry.id === patientId
          ? {
              ...entry,
              status: 'Allocation Proposed',
              securedResources: [
                ...(entry.securedResources || []),
                { resource: resourceLabel, ref: bedId },
              ],
            }
          : entry,
      );
      return {
        ...state,
        bedUnits,
        queue,
        lastUpdated: new Date().toISOString(),
      };
    }

    case 'ASSIGN_DOCTOR': {
      const { queueId, doctorId } = action;
      const doctors = state.doctors.map((doctor) =>
        doctor.id === doctorId
          ? {
              ...doctor,
              availability: 'Assigned',
              patients: doctor.patients + 1,
              currentAssignment: `Assigned to ${queueId} by the resource coordinator`,
            }
          : doctor,
      );
      const queue = state.queue.map((entry) =>
        entry.id === queueId
          ? {
              ...entry,
              assignedDoctor: doctorId,
              status: 'Allocation Proposed',
              securedResources: [...(entry.securedResources || []), { resource: 'Doctor', ref: doctorId }],
            }
          : entry,
      );
      return { ...state, doctors, queue, lastUpdated: new Date().toISOString() };
    }

    case 'ASSIGN_NURSE': {
      const { queueId, nurseId, department } = action;
      const nurses = state.nurses.map((nurse) =>
        nurse.id === nurseId
          ? {
              ...nurse,
              availability: 'Assigned',
              assignedPatients: nurse.assignedPatients + 1,
              workload: nurse.assignedPatients + 1 >= 5 ? 'High' : nurse.workload,
              currentAssignment: department
                ? `Deployed to ${department} by the resource coordinator`
                : `Assigned to ${queueId} by the resource coordinator`,
            }
          : nurse,
      );
      const queue = state.queue.map((entry) =>
        entry.id === queueId
          ? {
              ...entry,
              assignedNurse: nurseId,
              status: 'Allocation Proposed',
              securedResources: [...(entry.securedResources || []), { resource: 'Nurse', ref: nurseId }],
            }
          : entry,
      );
      return { ...state, nurses, queue, lastUpdated: new Date().toISOString() };
    }

    case 'RESERVE_EQUIPMENT': {
      const { categoryId, unitId, patientId } = action;
      const equipment = state.equipment.map((category) => {
        if (category.id !== categoryId) return category;
        const units = category.units.map((unit) =>
          unit.id === unitId
            ? { ...unit, reserved: true, status: 'Reserved', reservedFor: `Reserved for ${patientId}` }
            : unit,
        );
        return { ...category, units, reserved: units.filter((unit) => unit.reserved).length };
      });
      const queue = state.queue.map((entry) =>
        entry.id === patientId
          ? {
              ...entry,
              status: 'Allocation Proposed',
              securedResources: [
                ...(entry.securedResources || []),
                { resource: 'Equipment', ref: unitId },
              ],
            }
          : entry,
      );
      return { ...state, equipment, queue, lastUpdated: new Date().toISOString() };
    }

    case 'RELEASE_EQUIPMENT': {
      const equipment = state.equipment.map((category) => {
        if (category.id !== action.categoryId) return category;
        const units = category.units.map((unit) =>
          unit.id === action.unitId
            ? { ...unit, reserved: false, status: 'Available', reservedFor: null }
            : unit,
        );
        return { ...category, units, reserved: units.filter((unit) => unit.reserved).length };
      });
      return { ...state, equipment, lastUpdated: new Date().toISOString() };
    }

    /* -------------------------------------------------- alerts */
    case 'ACKNOWLEDGE_ALERT':
      return {
        ...state,
        alerts: state.alerts.map((alert) =>
          alert.id === action.alertId ? { ...alert, status: 'Acknowledged', acknowledgedAt: new Date().toISOString() } : alert,
        ),
      };

    case 'RESOLVE_ALERT':
      return {
        ...state,
        alerts: state.alerts.map((alert) =>
          alert.id === action.alertId ? { ...alert, status: 'Resolved', resolvedAt: new Date().toISOString() } : alert,
        ),
      };

    case 'ACKNOWLEDGE_ALL':
      return {
        ...state,
        alerts: state.alerts.map((alert) =>
          alert.status === 'Active' ? { ...alert, status: 'Acknowledged', acknowledgedAt: new Date().toISOString() } : alert,
        ),
      };

    /* -------------------------------------------------- backend synchronization */
    case 'SET_DATA': {
      const incoming = action.payload;
      if (!incoming) return state;
      return {
        ...state,
        ...incoming,
        meta: incoming.meta || state.meta,
        queue: incoming.queue || state.queue,
        patients: incoming.patients || state.patients || [],
        doctors: incoming.doctors || state.doctors,
        nurses: incoming.nurses || state.nurses,
        bedUnits: incoming.bedUnits || incoming.beds || state.bedUnits,
        equipment: incoming.equipment || state.equipment,
        emergencyResources: incoming.emergencyResources || state.emergencyResources,
        otRooms: incoming.otRooms || state.otRooms,
        otBacklog: incoming.otBacklog || state.otBacklog,
        allocations: incoming.allocations || state.allocations,
        approvals: incoming.approvals || state.approvals,
        clinicalTasks: incoming.clinicalTasks || state.clinicalTasks,
        alerts: incoming.alerts || state.alerts,
        conflicts: incoming.conflicts || state.conflicts,
        escalation: incoming.escalation || state.escalation,
        surge: incoming.surge || state.surge,
        optimization: incoming.optimization !== undefined ? incoming.optimization : state.optimization,
        rejectedRecommendations: incoming.rejectedRecommendations || state.rejectedRecommendations,
        metrics: incoming.metrics || state.metrics,
        pressure: incoming.pressure || state.pressure,
        lastUpdated: incoming.generatedAt || new Date().toISOString(),
      };
    }

    /* -------------------------------------------------- manual patient management */
    case 'ADD_PATIENT': {
      const p = action.patient;
      const newEntry = {
        id: p.patientNumber || p.id || `P0${(state.queue.length + 10).toString().padStart(2, '0')}`,
        name: p.name,
        age: Number(p.age) || 45,
        sex: p.sex || 'F',
        priority: p.priority || 'Medium',
        triage: p.triage || 'Triage Category 3',
        department: p.department || 'Emergency',
        requiredResource: p.requiredResource || 'General Bed',
        waitingMinutes: 0,
        status: 'Waiting',
        requiresVentilator: Boolean(p.requiresVentilator),
        needsOt: Boolean(p.needsOt),
        specialtyRequired: p.specialtyRequired || 'Emergency Medicine',
        notes: p.notes || '',
      };
      return {
        ...state,
        queue: [newEntry, ...state.queue],
        lastUpdated: new Date().toISOString(),
      };
    }

    case 'EDIT_PATIENT': {
      return {
        ...state,
        queue: state.queue.map((entry) => (entry.id === action.patientId ? { ...entry, ...action.patient } : entry)),
        lastUpdated: new Date().toISOString(),
      };
    }

    case 'DISCHARGE_PATIENT': {
      return {
        ...state,
        queue: state.queue.filter((entry) => entry.id !== action.patientId),
        bedUnits: state.bedUnits.map((b) =>
          b.patient && b.patient.includes(action.patientId)
            ? { ...b, status: BED_STATUS.AVAILABLE, patient: null, heldFor: null }
            : b,
        ),
        lastUpdated: new Date().toISOString(),
      };
    }

    default:
      return state;
  }
}

export function HospitalProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const { user } = useAuthContext();
  const { now, tick, clock, activity, pushActivity, elapsedMinutes } = useLiveTicker({
    intervalMs: 5000,
  });

  // Queue timers advance one queue-minute per real minute (12 x 5s ticks).
  useEffect(() => {
    if (tick > 0 && tick % 12 === 0) dispatch({ type: 'TICK_MINUTE' });
  }, [tick]);

  /* ------------------------------------------- backend data synchronization */
  const refreshFromBackend = useCallback(async () => {
    if (!BACKEND_CONFIGURED) return;
    try {
      const token = getToken();
      if (!token) return;
      const data = await api.overview();
      if (data) {
        dispatch({ type: 'SET_DATA', payload: data });
      }
    } catch (err) {
      console.warn('Hospital data refresh notice:', err?.message);
    }
  }, []);

  // Hydrate on mount and when user session changes
  useEffect(() => {
    refreshFromBackend();
  }, [user, refreshFromBackend]);

  // Realtime Socket.IO operational event bridge
  useEffect(() => {
    connectSocket();
    const offEvent = onOperationalEvent(() => {
      refreshFromBackend();
    });
    return () => {
      offEvent();
      disconnectSocket();
    };
  }, [refreshFromBackend]);

  const metrics = useMemo(() => state.metrics || calculateHospitalMetrics(state), [state]);
  const pressure = useMemo(() => state.pressure || calculateResourcePressure(state), [state]);

  const actions = useMemo(
    () => ({
      refreshFromBackend,
      runSurge: async () => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.runSimulation({ patientCount: 20 });
            if (res) {
              await refreshFromBackend();
              pushActivity('SURGE DETECTED — mass-casualty intake registered (+20 patients)', 'alert');
              pushActivity('Emergency queue re-scoped with 20 additional waiting patients', 'alert');
              return { ok: true, data: res };
            }
          }
        } catch (err) {
          console.warn('api.runSimulation notice:', err?.message);
        }
        dispatch({ type: 'RUN_SURGE' });
        pushActivity('SURGE DETECTED — mass-casualty intake registered (+20 patients)', 'alert');
        pushActivity('Emergency queue re-scoped from 8 to 28 waiting patients', 'alert');
        pushActivity('ICU-08 provisionally held for highest-acuity case P009', 'info');
        pushActivity('Monitored emergency bays and general beds placed on provisional hold', 'info');
        return { ok: true };
      },
      resetDemo: async () => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            await api.revertSimulation();
            await refreshFromBackend();
            pushActivity('Demonstration reset — hospital restored to baseline state', 'success');
            return { ok: true };
          }
        } catch (err) {
          console.warn('api.revertSimulation notice:', err?.message);
        }
        dispatch({ type: 'RESET_DEMO' });
        pushActivity('Demonstration reset — hospital restored to baseline state', 'success');
        return { ok: true };
      },
      refresh: async () => {
        await refreshFromBackend();
        dispatch({ type: 'REFRESH' });
        pushActivity('Operational snapshot refreshed from hospital data layer', 'info');
      },
      recordRequirement: (patientId, note) => {
        dispatch({ type: 'RECORD_REQUIREMENT', patientId, note, recordedBy: user?.name || 'Clinical staff' });
        pushActivity(`Clinical requirement confirmed for ${patientId} by ${user?.name || 'clinical staff'}`, 'alert');
      },
      completeTask: (taskId) => {
        dispatch({ type: 'COMPLETE_TASK', taskId, completedBy: user?.name || 'Clinical staff' });
        pushActivity('Clinical task marked complete', 'success');
      },
      addTaskNote: (taskId, note) => {
        dispatch({ type: 'UPDATE_TASK_NOTE', taskId, note });
        pushActivity('Clinical note recorded against a task', 'info');
      },
      optimize: async (selections = {}, replacePending = false) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.optimize({ selections });
            if (res) {
              await refreshFromBackend();
              pushActivity('Multi-resource optimisation analysis completed', 'success');
              pushActivity('Approval request APX raised for the resource coordinator', 'info');
              return { ok: true, data: res };
            }
          }
        } catch (err) {
          console.warn('api.optimize notice:', err?.message);
        }
        dispatch({
          type: 'RUN_OPTIMIZATION',
          selections,
          requestedBy: `${user?.name || 'Command Center'} · ${user?.staffRef || ''}`.trim(),
          replacePending,
        });
        pushActivity('Multi-resource optimisation analysis completed', 'success');
        pushActivity('Approval request APX raised for the resource coordinator', 'info');
        return { ok: true };
      },
      approveRecommendation: async (recommendationId, selections = {}) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.approveRecommendation(recommendationId, selections);
            await refreshFromBackend();
            pushActivity(`Recommendation ${recommendationId} approved and applied`, 'success');
            return { ok: true, data: res };
          }
        } catch (err) {
          pushActivity(`Approval conflict: ${err.message}`, 'alert');
          throw err;
        }
        dispatch({ type: 'CONFIRM_ALLOCATION', approvalId: recommendationId, selections });
        pushActivity(`Recommendation ${recommendationId} approved`, 'success');
        return { ok: true };
      },
      rejectRecommendation: async (recommendationId, reason) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.rejectRecommendation(recommendationId, { reason });
            await refreshFromBackend();
            pushActivity(`Recommendation ${recommendationId} rejected — ${reason || 'alternative escalation required'}`, 'alert');
            return { ok: true, data: res };
          }
        } catch (err) {
          console.warn('api.rejectRecommendation notice:', err?.message);
        }
        dispatch({ type: 'REJECT_RECOMMENDATION', recommendationId, reason, by: user?.name || 'Command Center' });
        pushActivity(`Recommendation ${recommendationId} rejected — alternative escalation required`, 'alert');
        return { ok: true };
      },
      confirmAllocation: async (approvalId, selections = {}) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.approveAllocation(approvalId, selections);
            await refreshFromBackend();
            pushActivity('ALLOCATION CONFIRMED — multi-resource placement executed', 'success');
            return { ok: true, data: res };
          }
        } catch (err) {
          pushActivity(`Allocation error: ${err.message}`, 'alert');
          throw err;
        }
        dispatch({
          type: 'CONFIRM_ALLOCATION',
          approvalId,
          selections,
          confirmedBy: `${user?.name || 'Resource Coordinator'}`,
        });
        pushActivity('ALLOCATION CONFIRMED — multi-resource placement executed', 'success');
        return { ok: true };
      },
      reraiseRecommendation: (recommendationId) => {
        dispatch({ type: 'RERAISE_RECOMMENDATION', recommendationId });
        pushActivity(`Recommendation ${recommendationId} re-raised for review`, 'info');
      },
      rejectAllocation: async (approvalId, reason) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.rejectAllocation(approvalId, { reason });
            await refreshFromBackend();
            pushActivity('Optimisation recommendation rejected by coordinator', 'alert');
            return { ok: true, data: res };
          }
        } catch (err) {
          console.warn('api.rejectAllocation notice:', err?.message);
        }
        dispatch({
          type: 'REJECT_ALLOCATION',
          approvalId,
          reason,
          rejectedBy: user?.name || 'Resource Coordinator',
        });
        pushActivity('Optimisation recommendation rejected by coordinator', 'alert');
        return { ok: true };
      },
      addPatient: async (patientData) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.createPatient(patientData);
            await refreshFromBackend();
            const name = res?.patient?.name || res?.queue?.name || patientData.name;
            pushActivity(`Patient registered: ${name}`, 'success');
            return { ok: true, data: res };
          }
        } catch (err) {
          pushActivity(`Failed to register patient: ${err.message}`, 'alert');
          throw err;
        }
        dispatch({ type: 'ADD_PATIENT', patient: patientData });
        pushActivity(`Patient registered: ${patientData.name}`, 'success');
        return { ok: true };
      },
      editPatient: async (patientId, patientData) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.updatePatient(patientId, patientData);
            await refreshFromBackend();
            pushActivity(`Patient ${patientId} updated`, 'info');
            return { ok: true, data: res };
          }
        } catch (err) {
          pushActivity(`Failed to update patient: ${err.message}`, 'alert');
          throw err;
        }
        dispatch({ type: 'EDIT_PATIENT', patientId, patient: patientData });
        return { ok: true };
      },
      dischargePatient: async (patientId, reason) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.dischargePatient(patientId, { reason: reason || 'Discharge completed' });
            await refreshFromBackend();
            pushActivity(`Patient ${patientId} discharged — bed and staff resources released`, 'success');
            return { ok: true, data: res };
          }
        } catch (err) {
          pushActivity(`Failed to discharge patient: ${err.message}`, 'alert');
          throw err;
        }
        dispatch({ type: 'DISCHARGE_PATIENT', patientId, reason });
        pushActivity(`Patient ${patientId} discharged`, 'success');
        return { ok: true };
      },
      assignBed: async (bedId, patientId, notes) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.assignBed(bedId, { patientId, notes });
            await refreshFromBackend();
            pushActivity(`Bed ${bedId} assigned to ${patientId}`, 'success');
            return { ok: true, data: res };
          }
        } catch (err) {
          pushActivity(`Failed to assign bed: ${err.message}`, 'alert');
          throw err;
        }
        dispatch({ type: 'CONFIRM_BED_ALLOCATION', bedId, patientId, resourceLabel: 'Bed' });
        return { ok: true };
      },
      releaseBed: async (bedId, reason) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            const res = await api.releaseBed(bedId, { reason });
            await refreshFromBackend();
            pushActivity(`Bed ${bedId} released`, 'info');
            return { ok: true, data: res };
          }
        } catch (err) {
          pushActivity(`Failed to release bed: ${err.message}`, 'alert');
          throw err;
        }
        return { ok: true };
      },
      confirmBedAllocation: async (bedId, patientId, resourceLabel) => {
        dispatch({ type: 'CONFIRM_BED_ALLOCATION', bedId, patientId, resourceLabel });
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            await api.assignBed(bedId, { patientId, reason: `Allocated to ${patientId}` });
            await refreshFromBackend();
          }
        } catch (err) {
          console.warn('api.assignBed notice:', err?.message);
        }
        pushActivity(`${bedId} allocation confirmed for ${patientId}`, 'success');
      },
      assignDoctor: (queueId, doctorId) => {
        dispatch({ type: 'ASSIGN_DOCTOR', queueId, doctorId });
        pushActivity(`${doctorId} assigned to ${queueId} by the resource coordinator`, 'success');
      },
      assignNurse: (queueId, nurseId, department) => {
        dispatch({ type: 'ASSIGN_NURSE', queueId, nurseId, department });
        pushActivity(
          department
            ? `${nurseId} deployed to ${department} by the resource coordinator`
            : `${nurseId} assigned to ${queueId} by the resource coordinator`,
          'success',
        );
      },
      reserveEquipment: async (categoryId, unitId, patientId) => {
        dispatch({ type: 'RESERVE_EQUIPMENT', categoryId, unitId, patientId });
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            await api.reserveEquipment({ categoryId, unitId, patientId });
            await refreshFromBackend();
          }
        } catch (err) {
          console.warn('api.reserveEquipment notice:', err?.message);
        }
        pushActivity(`${unitId} reserved for ${patientId}`, 'info');
      },
      releaseEquipment: async (categoryId, unitId) => {
        dispatch({ type: 'RELEASE_EQUIPMENT', categoryId, unitId });
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            await api.releaseEquipment({ categoryId, unitId });
            await refreshFromBackend();
          }
        } catch (err) {
          console.warn('api.releaseEquipment notice:', err?.message);
        }
        pushActivity(`${unitId} released back to standby pool`, 'info');
      },
      acknowledgeAlert: async (alertId) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            await api.acknowledgeAlert(alertId);
            await refreshFromBackend();
          }
        } catch (err) {
          console.warn('api.acknowledgeAlert notice:', err?.message);
        }
        dispatch({ type: 'ACKNOWLEDGE_ALERT', alertId });
      },
      resolveAlert: async (alertId) => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            await api.resolveAlert(alertId);
            await refreshFromBackend();
          }
        } catch (err) {
          console.warn('api.resolveAlert notice:', err?.message);
        }
        dispatch({ type: 'RESOLVE_ALERT', alertId });
        pushActivity('Alert resolved by command staff', 'success');
      },
      acknowledgeAll: async () => {
        try {
          if (BACKEND_CONFIGURED && getToken()) {
            await api.acknowledgeAllAlerts();
            await refreshFromBackend();
          }
        } catch (err) {
          console.warn('api.acknowledgeAllAlerts notice:', err?.message);
        }
        dispatch({ type: 'ACKNOWLEDGE_ALL' });
        pushActivity('All active alerts acknowledged', 'success');
      },
      /* Also exposed on `actions` so pages can keep every mutation on one
         object (actions.pushActivity) while the feed line stays consistent. */
      pushActivity,
    }),
    [pushActivity, user, refreshFromBackend],
  );

  const value = useMemo(
    () => ({
      state,
      dispatch,
      actions,
      metrics,
      pressure,
      activity,
      pushActivity,
      clock,
      now,
      elapsedMinutes,
      lastUpdatedLabel: formatTimeLabel(now),
      user,
    }),
    [state, actions, metrics, pressure, activity, pushActivity, clock, now, elapsedMinutes, user],
  );

  return <HospitalContext.Provider value={value}>{children}</HospitalContext.Provider>;
}

export function useHospitalContext() {
  const context = useContext(HospitalContext);
  if (!context) throw new Error('useHospitalContext must be used inside HospitalProvider');
  return context;
}

export default HospitalContext;

