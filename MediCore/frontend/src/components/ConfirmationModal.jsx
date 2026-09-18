import { useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import Modal from './Modal';
import StatusBadge from './StatusBadge';

/**
 * Authorised-action confirmation.
 * Used for allocation confirmation, rejection and any action that changes
 * hospital resource state. Requires an explicit operator acknowledgement.
 */
export default function ConfirmationModal({
  open,
  title = 'Confirm action',
  subtitle,
  tone = 'primary',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
  summary,
  consequences = [],
  requireReason = false,
  reasonLabel = 'Reason',
  reasonPlaceholder = 'Record the operational reason for this decision',
  requireAcknowledgement = true,
  acknowledgementText = 'I am authorised to confirm this operational change.',
}) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    setReason('');
    setAcknowledged(false);
    setError('');
    onClose?.();
  };

  const confirm = () => {
    if (requireAcknowledgement && !acknowledged) {
      setError('Please acknowledge the confirmation statement before proceeding.');
      return;
    }
    if (requireReason && !reason.trim()) {
      setError('A reason is required for this action.');
      return;
    }
    onConfirm?.({ reason });
    close();
  };

  const confirmClass =
    tone === 'critical' ? 'btn btn-critical' : tone === 'success' ? 'btn btn-success' : 'btn btn-primary';

  return (
    <Modal
      open={open}
      title={title}
      subtitle={subtitle}
      onClose={close}
      labelledBy="confirm-modal-title"
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={close}>
            {cancelLabel}
          </button>
          <button type="button" className={confirmClass} onClick={confirm}>
            <ShieldCheck size={15} aria-hidden="true" />
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        {summary ? <div className="stack-sm">{summary}</div> : null}

        {consequences.length ? (
          <div className="stack-sm">
            <span className="uppercase-label">This action will</span>
            <ul className="rationale-list">
              {consequences.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {requireReason ? (
          <label className="field">
            <span className="field-label">{reasonLabel}</span>
            <textarea
              className="input"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={reasonPlaceholder}
            />
          </label>
        ) : null}

        {requireAcknowledgement ? (
          <label className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--primary-blue)' }}
            />
            <span className="text-small">{acknowledgementText}</span>
          </label>
        ) : null}

        {error ? (
          <div className="alert-banner is-critical" role="alert">
            <span className="alert-banner-icon text-alert">
              <AlertTriangle size={16} />
            </span>
            <div>
              <p className="alert-banner-title">Action not completed</p>
              <p className="alert-banner-text">{error}</p>
            </div>
          </div>
        ) : null}

        <div className="alert-banner is-operational">
          <span className="alert-banner-icon text-blue">
            <StatusBadge status="Operational" showIcon={false} />
          </span>
          <div>
            <p className="alert-banner-title">Clinical decisions stay with clinical staff</p>
            <p className="alert-banner-text">
              MediCore coordinates resources only. No patient treatment, transfer or discharge is executed by this
              action.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
