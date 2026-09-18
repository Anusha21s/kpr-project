# MediCore — backend

Stateful Node.js + Express + PostgreSQL backend for the MediCore hospital
operations platform, with an optional Python ML layer (HE-02) for demand, surge,
workload and optimisation forecasting.

The backend owns the hospital's operational state. Every number the dashboards
show — occupancy, utilisation, queue length, staff availability, theatre load,
pressure band — is computed from database rows on each request. Nothing is
hardcoded, and there is no second source of truth.

```
MediCore/
  frontend/   React + Vite app (unchanged; talks to this API)
  backend/    this service  ── Node/Express/Prisma/Socket.IO
                            └─ ai/  Python FastAPI model service (optional)
```

---

## 1. Requirements

| Component | Version used |
|---|---|
| Node.js | 20.x |
| PostgreSQL | 17 |
| Python (AI layer only) | 3.13 |

## 2. Install

```bash
# backend
cd backend
npm install
cp .env.example .env         # then set DATABASE_URL and JWT_SECRET

# AI layer (optional — the backend runs without it, see §7)
python3 -m pip install -r ai/requirements.txt
```

## 3. Database

```bash
# create the role and database (once)
sudo -u postgres psql -c "CREATE ROLE medicore LOGIN PASSWORD 'medicore_dev_pw';"
sudo -u postgres psql -c "CREATE DATABASE medicore OWNER medicore;"

# apply migrations
npx prisma migrate deploy     # or: npm run migrate  (development)
npx prisma generate
```

## 4. Seed

```bash
npm run seed
```

The seed rebuilds a believable hospital from scratch — it first clears whatever a
previous demo left behind (applied allocations, optimizer runs, simulated intake,
arrival history) so the same state can be recreated at any time:

| | |
|---|---|
| Beds | 100 (10 ICU · 60 general · 10 emergency + 2 escalation · 20 maternity) |
| Theatres | OT-01 … OT-04 with today's schedule |
| Doctors / nurses | 30 / 72 with duty status, availability and shift blocks |
| Equipment | 7 categories, 15 ventilators, 45 monitors, plus OT equipment |
| Emergency resources | ambulances, monitored bays, resus bays, emergency theatre |
| Patients | 12 inpatients, 8 in the emergency queue (P025 is the critical multi-resource case) |
| Arrivals | 24 h of registration history (~10.5/hour) so demand features have a real flow to read |
| Alerts, notifications, tasks | operational, with severities CRITICAL / HIGH / OPERATIONAL / INFO |

### Demo accounts (password `demo123`)

The role is decided by the account — the sign-in form never asks for one.

| Staff ID | Role | Person |
|---|---|---|
| `CMD001` | `command_center` | Command Staff |
| `RES001` | `resource_coordinator` | Resource Coordinator |
| `DOC001` | `doctor` | Dr. Kumar — Cardiology |
| `NUR001` | `nurse` | Nurse Priya — ICU |

`DOC002`, `NUR002` … exist for the cross-role and leakage checks.
Override the password with `SEED_PASSWORD` before seeding.

## 5. Run

```bash
npm run dev      # nodemon, http://localhost:4000
npm start        # plain node
```

* `GET /` — live operational status page (read from the database)
* `GET /api` — service metadata
* `GET /api/health` — health probe (database, socket, AI layer)

### Frontend

```bash
cd ../frontend
npm install
cp .env.example .env     # VITE_API_BASE_URL=http://localhost:4000/api
npm run dev              # http://localhost:5173
```

`VITE_API_BASE_URL` must include the `/api` prefix; `VITE_SOCKET_URL` is the
backend origin. The frontend works in two modes: pointing straight at the
backend (the default above) or same-origin with the Vite dev server proxying
`/api` and `/socket.io` to port 4000 (see `frontend/.env.example`). CORS on this
side stays limited to the origins in `FRONTEND_URL` / `SOCKET_CORS_ORIGIN` —
never `*`.

## 6. Test

```bash
npm test              # isolated medicore_test database + 80 tests
npm run test:api      # HTTP flow check against a running server
npm run sweep         # 169-call contract sweep across every route and role
npm run db:test       # prepare the test database only
npm run ai:demo       # end-to-end demo rehearsal (login → surge → approve → sockets → My Patients)
```

`npm test` prepares `medicore_test` itself, so the development database is never
touched. `npm run sweep` and `npm run ai:demo` mutate live state — run
`npm run seed` afterwards to return to the seeded demo picture.

## 7. AI layer (HE-02)

A separate Python service holds the trained models; Node never imports Python.

```bash
npm run ai            # FastAPI on http://127.0.0.1:5001
npm run ai:demo       # rehearse the whole demo path
```

