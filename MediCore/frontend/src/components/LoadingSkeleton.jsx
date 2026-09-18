/**
 * LoadingSkeleton — clean skeletons instead of blank screens (section 35).
 * Variants map onto the layout that is about to render.
 */
export default function LoadingSkeleton({ variant = 'cards', rows = 4, label = 'Loading hospital data' }) {
  const items = Array.from({ length: rows });

  if (variant === 'table') {
    return (
      <div className="skeleton-block" role="status" aria-live="polite" aria-label={label}>
        <span className="sr-only">{label}</span>
        <div className="skeleton-line is-head" />
        {items.map((_, index) => (
          <div className="skeleton-line" key={index} />
        ))}
      </div>
    );
  }

  if (variant === 'panel') {
    return (
      <div className="skeleton-block" role="status" aria-live="polite" aria-label={label}>
        <span className="sr-only">{label}</span>
        <div className="skeleton-line is-title" />
        {items.map((_, index) => (
          <div className="skeleton-line" key={index} style={{ width: `${92 - index * 9}%` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="skeleton-grid" role="status" aria-live="polite" aria-label={label}>
      <span className="sr-only">{label}</span>
      {items.map((_, index) => (
        <div className="skeleton-card" key={index}>
          <div className="skeleton-line is-title" />
          <div className="skeleton-line is-value" />
          <div className="skeleton-line" style={{ width: '60%' }} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }) {
  return (
    <div className="skeleton-block" role="status" aria-live="polite">
      <span className="sr-only">Loading rows</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div className="skeleton-line" key={index} />
      ))}
    </div>
  );
}
