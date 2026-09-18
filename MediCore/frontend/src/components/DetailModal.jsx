import Modal from './Modal';

/**
 * DetailModal — secondary information lives here, not on the page
 * (sections 3, 28, 31). Keeps operational lists scannable.
 */
export default function DetailModal({ open, onClose, title, subtitle, badge, size = 'md', footer, children }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size={size}
      footer={footer}
    >
      {badge ? <div className="modal-badges">{badge}</div> : null}
      <div className="stack">{children}</div>
    </Modal>
  );
}
