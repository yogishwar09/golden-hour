# Smart Emergency Ambulance Dispatch System

A real-time emergency dispatch platform. A caller raises an SOS; the system
triages it, finds the nearest **clinically suitable** ambulance, offers the case
to that crew, routes the vehicle over real roads, and keeps the patient, the
crew, the receiving hospital and the control room looking at the same live
incident.

Built as a TypeScript monorepo: React front end, Node/Express API, MongoDB,
Socket.IO.

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

---

## Quick start

Requires **Node.js 20.11+**. Nothing else — no database to install, no API keys.

```bash
npm install
npm run seed     # creates hospitals, a fleet and demo accounts
npm run dev      # API on :4000, web on :5173
```

The seed data covers **Hyderabad**: nine real hospitals from Osmania General and
Gandhi to NIMS, Apollo Jubilee Hills and AIG Gachibowli, and a fleet of 120
ambulances on patrol across the city.

The fleet is not parked at the hospitals. Vehicles sit on a hexagonal patrol
grid over the GHMC area, because a service parks where the people are, not
where the hospitals are -- the hospital is chosen after the patient is aboard.
The spacing is set so that from anywhere in the service area the nearest
ambulance is close:

```bash
npm run coverage     # measures it
```

> Nearest ambulance: average 1.10 km, worst case 2.53 km
> At Charminar 0.76 km, HITEC City 0.17 km, Secunderabad 1.22 km

Two cells in three carry advanced life support, because a cardiac, stroke or
trauma call may not be sent a basic vehicle -- so the distance that matters for
those is to a *suitable* ambulance, not merely a near one.

Map tiles are global OpenStreetMap, so serving a different city is a matter of
editing `COVERAGE` in `backend/src/scripts/fleet.ts`, the hospitals in
`seed.ts`, and the default centre in `frontend/src/components/MapView.tsx`.

Open <http://localhost:5173>.

In a third terminal, bring the fleet to life:

```bash
npm run simulate
```

This logs in as the seeded crews and drives them for real — they accept
dispatches, follow road routes to the patient, and complete cases. It is an
ordinary API client with no special privileges, so anything it does, a real
crew device can do.

Vehicles move at about 47 km/h, which is what an ambulance with right of way
averages through a city, so a case takes the minutes it would really take. Add
`-- --speed 8` when you are demonstrating it to someone and do not want to wait.

## Running it in VS Code

Open the **repository root** (not `backend/` or `frontend/` on their own — the
workspaces reference each other):

```bash
code ~/SmartAmbulance
```

VS Code will offer the recommended extensions on first open; accept, and you get
Tailwind autocomplete, Prettier on save, a Testing sidebar wired to Vitest, and
a MongoDB browser.

**To run everything:** press `Cmd+Shift+B` (`Ctrl+Shift+B` on Windows/Linux).
That is the default build task, `dev: API + web`. Or open the Command Palette →
*Tasks: Run Task* and pick one:

| Task | What it does |
| --- | --- |
| `dev: API + web` | Both servers with hot reload — the default build task |
| `seed the database` | Reset to the demo dataset |
| `run the fleet simulator` | Drive the seeded crews through real cases |
| `test` | The full suite |
| `typecheck` / `build everything` | Verify or produce a production build |

**To debug**, press `F5` and pick a configuration from the Run and Debug panel:

| Configuration | Use it for |
| --- | --- |
| `Debug API` | Breakpoints anywhere in the backend. Source maps mean you break in `.ts`, not compiled output |
| `Debug web (Chrome)` | Breakpoints in `.tsx`, with the browser console piped into VS Code. Start the web server first |
| `Debug full stack` | Both at once |
| `Debug the open test file` | Steps through whichever test file is focused |
| `Seed the database` / `Run the fleet simulator` | The scripts, under the debugger |

A good first breakpoint: `offerToCandidate` in
[`dispatch.service.ts`](backend/src/services/dispatch.service.ts) — press SOS in
the browser and watch the dispatcher pick a vehicle.

**To poke the API without leaving the editor**, open
[`requests.http`](requests.http) and click *Send Request* above any block (needs
the REST Client extension). Sign in first; the later requests reuse the token.

**To browse the data**, open the MongoDB panel in the sidebar and connect to
`mongodb://127.0.0.1:27017` — the collections are under `smart_ambulance`.

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

## What it actually does

