import { Filter, RotateCcw } from 'lucide-react';

/**
 * Filter bar built from a declarative filter config so every list page uses the
 * same control structure:
 *   filters = [{ id, label, value, options: [], onChange }]
 */
export default function FilterBar({
  filters = [],
  search,
  children,
  onReset,
  activeCount = 0,
  resultCount,
  resultLabel = 'results',
}) {
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <span className="badge badge-neutral" aria-hidden="true">
        <Filter size={12} />
        {activeCount > 0 ? `${activeCount} active` : 'Filters'}
      </span>

      {search}

      {filters.map((filter) => (
        <label key={filter.id} className="text-xs text-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="uppercase-label">{filter.label}</span>
          <select
            className="select"
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
            aria-label={filter.label}
          >
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      {children}

      <span className="spacer" />

      {typeof resultCount === 'number' ? (
        <span className="text-xs text-secondary" aria-live="polite">
          {resultCount} {resultLabel}
        </span>
      ) : null}

      {onReset && activeCount > 0 ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>
          <RotateCcw size={13} aria-hidden="true" />
          Reset
        </button>
      ) : null}
    </div>
  );
}
