# Golden Hour

**Real-time emergency ambulance dispatch for Hyderabad.**

The *golden hour* is the window after a medical emergency in which rapid
treatment decides the outcome. This is a working dispatch system built around
shortening it: a caller presses one button, the system triages the call, finds
the nearest **clinically suitable** ambulance, offers it to that crew, routes
the vehicle over real roads, and keeps the patient, the crew, the receiving
hospital and the control room looking at the same live incident.

![Control room](docs/screenshots/control-room.png)

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [The four screens](#the-four-screens)
- [How dispatch works](#how-dispatch-works)
- [Architecture](#architecture)
- [Testing](#testing)
- [API](#api)
- [Security](#security)
- [Deployment](#deployment)
- [Known limits](#known-limits)

---

## What it does

```
Patient presses SOS
   -> triage assigns a priority (P1-P4) and a minimum vehicle capability
   -> nearest capable vehicle found by geospatial query
   -> offered to that crew, with a countdown
   -> no answer or declined? cascades to the next-best crew automatically
   -> accepted: live road route + ETA, streamed to everyone watching
   -> crew works the case: en route -> on scene -> transporting -> handover
   -> hospital notified, bed taken, response time recorded
```

**Triage, not a queue.** A cardiac call and a sprained ankle are not the same
emergency. A transparent rule table turns the reported emergency and condition
into a P1–P4 priority and a minimum vehicle tier. Reporting "not breathing"
escalates any call to P1 and requires a mobile ICU. Every decision is recorded
on the case in plain English, because dispatch decisions have to be explainable
afterwards.

**Coverage, not a depot.** 120 ambulances patrol a hexagonal grid across the
city rather than sitting at hospitals — a service parks where the people are,
because the point is being near the *next* emergency. From anywhere in the
service area the nearest ambulance averages **1.10 km** away.

**Dispatch that cannot double-book a vehicle.** Two SOS calls can arrive
milliseconds apart and rank the same ambulance first. Every claim on a vehicle
is a conditional `findOneAndUpdate` that checks and sets the status in one
atomic update. There is no read-then-write anywhere in the dispatcher.

**Real roads.** Routing goes through OSRM and falls back to a straight-line
estimate whenever routing is slow, disabled or down. A dispatch must never fail
because a third-party service is having a bad day.

**Accountable.** Every consequential action — who dispatched what, who
cancelled, who changed a bed count — is written to an append-only audit log, and
every case carries a full timeline.

---

## Quick start

Requires **Node.js 20.11+**. Nothing else — no database to install, no API keys.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev
```

Open <http://localhost:5173>. In a second terminal, bring the fleet to life:

```bash
npm run simulate
```

This signs in as the seeded crews and drives them for real — they accept
dispatches, follow road routes to the patient, and complete cases. It is an
ordinary API client with no special privileges, so anything it does, a real crew
device can do. Vehicles move at about 47 km/h, which is what an ambulance with
right of way averages through a city, so a case takes the minutes it would
really take. Add `-- --speed 8` to compress it for a demo.

### Demo accounts

All use the password `Password123`.

| Role | Email | What you see |
| --- | --- | --- |
| Patient | `patient@demo.test` | The SOS button and live ambulance tracking |
| Crew | `driver@demo.test` | Dispatch offers, navigation, case progression |
| Hospital | `hospital@demo.test` | Incoming patients and bed availability |
| Control room | `admin@demo.test` | Live fleet map, open cases, response metrics |

To see the whole system at once, open the patient and the control room in two
browser windows, run the simulator, and press SOS.

---

## The four screens

### Patient — raise an emergency

One button. Location comes from the browser, or you drop a pin if the browser
will not share it. Above the button, the service's own live record: cases
resolved, crews ready right now, average response time.

![Patient SOS](docs/screenshots/patient-sos.png)

### Patient — watch it arrive

The assigned vehicle, its crew, the receiving hospital, a live countdown and
the real road route. The ambulance moves every second and the ETA ticks down
between server updates.

![Live tracking](docs/screenshots/patient-tracking.png)

### Hospital — who is coming

Inbound patients with their ETA, presenting complaint, blood group and medical
notes, plus the bed counts the dispatcher reads when choosing a destination.

![Hospital board](docs/screenshots/hospital-board.png)

### On a phone

![Mobile](docs/screenshots/mobile-tracking.png)

---

## How dispatch works

Four stages, in [`dispatch.service.ts`](backend/src/services/dispatch.service.ts).

**1. Triage decides what is needed.** Before anything is searched,
[`triage.ts`](packages/shared/src/triage.ts) turns the reported emergency into a
priority and a **minimum vehicle tier**. This matters because "nearest" means
nothing until you know *nearest capable*.

**2. The database does the geometry.** Every ambulance stores its position as a
GeoJSON point with a `2dsphere` index. The search is one query:

```js
Ambulance.find({
  status: 'AVAILABLE',
  activeRequest: null,
  type: { $in: vehicleTypesMeeting(requiredType) },
  location: { $nearSphere: { $geometry: pickup, $maxDistance: 15000 } }
}).limit(3)
```

MongoDB walks the index outward from the patient and returns vehicles already
sorted nearest-first. This stays fast with 10 ambulances or 10,000 — it is an
index traversal, not a scan over the fleet.

Capability is part of the *filter*, not a check on the results. Filtering
afterwards meant nearer but unsuitable vehicles could crowd a suitable one out
of the fetched window, and a case was then refused with a capable ambulance
sitting inside the radius.

**3. Ranking, which is not purely distance.**

```
score = estimated travel seconds + (45 if over-specified)
```

Travel time dominates, because minutes to the patient is what matters
clinically. The penalty breaks ties *against* sending an over-qualified vehicle,
so an ICU unit is not dispatched to a case a basic ambulance can handle.

**4. Offer, do not assign.** The best crew is *offered* the case with a
25-second countdown. If they decline, or do not answer, the case cascades to the
next-best vehicle and the first returns to service. A case never stalls waiting
on a crew that is not looking at their screen.

### Coverage

```bash
npm run coverage
```

```
Nearest ambulance  average 1.10 km, worst case 2.53 km
Nearest ALS+       worst case 3.56 km
  Charminar        0.76 km to nearest    0.76 km to nearest ALS
  HITEC City       0.17 km to nearest    0.17 km to nearest ALS
  Secunderabad     1.22 km to nearest    1.22 km to nearest ALS
```

Grid spacing is derived from the coverage target rather than picked: for a 2 km
worst case a grid needs 2.83 km between vehicles, which over the served area is
10 × 12. Alternate rows are offset half a cell, so the packing is hexagonal —
better coverage for the same vehicle count. Two cells in three carry advanced
capability, because cardiac, stroke and trauma may not be sent a basic vehicle.

---

## Architecture

A TypeScript monorepo. React front end, Express + Socket.IO API, MongoDB.

```
golden-hour/
├── packages/shared/     Types, enums, Zod schemas, triage rules, socket contract
├── backend/             Express + Socket.IO + Mongoose API
│   └── src/
│       ├── config/      Environment validation, logging, database
│       ├── models/      Mongoose schemas with 2dsphere indexes
│       ├── services/    Dispatch, routing, tracking, triage, notifications
│       ├── controllers/ Request handling
│       ├── routes/      Endpoint definitions and role guards
│       ├── middleware/  Auth, validation, rate limiting, error handling
│       ├── sockets/     Authenticated realtime layer
│       └── scripts/     Fleet definition, seed, simulator, coverage report
└── frontend/            React 18 + Vite + Tailwind + Leaflet
    └── src/
        ├── pages/       One screen per role
        ├── components/  Map, timeline, shell, primitives
        ├── context/     Session and the shared socket
        └── lib/         API client, socket client, formatting
```

### The shared contract

`packages/shared` is the single source of truth. The same Zod schema validates a
form in the browser and the request body on the server. The same TypeScript
types describe a socket event on both ends. Change a payload and both sides stop
compiling — which is the point.

### Why these choices

| Decision | Reason |
| --- | --- |
| Zod schemas in a shared package | One definition means client and server can never disagree about what a valid request is |
| DTOs built by hand, never `res.json(doc)` | A password hash or an internal dispatch attempt cannot leak by accident |
| `2dsphere` indexes and `$nearSphere` | Nearest-ambulance is a database query, not an in-process scan |
| Atomic `findOneAndUpdate` claims | The only way two simultaneous emergencies cannot be sent the same vehicle |
| Positions batched in the control room | 120 vehicles reporting every second would otherwise mean 120 React renders per second |
| Leaflet + OpenStreetMap + OSRM | No API keys, no billing, real road geometry |

---

## Testing

```bash
npm test
```

64 tests. The integration tests deliberately do **not** mock the database — the
dispatcher's correctness lives in geospatial queries and conditional updates,
and a mock would happily return whatever the test expected while hiding a broken
`$nearSphere`.

Among the behaviours pinned down:

- the nearest **capable** vehicle is chosen, not simply the nearest
- a capable vehicle is found even when sixteen nearer unsuitable ones crowd the search
- an off-duty vehicle is never offered a case
- a declined or unanswered offer cascades to the next crew, and the first vehicle returns to service
- two simultaneous emergencies competing for one ambulance produce exactly one assignment
- a crew cannot skip a step, update a case that is not theirs, or sign off mid-case
- a patient cannot read another patient's case; a crew can read one offered to them
- cancelling frees whatever vehicle was holding the case
- arriving at hospital decrements exactly one bed
- service statistics carry no identifying detail

---

## API

All endpoints are under `/api`. Authenticated routes take `Authorization: Bearer <token>`.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/register` · `/auth/login` | — | Accounts |
| `GET` `PATCH` | `/auth/me` | any | Session and profile |
| `POST` | `/emergency` | patient | **Raise an SOS** |
| `GET` | `/emergency/active` · `/mine` · `/:id` | patient | Cases |
| `POST` | `/emergency/:id/cancel` · `/rate` | caller | Cancel, rate |
| `GET` | `/driver/shift` | crew | Vehicle and live case |
| `POST` | `/driver/duty` · `/offer` · `/status` · `/location` | crew | Work a case |
| `GET` | `/ambulances/nearby` · `/hospitals/nearby` | any | Proximity |
| `PATCH` | `/hospitals/:id/beds` | hospital | Bed availability |
| `GET` | `/stats/service` · `/stats/me` | any | Aggregate figures |
| `GET` | `/admin/stats` · `/requests/active` · `/audit` | admin | Control room |
| `GET` | `/health` · `/ready` | — | Liveness, readiness |

Errors always come back in the same envelope:

```json
{ "error": { "code": "CONFLICT", "message": "You already have an active emergency request" } }
```

Open [`requests.http`](requests.http) in VS Code with the REST Client extension
to try any of these without leaving the editor.

### Realtime events

Socket.IO, authenticated with the same JWT during the handshake. Clients are
placed only in the rooms their role entitles them to, so a patient's socket
cannot receive a fleet-wide broadcast.

| Event | Direction | Meaning |
| --- | --- | --- |
| `dispatch:offer` | → crew | A case is being offered, with a deadline |
| `request:updated` / `request:status` | → involved | The case changed |
| `request:eta` | → involved | New route and ETA |
| `ambulance:position` | → watchers | A vehicle moved |
| `fleet:snapshot` | → control room | The current fleet picture |
| `driver:location` | crew → | A GPS ping |

---

## Security

- **Passwords** hashed with bcrypt at cost 12, and the hash is `select: false`
  so it is never returned by an ordinary query.
- **Tokens** carry only an id and a role; the user is re-read on every request,
  so deactivating an account takes effect immediately.
- **Login** returns the same message for an unknown email and a wrong password,
  so it cannot be used to discover which addresses have accounts.
- **Registration** cannot create an admin or hospital account.
- **Every payload** is validated by a Zod schema before it reaches a handler,
  and the parsed result replaces the raw input.
- **Rate limits** are tight where abuse costs something: the SOS endpoint is
  limited per account, because a flood of fake emergencies ties up real vehicles.
- **Authorisation** is enforced on every request and every socket subscription.
  Route guards in the front end are a usability measure only.
- **Errors** never leak internals: anything that is not a deliberate `ApiError`
  is logged with its stack and reported as a generic 500.

---

## Deployment

Two free accounts: **MongoDB Atlas** for the database and **Render** for
everything else. [`render.yaml`](render.yaml) deploys the API and the web app
together, so there is one dashboard rather than two.

### 1. Atlas — the database

Sign up at [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas) and
create a free **M0** cluster in the **Mumbai (ap-south-1)** region. Every
dispatch decision is a round trip to this database, so distance costs
milliseconds on every call.

- **Database Access** → create a user, keep the password.
- **Network Access** → allow `0.0.0.0/0`. Render's free tier has no fixed
  outbound IP to allow-list.
- **Connect → Drivers** → copy the connection string.

Seed it from your own machine — Render's free tier has no shell:

```bash
MONGO_URI="mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/" npm run seed
```

This clears and recreates the hospitals, the 120-vehicle fleet and the demo
accounts, so run it at setup rather than after you have real data.

### 2. Render — the API and the web app

At [render.com](https://render.com): **New → Blueprint** → connect this
repository. Render reads `render.yaml` and creates both services.

Three values have to be set by hand, because two of them do not exist until the
first deploy finishes:

| Service | Variable | Value |
| --- | --- | --- |
| `golden-hour-api` | `MONGO_URI` | Your Atlas string from step 1 |
| `golden-hour-web` | `VITE_API_URL` | The API's URL, e.g. `https://golden-hour-api.onrender.com` |
| `golden-hour-api` | `CORS_ORIGINS` | The web app's URL, e.g. `https://golden-hour-web.onrender.com` |

Set `MONGO_URI` first and let both services deploy. Then fill in the other two
from the URLs Render shows you, and redeploy the web service — `VITE_API_URL`
is read at build time, so a restart is not enough.

Until `CORS_ORIGINS` is set, the sign-in screen reports
`Origin ... is not allowed`. That is the API refusing an unknown origin, which
is the security behaving correctly rather than a fault.

### Making the fleet move

A deployed site shows real data but stationary ambulances, because nothing is
driving them. Point the simulator at the deployed API from your own machine:

```bash
npm run simulate -- --api https://golden-hour-api.onrender.com
```

Vehicles move for as long as that command runs.

### What the free tiers cost you

- **Render free** spins a service down after 15 minutes idle, and the next
  request takes about 50 seconds to wake it. A cold link looks broken for a
  moment, so open it yourself before showing anyone.
- **Atlas M0** gives 512 MB, far more than this needs.
- **The public OSRM router** is rate-limited; the straight-line fallback covers
  it when it refuses.

See [`.env.example`](.env.example) for every setting.

Or run the whole thing locally with Docker:

```bash
docker compose up --build
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web together, both with hot reload |
| `npm run seed` | Reset to a known demo dataset |
| `npm run simulate` | Drive all 120 crews in real time |
| `npm run coverage` | Report how far the nearest ambulance is |
| `npm test` | The full test suite |
| `npm run typecheck` | Typecheck every workspace |
| `npm run build` | Production build of everything |

---

## Known limits

Worth stating plainly, since this is a demonstration system rather than a
deployed service:

- **Offer timeouts are in-process.** Running several API instances behind a load
  balancer needs a shared delayed queue (BullMQ/Redis). The two functions to
  change are marked in `dispatch.service.ts`.
- **No push notifications.** A crew must have the page open to hear an offer.
- **Addresses are not geocoded.** Coordinates come from the browser; there is no
  reverse-geocoding of a pickup point into a street address.
- **The public OSRM server** is rate-limited and unsuitable for real traffic.
- **Hospital capacity is a single bed count**, not per-department availability.

> In a real emergency, call your local emergency number. This is a
> demonstration system and is not connected to any emergency service.
