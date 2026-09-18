import { useState } from 'react';
import { BedDouble, HeartPulse } from 'lucide-react';
import Panel from '../../components/Panel';
import KpiTile from '../../components/KpiTile';
import DataTable from '../../components/DataTable';
import StatusBadge from '../../components/StatusBadge';
import DetailModal from '../../components/DetailModal';
import StatTile from '../../components/StatTile';
import UsageBar from '../../components/UsageBar';
import { useHospital } from '../../hooks/useHospital';
import { useAuth } from '../../hooks/useAuth';
import { getPatientsForUser } from '../../data/clinical';

/**
 * ICU / Ward (clinical) — the beds in my assigned area and my patients in them.
 * Availability is shown as coordination context, not as a clinical decision.
 */
export default function IcuWard() {
  const { state, metrics } = useHospital();
  const { user } = useAuth();
  const [selected, setSelected] = useState(null);

  const focusWardId = user.role === 'nurse' || /icu/i.test(user.department) ? 'icu' : 'general';
  const focusWard = metrics.beds.wards.find((ward) => ward.id === focusWardId) || metrics.beds.general;
  const wardUnits = state.bedUnits.filter((unit) => unit.wardId === focusWardId);
  const myPatients = getPatientsForUser(user.staffRef);
  const myBeds = myPatients.map((patient) => patient.bed);
  const myWardUnits = wardUnits.filter((unit) => myBeds.includes(unit.id));

  return (
    <div className="page">
      {focusWard.available <= 1 ? (
        <div className="alert-line is-critical" role="status">
          <div className="alert-line-main">
            <span className="alert-line-title">{focusWard.name} has {focusWard.available} bed available</span>
            <span className="alert-line-meta">
              {metrics.queue.icuRequests} ICU-level requests are waiting in the emergency queue — coordinator review in progress.
            </span>
          </div>
        </div>
      ) : null}

      <section className="kpi-row" aria-label={focusWard.name}>
        <KpiTile label="Beds" icon={BedDouble} value={focusWard.total} caption={focusWard.name} />
        <KpiTile label="Occupied" icon={BedDouble} value={focusWard.committed} caption={`${focusWard.reserved} held for incoming cases`} />
        <KpiTile label="Available" icon={BedDouble} tone={focusWard.available <= 1 ? 'alert' : 'teal'} value={focusWard.available} caption="Ready for allocation" />
        <KpiTile label="Occupancy" icon={HeartPulse} tone={focusWard.occupancyPercentage >= 90 ? 'alert' : 'blue'} value={focusWard.occupancyPercentage} suffix="%" caption="Against configured beds" progress={focusWard.occupancyPercentage} />
        <KpiTile label="My patients here" icon={HeartPulse} value={myWardUnits.length} caption="Assigned to me in this ward" />
        <KpiTile label="Waiting for this ward" icon={HeartPulse} tone={metrics.queue.icuRequests ? 'alert' : 'teal'} value={focusWardId === 'icu' ? metrics.queue.icuRequests : metrics.queue.generalBedRequests} caption="Queued requests" />
      </section>

      <section className="grid-2">
        <Panel title={`${focusWard.name} — beds`} icon={BedDouble} subtitle={`${wardUnits.length} bed(s) · open a bed for the record`}>
          <DataTable
            columns={[
              { key: 'id', header: 'Bed', strong: true, render: (row) => <span className="mono">{row.id}</span> },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} size="sm" /> },
              { key: 'patient', header: 'Patient', render: (row) => (row.patient ? <span className="mono">{row.patient}</span> : '—') },
              { key: 'mine', header: 'Mine', render: (row) => (myBeds.includes(row.id) ? 'Yes' : '—') },
            ]}
            rows={wardUnits}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            compact
          />
        </Panel>

        <div className="stack-lg">
          <Panel title="Ward pressure" icon={HeartPulse} subtitle="How this ward sits against demand">
            <UsageBar label="Occupancy" value={focusWard.occupancyPercentage} tone={focusWard.occupancyPercentage >= 90 ? 'alert' : 'teal'} />
            <div className="stat-grid cols-2" style={{ marginTop: 12 }}>
              <StatTile label="Held for incoming" value={focusWard.reserved} hint="Provisional holds" />
              <StatTile label="Escalation beds" value={metrics.beds.escalation} hint="Step-down bays active" />
              <StatTile label="Nurses available" value={metrics.nurses.available} hint={`${metrics.nurses.atConstraint} at limit`} tone={metrics.nurses.atConstraint ? 'alert' : 'neutral'} />
              <StatTile label="Ventilators free" value={metrics.equipment.ventilators.available} hint={`${metrics.queue.ventilatorRequests} required`} tone={metrics.equipment.ventilators.available <= 3 ? 'alert' : 'neutral'} />
            </div>
          </Panel>

          <Panel title="My patients in this ward" icon={HeartPulse} subtitle={`${myWardUnits.length} of my patients`}>
            <ul className="conflict-list">
              {myWardUnits.map((unit) => {
                const patient = myPatients.find((entry) => entry.bed === unit.id);
                return (
                  <li key={unit.id}>
                    <span className="status-dot is-info" aria-hidden="true" />
                    <span className="conflict-list-text">
                      <span className="conflict-list-title">{patient?.name}</span>
                      <span className="conflict-list-meta">
                        {unit.id} · {patient?.status}
                      </span>
                    </span>
                    <StatusBadge status={patient?.priority || 'Medium'} size="sm" />
                  </li>
                );
              })}
              {myWardUnits.length === 0 ? <li><p className="empty-line">No patients of mine in this ward</p></li> : null}
            </ul>
          </Panel>
        </div>
      </section>

      <DetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Bed ${selected.id}` : ''}
        subtitle={selected ? `${selected.ward} · ${selected.bedType}` : ''}
        badge={selected ? <StatusBadge status={selected.status} size="sm" /> : null}
      >
        {selected ? (
          <>
            <div className="stat-grid cols-2">
              <StatTile label="Patient" value={selected.patient || 'Unoccupied'} />
              <StatTile label="Held for" value={selected.heldFor || '—'} hint="Provisional hold" />
            </div>
            <div className="row row-tight">
              {selected.features.map((feature) => (
                <span className="badge badge-neutral text-xs" key={feature}>
                  {feature}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </DetailModal>
    </div>
  );
}
