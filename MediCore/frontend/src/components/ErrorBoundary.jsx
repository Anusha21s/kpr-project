import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

/** Keeps a component error from blanking the command center. */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Operational prototype: surface the failure in the console for the dev team.
    // eslint-disable-next-line no-console
    console.error('MediCore view error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <section className="card">
            <div className="card-body stack">
              <div className="alert-banner is-critical" role="alert">
                <span className="alert-banner-icon text-alert">
                  <AlertTriangle size={17} />
                </span>
                <div>
                  <p className="alert-banner-title">This view could not be rendered</p>
                  <p className="alert-banner-text">
                    The rest of MediCore is unaffected. Reload the view or reset the demonstration data.
                  </p>
                </div>
              </div>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  Reload view
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    this.setState({ error: null });
                    window.location.href = '/';
                  }}
                >
                  Return to dashboard
                </button>
              </div>
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}
