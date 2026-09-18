import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Header from '../components/Header';
import Footer from '../components/Footer';
import LoadingSkeleton from '../components/LoadingSkeleton';
import DataErrorState from '../components/DataErrorState';
import { useHospitalData } from '../hooks/useHospitalData';

/**
 * Shared application shell used by all three dashboards:
 *   sidebar (collapsible / mobile drawer) | header | page content | footer
 *
 * The shell also owns the data lifecycle surface for sections 35–36: pages are
 * never blank while the operational snapshot is being read, and if the hospital
 * data service cannot answer, staff see one short message with a retry — never a
 * raw backend error.
 */
export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const { isLoading, hasError, refresh } = useHospitalData({ key: 'overview' });

  // Restore the desktop sidebar preference and close the drawer on navigation.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem('medicore.sidebar') === 'collapsed');
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [pathname]);

  const toggleCollapse = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem('medicore.sidebar', next ? 'collapsed' : 'expanded');
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  return (
    <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} />

      {drawerOpen ? (
        <>
          <button type="button" className="sidebar-drawer-backdrop" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />
          <Sidebar variant="drawer" collapsed={false} onClose={() => setDrawerOpen(false)} />
        </>
      ) : null}

      <div className="app-main">
        <Header onOpenDrawer={() => setDrawerOpen(true)} />
        <main className="app-content" id="main-content">
          {hasError ? (
            <DataErrorState
              compact
              text="Live updates are paused. Screens keep the last known operational picture."
              onRetry={refresh}
            />
          ) : null}
          {isLoading ? <LoadingSkeleton variant="cards" rows={6} /> : <Outlet />}
        </main>
        <Footer />
      </div>
    </div>
  );
}