**Triage, not a queue.** A cardiac call and a sprained ankle are not the same
emergency. `packages/shared/src/triage.ts` is a transparent rule table that
turns the reported emergency type and condition into a P1–P4 priority and a
minimum vehicle tier. Reporting "not breathing" escalates any call to P1 and
requires a mobile ICU. Every decision is recorded on the case in plain English,
because dispatch decisions have to be explainable afterwards.

**Dispatch that cannot double-book a vehicle.** Two SOS calls can arrive
milliseconds apart and rank the same ambulance first. Every claim on a vehicle
goes through a conditional `findOneAndUpdate` that checks and sets the status in
one atomic update — the loser of the race sees `null` and moves to its next
candidate. There is no read-then-write anywhere in the dispatcher.

**Offers, not assignments.** A crew is *offered* a case with a countdown. If
they decline, or do not answer within the window, the case cascades to the next
best vehicle and the first is returned to service. A case never silently
stalls waiting on a crew that is not looking at their screen.

**The right vehicle, not just the closest.** Candidates are ranked by travel
time, with a small penalty for being over-specified — so an ICU unit is not sent
to a case a basic vehicle can handle, keeping it free for one that needs it.

**Real roads.** Routing goes through OSRM, and falls back to a straight-line
estimate whenever routing is slow, disabled or down. A dispatch must never fail
because a third-party service is having a bad day; a slightly optimistic ETA
beats no ambulance.

**Live, at a sane rate.** Crew devices stream GPS over Socket.IO. Positions are
written and broadcast on every ping, but the route and ETA are recomputed only
once the vehicle has covered meaningful ground or enough time has passed —
otherwise a 200-vehicle fleet would mean hundreds of routing calls a second.

**Accountable.** Every consequential action — who dispatched what, who
cancelled, who changed a bed count — is written to an append-only audit log, and
every case carries a full timeline.

---

## Architecture

