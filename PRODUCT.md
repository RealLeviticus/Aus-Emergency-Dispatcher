# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are flight-sim pilots in Microsoft Flight Simulator 2024 and X-Plane who
want structured purpose during free flight — typically flying helicopters or light
aircraft, and often connected to VATSIM.

Two operating identities:

- **Civilian emergency response** ("Aus Emergency Dispatcher" / AED): open to any pilot.
  Air-ambulance, search-and-rescue, police-air and firebombing-style tasking.
- **RAAFv military tasking** ("RAAFv Tasking Dispatcher"): restricted. Available only to
  members of the RAAFv organisation and — because operations run on VATSIM — only to
  pilots who hold current VSOA approval to conduct military operations.

One operator per install today. A shared dispatch board (multiple pilots working one
live job queue, with a dispatcher role) is a planned future mode the design must leave
room for.

## Product Purpose

The app runs alongside the simulator and issues emergency calls and tasking jobs in real
time. The pilot sees an incoming job, accepts or passes it, flies to the scene and works
the task; the app follows the mission automatically. It exists to turn open-ended sim
sessions into a stream of meaningful, location-aware missions with no human dispatcher.

Success: a pilot launches the app, gets a credible job near their aircraft within
moments, and flies the whole accept → en route → on scene → complete loop with the app
keeping score — no manual bookkeeping.

## Positioning

Jobs are generated from and verified against live simulator state. The app connects to
MSFS 2024 via SimConnect and to X-Plane via its data feed, places tasks relative to the
aircraft's actual position and phase of flight, and detects arrival, on-scene and
completion from telemetry rather than self-reporting. Access to military tasking is tied
to real RAAFv / VSOA authorisation on VATSIM, not a menu toggle.

## Operating Context

- Runs as a desktop companion on a second monitor or beside the sim window while the
  pilot is also flying and, often, connected to VATSIM.
- Read in short glances during high-workload phases (departure, approach, hover) —
  content must be scannable at arm's length.
- MSFS 2024 (SimConnect) and X-Plane (UDP / data feed) are the two live data sources.
- VATSIM is the network operations occur on; RAAFv is the virtual air force
  organisation; VSOA is the VATSIM authority that approves military operations.
- Shell and splash must stay usable with no network; sim-dependent and network-dependent
  features fail quietly and show status.

## Capabilities and Constraints

- Desktop app: Electron + Next.js (Nextron), TypeScript, Tailwind, FlyonUI. Dark
  operational aesthetic inherited from the `hub` project.
- Startup profile (emergency vs military) is chosen in settings and stored locally;
  profile-specific branding lives in shared splash configuration, not page markup.
- Mission lifecycle, driven by sim telemetry: incoming → accepted / declined → en route →
  on scene → in progress → complete / failed.
- The military profile is entitlement-gated (RAAFv membership + current VSOA approval).
  The UI needs an honest locked / unavailable state and a route to approval, not just a
  hidden option.
- Planned, not in this build: shared / online dispatch board with a dispatcher role and a
  networked job queue.
- Current build is an early UI draft — a splash and a placeholder standby home exist; the
  dispatcher console itself is not built.
- Offline-first shell; no remote fonts or assets without a local fallback.

## Brand Commitments

- Names in use: "Aus Emergency Dispatcher" (AED) and "RAAFv Tasking Dispatcher" (RAAFv).
- Australian emergency-services cue: an alternating red/blue beacon treatment on the
  splash. _[inferred from the existing implementation — confirm whether this is binding]_
- Tone: quiet, operational, deliberate — a professional dispatch tool, not a game HUD.
  _[inferred from the existing design.md — confirm]_
- `design.md` (read as DESIGN.md) is the current visual authority and points to the `hub`
  repo.

## Evidence on Hand

- Existing code: splash (`renderer/pages/index.tsx`), standby home
  (`renderer/pages/home.tsx`), settings with the profile switch
  (`renderer/pages/settings.tsx`), slide-out shell (`renderer/components/Layout.tsx`),
  main-process IPC stubs including `getSystemStatus` (`main/background.ts`).
- `design.md` design brief.
- No real job data, mission dataset, user accounts, RAAFv / VSOA integration, or
  SimConnect / X-Plane code exists yet — future work must not fabricate these.
- No real-world emergency-service branding, logos or partnerships are claimed.

## Product Principles

1. **The sim is the source of truth.** Jobs are placed and judged by live telemetry; the
   pilot should rarely have to tell the app what happened.
2. **Glanceable under load.** The operator is flying. Status, next action and urgency
   must read in one look — density without clutter.
3. **Two worlds, one tool.** Civilian and military tasking are first-class profiles that
   share structure and interaction; the difference is identity and access, not a
   different app.
4. **Access reflects reality.** Military tasking maps to real RAAFv / VSOA authorisation,
   and the app represents that gate honestly.
5. **Offline-honest.** The shell always works; anything depending on the sim, VATSIM or a
   server degrades quietly with a clear status.

## Accessibility & Inclusion

- Honour `prefers-reduced-motion`: the beacon / strobe treatment must have a static
  fallback.
- Content must stay legible at a glance and at distance during flight; hold contrast on
  dark operational surfaces.
