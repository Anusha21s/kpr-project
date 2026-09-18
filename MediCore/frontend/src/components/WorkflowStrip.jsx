import { WORKFLOW_STAGES } from '../data/emergencyResources';

/**
 * Operational workflow (section 47) — compact form.
 *
 * Six short stages; the current one is highlighted. Detail text was removed so
 * the strip reads at a glance instead of explaining the product in prose.
 */
const STAGE_MAP = {
  visibility: ['arrival', 'assessment', 'requirement', 'visibility'],
  analysis: ['arrival', 'assessment', 'requirement', 'visibility', 'analysis'],
  recommendation: ['arrival', 'assessment', 'requirement', 'visibility', 'analysis', 'recommendation'],
  confirmed: WORKFLOW_STAGES.map((stage) => stage.id),
};

export default function WorkflowStrip({ stage = 'visibility', title = 'Operational workflow', standalone = true }) {
  const activeIds = STAGE_MAP[stage] || STAGE_MAP.visibility;
  const activeIndex = activeIds.length - 1;

  const content = (
    <ol className="workflow" aria-label={title}>
      {WORKFLOW_STAGES.map((item, index) => {
        const state = index < activeIndex ? 'is-done' : index === activeIndex ? 'is-current' : '';
        return (
          <li className={`workflow-step ${state}`} key={item.id} aria-current={index === activeIndex ? 'step' : undefined}>
            <span className="workflow-index" aria-hidden="true">
              {index < activeIndex ? '✓' : index + 1}
            </span>
            <span className="workflow-label">{item.label}</span>
          </li>
        );
      })}
    </ol>
  );

  if (!standalone) return content;

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h3 className="panel-title">{title}</h3>
          <p className="panel-subtitle">Clinical staff own the decisions — MediCore supports coordination</p>
        </div>
      </header>
      <div className="panel-body">{content}</div>
    </section>
  );
}