```
smart-ambulance/
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
│       └── scripts/     Seed and fleet simulator
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
| Zod schemas in a shared package | One definition means the client and server can never disagree about what a valid request is |
| DTOs built by hand, never `res.json(doc)` | A password hash or an internal dispatch attempt cannot leak by accident |
| `2dsphere` indexes and `$nearSphere` | Nearest-ambulance is a database query, not an in-process scan over the fleet |
| Atomic `findOneAndUpdate` claims | The only way two simultaneous emergencies cannot be sent the same vehicle |
| Offer timeouts in-process | Correct for one API instance; the two functions to change for a multi-instance deployment are marked in `dispatch.service.ts` |
| In-memory Mongo fallback | `npm run dev` works on a clean machine with nothing installed |
| Leaflet + OpenStreetMap + OSRM | No API keys, no billing, real road geometry. A Google Maps adapter is a drop-in replacement for `routing.service.ts` |

---

## Testing

```bash
npm test
```

51 tests covering the parts where a bug would actually hurt: the triage table,
the geometry, and — through the real HTTP API against a real MongoDB — the
dispatch lifecycle end to end.

The integration tests deliberately do **not** mock the database. The
dispatcher's correctness lives in geospatial queries and conditional updates,
and a mock would happily return whatever the test expected while hiding a broken
`$nearSphere`.

Among the behaviours pinned down:

- the nearest **capable** vehicle is chosen, not simply the nearest
- an off-duty vehicle is never offered a case
- a declined or unanswered offer cascades to the next crew, and the first vehicle returns to service
- two simultaneous emergencies competing for one ambulance produce exactly one assignment
- a crew cannot skip a step, update a case that is not theirs, or sign off mid-case
- a patient cannot read another patient's case; a crew can read one offered to them
- cancelling frees whatever vehicle was holding the case
- arriving at hospital decrements exactly one bed

---

## API

All endpoints are under `/api`. Authenticated routes take `Authorization: Bearer <token>`.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | — | Create a patient or crew account |
| `POST` | `/auth/login` | — | Sign in |
| `GET` | `/auth/me` | any | Current session |
| `PATCH` | `/auth/me` | any | Update profile |
| `POST` | `/emergency` | patient | **Raise an SOS** |
| `GET` | `/emergency/active` | patient | The caller's open case |
| `GET` | `/emergency/mine` | patient | Case history |
| `GET` | `/emergency/:id` | involved | One case |
| `POST` | `/emergency/:id/cancel` | caller, admin | Cancel |
| `POST` | `/emergency/:id/rate` | caller | Rate a closed case |
| `GET` | `/driver/shift` | crew | Vehicle and live case |
| `POST` | `/driver/duty` | crew | Go on or off duty |
| `POST` | `/driver/offer` | crew | Accept or decline an offer |
| `POST` | `/driver/status` | crew | Advance the case |
| `POST` | `/driver/location` | crew | Position (REST fallback for the socket) |
| `GET` | `/ambulances/nearby` | any | Vehicles near a point |
| `GET` | `/hospitals` · `/hospitals/nearby` | any | Hospitals |
| `PATCH` | `/hospitals/:id/beds` | hospital, admin | Update bed availability |
| `GET` | `/admin/stats` · `/timeseries` | admin, hospital | Control-room figures |
| `GET` | `/admin/requests/active` | admin, hospital | Live case board |
| `GET` | `/admin/users` · `/audit` | admin | Administration |
| `GET` | `/health` · `/ready` | — | Liveness and readiness |

Errors always come back in the same envelope:

```json
{ "error": { "code": "CONFLICT", "message": "You already have an active emergency request" } }
```

### Realtime events

Socket.IO, authenticated with the same JWT during the handshake. Clients are
placed only in the rooms their role entitles them to, so a patient's socket
cannot receive a fleet-wide broadcast.

| Event | Direction | Meaning |
| --- | --- | --- |
| `dispatch:offer` | → crew | A case is being offered, with a deadline |
| `dispatch:offer_revoked` | → crew | The offer expired or the case went elsewhere |
| `request:updated` / `request:status` | → involved | The case changed |
| `request:eta` | → involved | New route and ETA |
| `ambulance:position` | → watchers | A vehicle moved |
| `fleet:snapshot` | → control room | The current fleet picture |
| `notification` | → user | A message for this person |
| `driver:location` | crew → | A GPS ping |
| `request:subscribe` | client → | Follow a case (authorisation is checked) |

---

## Security

- **Passwords** hashed with bcrypt at cost 12, and the hash is `select: false`
  so it is never returned by an ordinary query.
- **Tokens** carry only an id and a role; the user is re-read on every request,
  so deactivating an account takes effect immediately rather than whenever the
  token expires.
- **Login** returns the same message for an unknown email and a wrong password,
  so the endpoint cannot be used to discover which addresses have accounts.
- **Registration** cannot create an admin or hospital account; those are
  provisioned by an existing admin.
- **Every payload** is validated by a Zod schema before it reaches a handler,
  and the parsed result replaces the raw input — a handler can never see a field
  the schema did not allow.
- **Rate limits** are tight where abuse costs something: the SOS endpoint is
  limited per account, not per IP, because a flood of fake emergencies ties up
  real vehicles.
- **Authorisation** is enforced on every request and on every socket
  subscription. Route guards in the front end are a usability measure only.
- **Errors** never leak internals: anything that is not a deliberate `ApiError`
  is logged with its stack and reported as a generic 500.

---

## Deployment

The default local stack needs no external services. For a real deployment:

**1. Database.** Create a free MongoDB Atlas cluster, allow your server's IP,
and set `MONGO_URI`. Choose a region near your users — for Hyderabad, Atlas's
Mumbai region keeps dispatch queries fast.

**2. API.** `render.yaml` deploys it to Render as-is. Set `MONGO_URI` and
`CORS_ORIGINS` in the dashboard; `JWT_SECRET` is generated for you. The service
refuses to start in production with the development secret or without a
database, by design.

**3. Front end.** `frontend/vercel.json` deploys it to Vercel. Set
`VITE_API_URL` to your API's origin.

**4. Routing (recommended).** The public OSRM server is rate-limited and offers
no uptime guarantee. Run [your own](https://github.com/Project-OSRM/osrm-backend)
and point `OSRM_BASE_URL` at it.

Or run the whole thing with Docker:

```bash
docker compose up --build
docker compose run --rm api npm run seed --workspace @sas/backend
```

See `.env.example` for every setting.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web together, both with hot reload |
| `npm run seed` | Reset to a known demo dataset |
| `npm run simulate` | Drive all 120 crews in real time (`-- --speed 8` to compress it for a demo) |
| `npm run coverage` | Report how far the nearest ambulance is, across the service area |
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
  Production would add web push or FCM.
- **Addresses are not geocoded.** Coordinates come from the browser; there is no
  reverse-geocoding of a pickup point into a street address.
- **The public OSRM server** is rate-limited and unsuitable for real traffic.
- **Hospital capacity is a single bed count**, not per-department or
  per-specialty availability.

> In a real emergency, call your local emergency number. This is a demonstration
> system and is not connected to any emergency service.
