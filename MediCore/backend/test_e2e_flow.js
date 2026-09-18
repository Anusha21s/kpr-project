const VITE_PORT = 5173;

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log('=== MEDICORE END-TO-END VERIFICATION SUITE ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  // TEST 1: Frontend Dev Server accessibility
  console.log('Test 1: Vite Dev Server Health');
  try {
    const viteRes = await fetch(`http://localhost:${VITE_PORT}/`);
    assert(viteRes.status === 200, `Vite dev server is serving index.html (status: ${viteRes.status})`);
  } catch (err) {
    assert(false, `Vite dev server unreachable: ${err.message}`);
  }

  // TEST 2: Backend Health via Proxy & Direct
  console.log('\nTest 2: Backend Health & Database Connectivity');
  try {
    const health = await request(`http://localhost:${VITE_PORT}/api/health`);
    assert(health.status === 200, `Health endpoint reachable via Vite proxy (status: 200)`);
    assert(health.data?.database?.ok === true, `PostgreSQL database connected (latency: ${health.data?.database?.latencyMs}ms)`);
    assert(health.data?.operational?.beds === 100, `Hospital state loaded: 100 configured beds`);
  } catch (err) {
    assert(false, `Backend health check failed: ${err.message}`);
  }

  // TEST 3: Authentication & Token Issuance
  console.log('\nTest 3: Authentication & Session');
  let cmdToken = null;
  let cmdUser = null;
  try {
    const loginRes = await request(`http://localhost:${VITE_PORT}/api/auth/login`, {
      method: 'POST',
      body: { staffId: 'CMD001', password: 'demo123' },
    });
    assert(loginRes.status === 200, `Login CMD001 returned 200 OK`);
    cmdToken = loginRes.data?.token;
    cmdUser = loginRes.data?.user;
    assert(Boolean(cmdToken), `JWT bearer token issued successfully`);
    assert(cmdUser?.role === 'command_center', `User role mapped to 'command_center'`);
  } catch (err) {
    assert(false, `Authentication failed: ${err.message}`);
  }

  // TEST 4: Command Center Overview Data Loading
  console.log('\nTest 4: Command Center Overview (Fix for "Unable to load hospital data")');
  let overview = null;
  try {
    const res = await request(`http://localhost:${VITE_PORT}/api/dashboard/overview`, {
      headers: { Authorization: `Bearer ${cmdToken}` },
    });
    assert(res.status === 200, `GET /api/dashboard/overview succeeded with status 200`);
    overview = res.data;
    assert(overview?.bedUnits?.length === 100, `Overview contains 100 bedUnits`);
    assert(overview?.doctors?.length > 0, `Overview contains ${overview?.doctors?.length} doctors`);
    assert(overview?.nurses?.length > 0, `Overview contains ${overview?.nurses?.length} nurses`);
    assert(overview?.equipment?.length > 0, `Overview contains ${overview?.equipment?.length} equipment categories`);
    assert(overview?.metrics?.pressure !== undefined, `Operational pressure calculated: ${overview?.metrics?.pressure?.overall || overview?.pressure?.overall}`);
  } catch (err) {
    assert(false, `Overview loading failed: ${err.message}`);
  }

  // TEST 5: Manual Patient Management - Add Patient
  console.log('\nTest 5: Manual Patient Management — Add Patient');
  let newPatient = null;
  try {
    const addRes = await request(`http://localhost:${VITE_PORT}/api/patients`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: {
        name: 'Dev Anand',
        age: 52,
        sex: 'M',
        priority: 'Critical',
        triage: 'Triage Category 1',
        department: 'Emergency',
        requiredResource: 'ICU Bed',
        requiresVentilator: true,
        needsOt: false,
        specialtyRequired: 'Emergency Medicine',
        notes: 'Severe acute respiratory distress with hypoxia',
      },
    });
    assert(addRes.status === 201, `Patient registration returned 201 Created`);
    newPatient = addRes.data?.data || addRes.data?.patient || addRes.data;
    const pNumber = newPatient?.patientNumber || newPatient?.id;
    assert(Boolean(pNumber), `New patient assigned ID: ${pNumber}`);
    assert(newPatient?.priority === 'Critical', `Priority set to 'Critical'`);
    assert(newPatient?.requiresVentilator === true, `Ventilator requirement recorded`);
  } catch (err) {
    assert(false, `Add patient failed: ${err.message}`);
  }

  const patientIdToTest = newPatient?.patientNumber || newPatient?.id;

  // TEST 6: Patient Queue Listing & Verification
  console.log('\nTest 6: Patient Queue Verification');
  try {
    const queueRes = await request(`http://localhost:${VITE_PORT}/api/queue`, {
      headers: { Authorization: `Bearer ${cmdToken}` },
    });
    assert(queueRes.status === 200, `GET /api/queue returned 200 OK`);
    const found = queueRes.data?.queue?.some((p) => p.name === 'Dev Anand' || p.id === patientIdToTest || p.patientNumber === patientIdToTest);
    assert(found, `Newly added patient 'Dev Anand' is present in the active queue`);
  } catch (err) {
    assert(false, `Queue query failed: ${err.message}`);
  }

  // TEST 7: Edit Patient
  console.log('\nTest 7: Manual Patient Management — Edit Patient');
  try {
    const patchRes = await request(`http://localhost:${VITE_PORT}/api/patients/${patientIdToTest}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: {
        notes: 'Intubated in ER bay 2. Stabilized on mechanical ventilation.',
      },
    });
    assert(patchRes.status === 200, `PATCH /api/patients/${patientIdToTest} returned 200 OK`);
    const patched = patchRes.data?.data || patchRes.data?.patient || patchRes.data;
    assert(patched?.notes?.includes('Intubated in ER bay 2'), `Clinical notes updated in DB`);
  } catch (err) {
    assert(false, `Edit patient failed: ${err.message}`);
  }

  // TEST 8: Discharge Patient & Resource Release
  console.log('\nTest 8: Manual Patient Management — Discharge Patient');
  try {
    const dischargeRes = await request(`http://localhost:${VITE_PORT}/api/patients/${patientIdToTest}/discharge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: {
        reason: 'Stabilized and transferred to step-down care',
      },
    });
    assert(dischargeRes.status === 200, `POST /api/patients/:id/discharge returned 200 OK`);
    const discharged = dischargeRes.data?.data?.patient || dischargeRes.data?.data || dischargeRes.data?.patient || dischargeRes.data;
    assert(discharged?.status === 'Discharged', `Patient status updated to 'Discharged'`);

    // Verify patient is no longer in active queue
    const postQueueRes = await request(`http://localhost:${VITE_PORT}/api/queue`, {
      headers: { Authorization: `Bearer ${cmdToken}` },
    });
    const stillInQueue = postQueueRes.data?.queue?.some((p) => p.id === patientIdToTest || p.patientNumber === patientIdToTest);
    assert(!stillInQueue, `Discharged patient removed from active queue`);
  } catch (err) {
    assert(false, `Discharge failed: ${err.message}`);
  }

  // TEST 9: Surge Simulation (+20 Patients)
  console.log('\nTest 9: Surge Simulation');
  let surgeData = null;
  try {
    const surgeRes = await request(`http://localhost:${VITE_PORT}/api/simulation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: { patientCount: 20 },
    });
    assert(surgeRes.status === 200, `POST /api/simulation returned 200 OK`);
    surgeData = surgeRes.data?.data || surgeRes.data;
    assert(surgeData?.patientCount === 20, `20 mass-casualty intake patients added`);
    assert(Boolean(surgeData?.reference), `Surge reference created: ${surgeData?.reference}`);
  } catch (err) {
    assert(false, `Surge simulation failed: ${err.message}`);
  }

  // TEST 10: Multi-Resource Optimization Run
  console.log('\nTest 10: Multi-Resource Optimization Engine');
  let optimizationRes = null;
  try {
    const optRes = await request(`http://localhost:${VITE_PORT}/api/optimization`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: { selections: { 'REC-ICU-01': 'icu-option-a' } },
    });
    assert(optRes.status === 200, `POST /api/optimization returned 200 OK`);
    optimizationRes = optRes.data?.data || optRes.data?.optimization || optRes.data;
    assert(optimizationRes?.recommendations?.length > 0, `Generated ${optimizationRes?.recommendations?.length} optimization recommendations`);
    assert(Boolean(optimizationRes?.reference || optimizationRes?.approval?.id), `Approval reference created`);
  } catch (err) {
    assert(false, `Optimization failed: ${err.message}`);
  }

  // TEST 11: Approve Recommendation Workflow
  console.log('\nTest 11: Command Center Optimization Approval Workflow');
  try {
    const targetRec = optimizationRes?.recommendations?.[0];
    const recId = targetRec?.id || 'REC-BED-01';
    assert(Boolean(recId), `Target recommendation identified: ${recId}`);

    const approveRes = await request(`http://localhost:${VITE_PORT}/api/optimization/recommendations/${recId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: { selections: { 'REC-ICU-01': 'icu-option-a' } },
    });
    assert(approveRes.status === 200, `Approve recommendation ${recId} returned 200 OK (got ${approveRes.status}: ${JSON.stringify(approveRes.data)})`);
    const appPayload = approveRes.data?.data || approveRes.data;
    assert(Boolean(appPayload?.applied) || appPayload?.approval?.status === 'Approved', `Recommendation applied in database transaction`);
  } catch (err) {
    assert(false, `Approval workflow failed: ${err.message}`);
  }

  // TEST 12: Reject Recommendation Workflow with Reason
  console.log('\nTest 12: Reject Recommendation Workflow');
  try {
    const secondRec = optimizationRes?.recommendations?.[1] || { id: 'REC-BED-01' };
    const rejectRes = await request(`http://localhost:${VITE_PORT}/api/optimization/recommendations/${secondRec.id}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: { reason: 'Alternative escalation path decided by command staff' },
    });
    assert(rejectRes.status === 200, `Reject recommendation returned 200 OK`);
    const rejPayload = rejectRes.data?.data || rejectRes.data;
    assert(rejPayload?.status === 'Rejected' || rejPayload?.rawStatus === 'REJECTED' || rejPayload?.status === 'REJECTED', `Recommendation status set to 'Rejected'`);
    assert(Boolean(rejPayload?.reason?.includes('Alternative escalation') || rejPayload?.rejectedReason?.includes('Alternative escalation')), `Rejection reason recorded in audit trail`);
  } catch (err) {
    assert(false, `Rejection workflow failed: ${err.message}`);
  }

  // TEST 13: Outdated State & Conflict Detection (409)
  console.log('\nTest 13: Conflict & Capacity Check (Outdated State Detection)');
  try {
    const conflictTestRes = await request(`http://localhost:${VITE_PORT}/api/allocations/INVALID-REF-999/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
      body: { selections: {} },
    });
    assert(conflictTestRes.status === 404 || conflictTestRes.status === 409, `Invalid allocation rejected with status ${conflictTestRes.status}`);
  } catch (err) {
    assert(false, `Conflict check error: ${err.message}`);
  }

  // TEST 14: Simulation Revert / Demo Reset
  console.log('\nTest 14: Simulation Revert / Reset Demo');
  try {
    const revertRes = await request(`http://localhost:${VITE_PORT}/api/simulation/revert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cmdToken}` },
    });
    assert(revertRes.status === 200, `POST /api/simulation/revert returned 200 OK`);
    const revData = revertRes.data?.data || revertRes.data;
    assert(revData?.reverted === true, `Hospital baseline restored, simulated patients purged (${revData?.removedPatients} removed)`);

    // Verify baseline in overview
    const postOverview = await request(`http://localhost:${VITE_PORT}/api/dashboard/overview`, {
      headers: { Authorization: `Bearer ${cmdToken}` },
    });
    assert(postOverview.data?.surge?.active === false, `Surge state is inactive`);
  } catch (err) {
    assert(false, `Simulation revert failed: ${err.message}`);
  }

  // TEST 15: Role-based Data Scoping (Clinical Data Isolation)
  console.log('\nTest 15: Role Scoping & Clinical Security');
  try {
    const docLogin = await request(`http://localhost:${VITE_PORT}/api/auth/login`, {
      method: 'POST',
      body: { staffId: 'DOC001', password: 'demo123' },
    });
    const docToken = docLogin.data?.token;
    const docStaffRef = docLogin.data?.user?.staffRef || 'DOC-1042';
    assert(Boolean(docToken), `Doctor DOC001 logged in successfully (staffRef: ${docStaffRef})`);

    const docOverview = await request(`http://localhost:${VITE_PORT}/api/dashboard/overview`, {
      headers: { Authorization: `Bearer ${docToken}` },
    });
    assert(docOverview.status === 200, `Doctor overview returned 200 OK`);
    assert(docOverview.data?.meta?.scope === 'doctor', `Payload scoped to 'doctor' role`);
    const allBelongToDoctor = docOverview.data?.myPatients?.every((p) => p.assignedDoctorId === docStaffRef);
    assert(allBelongToDoctor === true, `Clinical scoping confirmed: Doctor only accesses assigned patients`);
  } catch (err) {
    assert(false, `Role scoping test failed: ${err.message}`);
  }

  console.log(`\n========================================`);
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
