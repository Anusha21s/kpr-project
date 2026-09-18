import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './layouts/AppLayout';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuth } from './hooks/useAuth';
import { ROLE_HOME } from './data/hospitalData';

import Login from './pages/Login';
import NotFound from './pages/NotFound';

// Command Center
import CommandOverview from './pages/command/CommandOverview';
import PatientQueue from './pages/command/PatientQueue';
import BedCapacity from './pages/command/BedCapacity';
import DoctorsPage from './pages/command/DoctorsPage';
import NursesPage from './pages/command/NursesPage';
import EmergencyResources from './pages/command/EmergencyResources';
import EquipmentPage from './pages/command/EquipmentPage';
import SurgeSimulation from './pages/command/SurgeSimulation';
import ResourceOptimization from './pages/command/ResourceOptimization';
import AlertsPage from './pages/command/AlertsPage';

// Clinical Staff
import ClinicalOverview from './pages/clinical/ClinicalOverview';
import MyPatients from './pages/clinical/MyPatients';
import EmergencyCases from './pages/clinical/EmergencyCases';
import OtSchedule from './pages/clinical/OtSchedule';
import IcuWard from './pages/clinical/IcuWard';
import MyDuty from './pages/clinical/MyDuty';
import ClinicalNotifications from './pages/clinical/ClinicalNotifications';

// Resource Coordinator
import ResourceOverview from './pages/resources/ResourceOverview';
import BedAllocation from './pages/resources/BedAllocation';
import IcuAllocation from './pages/resources/IcuAllocation';
import OtScheduling from './pages/resources/OtScheduling';
import DoctorAllocation from './pages/resources/DoctorAllocation';
import NurseAllocation from './pages/resources/NurseAllocation';
import EquipmentAllocation from './pages/resources/EquipmentAllocation';
import ResourceConflicts from './pages/resources/ResourceConflicts';
import PendingApprovals from './pages/resources/PendingApprovals';

/** Sends each signed-in role to its own dashboard. */
function RoleRedirect() {
  const { user, isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Navigate to={ROLE_HOME[user.role] || '/login'} replace />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* ------------------------------------------------ Command Center */}
        <Route
          path="/command"
          element={
            <ProtectedRoute allowedRoles={['command_center']}>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<CommandOverview />} />
          <Route path="queue" element={<PatientQueue />} />
          <Route path="beds" element={<BedCapacity />} />
          <Route path="doctors" element={<DoctorsPage />} />
          <Route path="nurses" element={<NursesPage />} />
          <Route path="emergency-resources" element={<EmergencyResources />} />
          <Route path="equipment" element={<EquipmentPage />} />
          <Route path="surge" element={<SurgeSimulation />} />
          <Route path="optimization" element={<ResourceOptimization />} />
          <Route path="alerts" element={<AlertsPage />} />
        </Route>

        {/* ------------------------------------------------ Clinical Staff */}
        <Route
          path="/clinical"
          element={
            <ProtectedRoute allowedRoles={['doctor', 'nurse']}>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<ClinicalOverview />} />
          <Route path="patients" element={<MyPatients />} />
          <Route path="emergency" element={<EmergencyCases />} />
          <Route path="ot" element={<OtSchedule />} />
          <Route path="icu" element={<IcuWard />} />
          <Route path="duty" element={<MyDuty />} />
          {/* Merged into My Duty (v2): tasks are duty responsibilities. */}
          <Route path="tasks" element={<Navigate to="/clinical/duty" replace />} />
          <Route path="notifications" element={<ClinicalNotifications />} />
        </Route>

        {/* ------------------------------------------------ Resource Management */}
        <Route
          path="/resources"
          element={
            <ProtectedRoute allowedRoles={['resource_coordinator']}>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<ResourceOverview />} />
          <Route path="beds" element={<BedAllocation />} />
          <Route path="icu" element={<IcuAllocation />} />
          <Route path="ot" element={<OtScheduling />} />
          <Route path="doctors" element={<DoctorAllocation />} />
          <Route path="nurses" element={<NurseAllocation />} />
          <Route path="equipment" element={<EquipmentAllocation />} />
          <Route path="conflicts" element={<ResourceConflicts />} />
          <Route path="approvals" element={<PendingApprovals />} />
        </Route>

        <Route path="/" element={<RoleRedirect />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBoundary>
  );
}
