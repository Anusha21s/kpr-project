import EmptyState from './EmptyState';

/**
 * DataTable
 *
 * Renders a semantic table on desktop and the same rows as stacked cards on
 * small screens (each cell carries a `data-label` so the mobile view keeps its
 * context). Pass `mobileCard` to customise the mobile representation.
 */
export default function DataTable({
  columns,
  rows,
  getRowKey,
  emptyTitle = 'Nothing to display',
  emptyText,
  emptyAction,
  mobileCard,
  caption,
  compact = false,
  onRowClick,
}) {
  const hasRows = rows && rows.length > 0;

  if (!hasRows) {
    return (
      <EmptyState
        title={emptyTitle}
        text={emptyText}
        action={emptyAction}
      />
    );
  }

  return (
    <div className="table-host">
      <div className="table-wrap">
        <table className="data-table">
          {caption ? <caption className="text-xs text-secondary" style={{ padding: '8px 14px', textAlign: 'left' }}>{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" style={column.width ? { width: column.width } : undefined} className={column.align === 'right' ? 'text-right' : ''}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={getRowKey ? getRowKey(row, index) : index}
                className={`${compact ? 'is-compact' : ''} ${onRowClick ? 'is-clickable' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                role={onRowClick ? 'button' : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.align === 'right' ? 'cell-actions' : column.strong ? 'cell-strong' : ''}>
                    {column.render ? column.render(row, index) : row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-cards">
        {rows.map((row, index) => (
          <div key={`card-${getRowKey ? getRowKey(row, index) : index}`} className="queue-card">
            {mobileCard ? (
              mobileCard(row, index)
            ) : (
              <dl className="stack-sm" style={{ margin: 0 }}>
                {columns.map((column) => (
                  <div key={column.key} className="kv">
                    <dt className="kv-key">{column.header}</dt>
                    <dd className="kv-value" style={{ margin: 0 }}>
                      {column.render ? column.render(row, index) : row[column.key]}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
