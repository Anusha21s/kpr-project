import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

/**
 * Panel — the standard content block after refinement (section 30).
 *
 * One panel = one operational concept: a title, an optional context line, an
 * optional "open dedicated page" affordance and the content itself. Secondary
 * information belongs in a modal, not in the panel.
 */
export default function Panel({ title, subtitle, icon: Icon, actions, linkTo, linkLabel, children, footer, compact, tone }) {
  return (
    <section className={`panel ${compact ? 'is-compact' : ''} ${tone ? `panel--${tone}` : ''}`}>
      {title || actions ? (
        <header className="panel-head">
          <div style={{ minWidth: 0 }}>
            {title ? (
              <h3 className="panel-title">
                {Icon ? <Icon size={15} className="panel-icon" aria-hidden="true" /> : null}
                {title}
              </h3>
            ) : null}
            {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
          </div>
          <div className="row row-tight">
            {actions}
            {linkTo ? (
              <Link className="panel-link" to={linkTo}>
                {linkLabel || 'Open'}
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        </header>
      ) : null}

      <div className="panel-body">{children}</div>
      {footer ? <div className="panel-foot">{footer}</div> : null}
    </section>
  );
}
