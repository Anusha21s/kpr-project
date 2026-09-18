import { Search, X } from 'lucide-react';

/** Reusable labelled search input. */
export default function SearchBar({
  value,
  onChange,
  placeholder = 'Search…',
  label = 'Search',
  id = 'search-input',
  onClear,
  compact = false,
}) {
  return (
    <div className="search-bar" style={compact ? { maxWidth: 220 } : undefined}>
      <label className="sr-only" htmlFor={id} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {label}
      </label>
      <Search size={15} className="search-bar-icon" aria-hidden="true" />
      <input
        id={id}
        className="search-input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        aria-label={label}
      />
      {value && onClear ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ position: 'absolute', right: 4 }}
          onClick={onClear}
          aria-label="Clear search"
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}
