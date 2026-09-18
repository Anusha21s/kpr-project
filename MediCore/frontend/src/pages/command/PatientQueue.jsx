import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ListChecks, UserPlus } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import SearchBar from '../../components/SearchBar';
import FilterBar from '../../components/FilterBar';
import DetailModal from '../../components/DetailModal';
import Modal from '../../components/Modal';
import ConfirmationModal from '../../components/ConfirmationModal';
import StatTile from '../../components/StatTile';
import { useHospital } from '../../hooks/useHospital';
import { rankQueue } from '../../utils/optimizationEngine';

const INITIAL_PATIENT_FORM = {
  name: '',
  age: '',
  sex: 'F',
  triage: 'Triage Category 3',
  priority: 'Medium',
  department: 'Emergency',
  requiredResource: 'General Bed',
  secondaryResource: '',
  specialtyRequired: 'Emergency Medicine',
  requiresVentilator: false,
  needsOt: false,
  notes: '',
};

/**
 * Patient Queue (section 12) — fast scanning, five columns, detail in a modal.
 */
export default function PatientQueue() {
  const { state, metrics, actions } = useHospital();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [resource, setResource] = useState('all');
  const [selected, setSelected] = useState(null);

  // Manual Patient Management states
  const [showAddModal, setShowAddModal] = useState(false);
  const [patientForm, setPatientForm] = useState(INITIAL_PATIENT_FORM);
  const [addError, setAddError] = useState('');
  const [submittingAdd, setSubmittingAdd] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [editError, setEditError] = useState('');
  const [submittingEdit, setSubmittingEdit] = useState(false);

  const [dischargeTarget, setDischargeTarget] = useState(null);

  const focusedId = location.state?.focusPatient;

  const handleAddSubmit = async (e) => {
    e?.preventDefault();
    if (!patientForm.name.trim()) {
      setAddError('Patient name is required.');
      return;
    }
    const age = parseInt(patientForm.age, 10);
    if (!age || age < 0 || age > 130) {
      setAddError('Valid age between 0 and 130 is required.');
      return;
    }
    setAddError('');
    setSubmittingAdd(true);
    try {
      await actions.addPatient({
        name: patientForm.name.trim(),
        age,
        sex: patientForm.sex,
        priority: patientForm.priority,
        triage: patientForm.triage,
        department: patientForm.department || 'Emergency',
        requiredResource: patientForm.requiredResource || 'General Bed',
        secondaryResource: patientForm.secondaryResource || null,
        specialtyRequired: patientForm.specialtyRequired || 'Emergency Medicine',
        requiresVentilator: Boolean(patientForm.requiresVentilator),
        needsOt: Boolean(patientForm.needsOt),
        notes: patientForm.notes.trim() || undefined,
      });
      setShowAddModal(false);
      setPatientForm(INITIAL_PATIENT_FORM);
    } catch (err) {
      setAddError(err?.message || 'Failed to create patient. Check inputs.');
    } finally {
      setSubmittingAdd(false);
    }
  };

  const handleEditSubmit = async (e) => {
    e?.preventDefault();
    if (!editForm) return;
    setEditError('');
    setSubmittingEdit(true);
    try {
      await actions.editPatient(editForm.id, {
        priority: editForm.priority,
        department: editForm.department,
        requiredResource: editForm.requiredResource,
        secondaryResource: editForm.secondaryResource || null,
        specialtyRequired: editForm.specialtyRequired,
        requiresVentilator: Boolean(editForm.requiresVentilator),
        needsOt: Boolean(editForm.needsOt),
        notes: editForm.notes || undefined,
      });
      setShowEditModal(false);
      if (selected && selected.id === editForm.id) {
        setSelected((prev) => ({ ...prev, ...editForm }));
      }
    } catch (err) {
      setEditError(err?.message || 'Failed to update patient.');
    } finally {
      setSubmittingEdit(false);
    }
  };

  const handleDischargeConfirm = async ({ reason }) => {
    if (!dischargeTarget) return;
    try {
      await actions.dischargePatient(dischargeTarget.id, reason);
      setDischargeTarget(null);
      if (selected && selected.id === dischargeTarget.id) {
        setSelected(null);
      }
    } catch (err) {
      console.error('Failed to discharge patient:', err);
    }
  };

  const resourceOptions = useMemo(
    () => Array.from(new Set(state.queue.map((entry) => entry.requiredResource))).sort(),
    [state.queue],
  );

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rankQueue(state.queue).filter((entry) => {
      const matchesTerm =
        !term ||
        [entry.id, entry.department, entry.specialtyRequired, entry.clinicalRequirementBy]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(term));
      const matchesPriority = priority === 'all' || entry.priority === priority;
      const matchesResource = resource === 'all' || entry.requiredResource === resource;
      return matchesTerm && matchesPriority && matchesResource;
    });
  }, [state.queue, query, priority, resource]);

  const activeFilters = (priority !== 'all' ? 1 : 0) + (resource !== 'all' ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="page">
      <section className="kpi-row" aria-label="Queue summary">
        <KpiTile label="Waiting" icon={ListChecks} value={metrics.queue.total} caption="Patients in the queue" />
        <KpiTile label="Critical" icon={ListChecks} tone="alert" value={metrics.queue.critical} caption="Require immediate placement" />
        <KpiTile label="High priority" icon={ListChecks} value={metrics.queue.high} caption="Awaiting a resource" />
        <KpiTile label="Average wait" icon={ListChecks} tone="teal" value={metrics.queue.averageWait} suffix=" min" caption={`Longest ${metrics.queue.longestWait} min`} />
        <KpiTile label="ICU requests" icon={ListChecks} tone={metrics.beds.icu.available <= 1 ? 'alert' : 'teal'} value={metrics.queue.icuRequests} caption={`${metrics.beds.icu.available} ICU beds vacant`} />
        <KpiTile label="Bed requests" icon={ListChecks} value={metrics.queue.generalBedRequests + metrics.queue.emergencyBedRequests} caption={`${metrics.queue.generalBedRequests} general · ${metrics.queue.emergencyBedRequests} emergency`} />
      </section>

      <Panel
        title="Emergency queue"
        icon={ListChecks}
        subtitle={`${rows.length} patient(s) shown · requirement recorded by the clinical team`}
        actions={
          <div className="row row-tight">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setPatientForm(INITIAL_PATIENT_FORM);
                setAddError('');
                setShowAddModal(true);
              }}
            >
              <UserPlus size={14} aria-hidden="true" />
              Add Patient
            </button>
            <Link className="btn btn-outline btn-sm" to="/command/optimization">
              Optimize resources
            </Link>
          </div>
        }
      >
        <FilterBar
          search={
            <SearchBar
              value={query}
              onChange={setQuery}
              onClear={() => setQuery('')}
              placeholder="Search patient, department or specialty…"
              label="Search queue"
              id="queue-search"
            />
          }
          filters={[
            {
              id: 'priority',
              label: 'Priority',
              value: priority,
              onChange: setPriority,
              options: [
                { value: 'all', label: 'All priorities' },
                { value: 'Critical', label: 'Critical' },
                { value: 'High', label: 'High' },
                { value: 'Medium', label: 'Medium' },
                { value: 'Low', label: 'Low' },
              ],
            },
            {
              id: 'resource',
              label: 'Required',
              value: resource,
              onChange: setResource,
              options: [{ value: 'all', label: 'All resources' }, ...resourceOptions.map((option) => ({ value: option, label: option }))],
            },
          ]}
          activeCount={activeFilters}
          resultCount={rows.length}
          resultLabel="patients"
          onReset={() => {
            setQuery('');
            setPriority('all');
            setResource('all');
          }}
        />

        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={[
              { key: 'id', header: 'Patient', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'priority', header: 'Priority', render: (row) => <StatusBadge status={row.priority} size="sm" /> },
              { key: 'requiredResource', header: 'Required unit' },
              { key: 'waitingMinutes', header: 'Waiting', render: (row) => `${row.waitingMinutes} min` },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
            ]}
            rows={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="No patients match this view"
            emptyText="Change the filters to see other patients."
          />
        </div>
      </Panel>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Patient ${selected.id}` : ''}
        subtitle={selected ? `${selected.name || 'Patient'} · ${selected.age}y ${selected.sex} · ${selected.department} · ${selected.triage}` : ''}
        size="md"
        badge={
          selected ? (
            <>
              <StatusBadge status={selected.priority} size="sm" />
              <StatusBadge status={selected.status} size="sm" />
            </>
          ) : null
        }
        footer={
          selected ? (
            <div className="row row-tight" style={{ justifyContent: 'space-between', width: '100%' }}>
              <div className="row row-tight">
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setEditForm({ ...selected });
                    setEditError('');
                    setShowEditModal(true);
                  }}
                >
                  Edit Patient
                </button>
                <button
                  type="button"
                  className="btn btn-critical btn-sm"
                  onClick={() => setDischargeTarget(selected)}
                >
                  Discharge
                </button>
              </div>
              <Link className="btn btn-primary btn-sm" to={selected.requiredResource === 'ICU Bed' ? '/command/beds' : '/command/beds'}>
                Open bed capacity
              </Link>
            </div>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="stat-grid cols-3">
              <StatTile label="Requires" value={selected.requiredResource} hint={selected.secondaryResource ? `then ${selected.secondaryResource}` : 'Primary requirement'} />
              <StatTile label="Waiting" value={`${selected.waitingMinutes} min`} hint="Since triage" />
              <StatTile label="Specialty" value={selected.specialtyRequired} hint="Recorded requirement" />
            </div>
            <div className="kv">
              <span className="kv-key">Requirement recorded by</span>
              <span className="kv-value">{selected.clinicalRequirementBy || 'Clinical team'}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Ventilator</span>
              <span className="kv-value">{selected.requiresVentilator ? 'Required' : 'Not required'}</span>
            </div>
            <div className="kv">
              <span className="kv-key">Theatre</span>
              <span className="kv-value">{selected.needsOt ? 'Surgical slot requested' : 'Not requested'}</span>
            </div>
            {selected.notes ? <p className="text-small text-secondary">{selected.notes}</p> : null}
          </>
        ) : null}
      </DetailModal>

      {/* -------------------------------------------------- Add Patient Modal */}
      <Modal
        open={showAddModal}
        title="Register New Patient Intake"
        subtitle="Add a patient to the emergency triage queue and allocate requirements"
        onClose={() => setShowAddModal(false)}
        size="md"
        footer={
          <>
            <button type="button" className="btn btn-outline" onClick={() => setShowAddModal(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleAddSubmit}
              disabled={submittingAdd}
            >
              {submittingAdd ? 'Registering…' : 'Register Patient'}
            </button>
          </>
        }
      >
        <form onSubmit={handleAddSubmit} className="stack" style={{ gap: 14 }}>
          {addError ? (
            <div className="alert alert-danger" style={{ padding: '8px 12px', borderRadius: 4, background: 'rgba(239, 68, 68, 0.12)', color: '#fca5a5', border: '1px solid rgba(239, 68, 68, 0.3)', fontSize: 13 }}>
              {addError}
            </div>
          ) : null}

          <label className="field">
            <span className="field-label">Patient Full Name *</span>
            <input
              type="text"
              className="input"
              required
              placeholder="e.g. Ramesh Chandra"
              value={patientForm.name}
              onChange={(e) => setPatientForm({ ...patientForm, name: e.target.value })}
            />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label className="field">
              <span className="field-label">Age *</span>
              <input
                type="number"
                className="input"
                required
                min="0"
                max="130"
                placeholder="Age in years"
                value={patientForm.age}
                onChange={(e) => setPatientForm({ ...patientForm, age: e.target.value })}
              />
            </label>

            <label className="field">
              <span className="field-label">Gender *</span>
              <select
                className="input"
                value={patientForm.sex}
                onChange={(e) => setPatientForm({ ...patientForm, sex: e.target.value })}
              >
                <option value="M">Male</option>
                <option value="F">Female</option>
                <option value="Other">Other</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label className="field">
              <span className="field-label">Priority Level *</span>
              <select
                className="input"
                value={patientForm.priority}
                onChange={(e) => setPatientForm({ ...patientForm, priority: e.target.value })}
              >
                <option value="Critical">Critical (Immediate placement)</option>
                <option value="High">High (Within 30m)</option>
                <option value="Medium">Medium (Within 60m)</option>
                <option value="Low">Low (Routine queue)</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">Triage Category *</span>
              <select
                className="input"
                value={patientForm.triage}
                onChange={(e) => setPatientForm({ ...patientForm, triage: e.target.value })}
              >
                <option value="Triage Category 1">Category 1 — Resuscitation</option>
                <option value="Triage Category 2">Category 2 — Emergency</option>
                <option value="Triage Category 3">Category 3 — Urgent</option>
                <option value="Triage Category 4">Category 4 — Semi-urgent</option>
                <option value="Triage Category 5">Category 5 — Non-urgent</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label className="field">
              <span className="field-label">Department</span>
              <input
                type="text"
                className="input"
                value={patientForm.department}
                onChange={(e) => setPatientForm({ ...patientForm, department: e.target.value })}
                placeholder="e.g. Emergency, Cardiology, Trauma"
              />
            </label>

            <label className="field">
              <span className="field-label">Required Resource *</span>
              <select
                className="input"
                value={patientForm.requiredResource}
                onChange={(e) => setPatientForm({ ...patientForm, requiredResource: e.target.value })}
              >
                <option value="General Bed">General Bed</option>
                <option value="ICU Bed">ICU Bed</option>
                <option value="Emergency Bed">Emergency Bed</option>
                <option value="Maternity Bed">Maternity Bed</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 20, alignItems: 'center', marginTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={patientForm.requiresVentilator}
                onChange={(e) => setPatientForm({ ...patientForm, requiresVentilator: e.target.checked })}
              />
              <span>Requires Ventilator</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={patientForm.needsOt}
                onChange={(e) => setPatientForm({ ...patientForm, needsOt: e.target.checked })}
              />
              <span>Requires Theatre / OT</span>
            </label>
          </div>

          <label className="field">
            <span className="field-label">Clinical Notes / Initial Assessment</span>
            <textarea
              className="input"
              rows={2}
              placeholder="Clinical observations, vital signs, presenting complaints…"
              value={patientForm.notes}
              onChange={(e) => setPatientForm({ ...patientForm, notes: e.target.value })}
            />
          </label>
        </form>
      </Modal>

      {/* -------------------------------------------------- Edit Patient Modal */}
      <Modal
        open={showEditModal && Boolean(editForm)}
        title={editForm ? `Edit Patient ${editForm.id}` : 'Edit Patient'}
        subtitle="Update priority, resource requirements, or clinical notes"
        onClose={() => setShowEditModal(false)}
        size="md"
        footer={
          <>
            <button type="button" className="btn btn-outline" onClick={() => setShowEditModal(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleEditSubmit}
              disabled={submittingEdit}
            >
              {submittingEdit ? 'Saving…' : 'Save Changes'}
            </button>
          </>
        }
      >
        {editForm ? (
          <form onSubmit={handleEditSubmit} className="stack" style={{ gap: 14 }}>
            {editError ? (
              <div className="alert alert-danger" style={{ padding: '8px 12px', borderRadius: 4, background: 'rgba(239, 68, 68, 0.12)', color: '#fca5a5', border: '1px solid rgba(239, 68, 68, 0.3)', fontSize: 13 }}>
                {editError}
              </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label className="field">
                <span className="field-label">Priority Level</span>
                <select
                  className="input"
                  value={editForm.priority}
                  onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}
                >
                  <option value="Critical">Critical</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Low">Low</option>
                </select>
              </label>

              <label className="field">
                <span className="field-label">Department</span>
                <input
                  type="text"
                  className="input"
                  value={editForm.department || ''}
                  onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
                />
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label className="field">
                <span className="field-label">Required Resource</span>
                <select
                  className="input"
                  value={editForm.requiredResource}
                  onChange={(e) => setEditForm({ ...editForm, requiredResource: e.target.value })}
                >
                  <option value="General Bed">General Bed</option>
                  <option value="ICU Bed">ICU Bed</option>
                  <option value="Emergency Bed">Emergency Bed</option>
                  <option value="Maternity Bed">Maternity Bed</option>
                </select>
              </label>

              <label className="field">
                <span className="field-label">Specialty Required</span>
                <input
                  type="text"
                  className="input"
                  value={editForm.specialtyRequired || ''}
                  onChange={(e) => setEditForm({ ...editForm, specialtyRequired: e.target.value })}
                />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 20, alignItems: 'center', marginTop: 4 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Boolean(editForm.requiresVentilator)}
                  onChange={(e) => setEditForm({ ...editForm, requiresVentilator: e.target.checked })}
                />
                <span>Requires Ventilator</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Boolean(editForm.needsOt)}
                  onChange={(e) => setEditForm({ ...editForm, needsOt: e.target.checked })}
                />
                <span>Requires Theatre / OT</span>
              </label>
            </div>

            <label className="field">
              <span className="field-label">Clinical Notes</span>
              <textarea
                className="input"
                rows={2}
                value={editForm.notes || ''}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              />
            </label>
          </form>
        ) : null}
      </Modal>

      {/* -------------------------------------------------- Discharge Confirmation Modal */}
      <ConfirmationModal
        open={Boolean(dischargeTarget)}
        title={dischargeTarget ? `Discharge Patient ${dischargeTarget.id}` : 'Discharge Patient'}
        subtitle={dischargeTarget ? `${dischargeTarget.name || 'Patient'} · ${dischargeTarget.department} · ${dischargeTarget.priority}` : ''}
        tone="critical"
        confirmLabel="Discharge Patient"
        requireReason={true}
        reasonLabel="Discharge reason / clinical summary"
        reasonPlaceholder="e.g. Treatment complete, transferred to outpatient care, or patient stabilized."
        onClose={() => setDischargeTarget(null)}
        onConfirm={handleDischargeConfirm}
        consequences={[
          'Releases assigned bed, staff, and equipment back to available hospital capacity.',
          'Closes active triage queue ticket and updates queue metrics.',
          'Records discharge decision in the patient history audit log.',
        ]}
      />

      {focusedId ? <p className="page-footnote">Opened from the command center · patient {focusedId}</p> : null}
    </div>
  );
}