* **Models** — 25 registered XGBoost / scikit-learn artifacts (demand, resource
  utilisation, doctor/nurse workload, equipment demand, patient flow, pressure
  classification, surge anomaly detection) plus an OR-Tools CP-SAT optimizer.
* **Provenance on every number** — each prediction reports `source`
  (`model` / `fallback`), the model name and version, the feature version, and a
  `fallback_reason` when a rule-based answer was used instead. The model registry
  is exposed at `GET /api/ai/models` for the command centre.
* **Trained on synthetic data** — every response carries the
  `synthetic_training_data` flag and the disclaimer, so a prediction is never
  mistaken for observed hospital activity.
* **Degrades, never breaks** — if the AI service is unreachable, the client
  trips a circuit breaker (3 failures / 15 s) and the AI endpoints answer from
  the hospital's own deterministic metrics with `available: false`. The
  dashboards keep working and the demo data layer never overrides valid backend
  data.
* **Decision support only** — the optimization plan rides the existing
  recommendation → approval → transaction workflow. Nothing is applied until the
  resource coordinator approves it, and the plan never cancels surgery,
  discharges a patient, forces an ICU move or overrides a clinician.

### AI endpoints

| Method | Path | Roles |
|---|---|---|
| GET | `/api/ai/health` | any authenticated |
| GET | `/api/ai/models` | command centre |
| POST | `/api/ai/demand/forecast` | any authenticated |
| POST | `/api/ai/resources/forecast` | any authenticated |
| POST | `/api/ai/surge/detect` | any authenticated |
| POST | `/api/ai/pressure/predict` | any authenticated |
| POST | `/api/ai/doctor-workload/predict` | operational + clinical |
| POST | `/api/ai/nurse-workload/predict` | operational + clinical |
| POST | `/api/ai/equipment-demand/predict` | any authenticated |
| POST | `/api/ai/patient-flow/predict` | any authenticated |
| POST | `/api/ai/advisory` | command centre, coordinator |
| POST | `/api/ai/simulate` | command centre, coordinator |
| GET | `/api/ai/runs`, `/api/ai/runs/:reference`, `/api/ai/predictions` | command centre, coordinator |

`GET /api/dashboard/overview` carries an `ai` block served from a short-lived
cache, so the dashboards never wait on the model service.

### AI socket events

The nine operational events are unchanged (`bed:updated`, `doctor:availability`,
`nurse:availability`, `equipment:updated`, `queue:updated`, `surge:detected`,
`optimization:completed`, `allocation:updated`, `alert:created`). The AI layer
publishes additively under its own namespace — `ai:prediction_updated`,
`ai:surge_detected`, `ai:resource_pressure_changed`, `ai:recommendation_created`,
`ai:optimization_completed`, `ai:allocation_approved`,
`ai:resource_conflict_detected` — to the command-centre and coordinator rooms.
Clinical rooms receive only the events that concern their own work; per-doctor
patient detail is never broadcast.

### Retraining

```bash
python3 -m ai.training.train_all       # gate-checked; only this promotes models
python3 -m ai.evaluation.<report>      # evaluation reports
```

Model training, registry promotion and report writing are covered in
`ai/README.md`.

## 8. Configuration

Every variable lives in `.env` (see `.env.example`).

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (4000) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | token signing (8 h shifts) |
| `FRONTEND_URL`, `SOCKET_CORS_ORIGIN` | allowed origins — never `*` |
| `AI_SERVICE_ENABLED`, `AI_SERVICE_URL` | AI layer switch and address |
| `AI_SERVICE_TIMEOUT_MS`, `AI_SERVICE_ADVISORY_TIMEOUT_MS` | request budgets (8 s / 20 s) |

## 9. Safety rules the code enforces

* Roles come from the authenticated account; a doctor or nurse can only ever
  load their own patients, server-side.
* Duty status (`ON_DUTY` / `OFF_DUTY` / `LEAVE` / `UNAVAILABLE`) is respected by
  the optimizer — an off-duty clinician is never scheduled.
* Availability checks never block emergency treatment.
* Surge simulation projects a picture; live rows change only after a coordinator
  approves a plan.
* Allocation confirmation runs in one transaction with row locking
  (`FOR UPDATE SKIP LOCKED`) and rolls back completely on any failure — no
  partial allocations, race-safe on a contended resource such as `ICU-05`. A
  patient already in a bed is skipped with a reason instead of being moved.
* Audit log for every key action (never secrets); passwords are bcrypt hashes;
  validation failures return 400 with `{success:false,error:{code,message}}` and
  production responses never include stack traces.
