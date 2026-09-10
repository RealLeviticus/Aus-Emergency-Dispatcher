import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { SplashProfileId } from '../config/splash';
import {
  formatEta,
  formatLatLon,
  rangeBearing,
  sim,
  useSimStatus,
  useSyncPeers,
  useSyncStatus,
  type GpsStatus,
  type PeerPresence,
  type SimStatus,
} from '../lib/sim';
import { classifyAircraft, type Airport, type Call, type Hospital, type Priority } from '../lib/jobgen';
import { jobs as jobsApi, useJobs, type AirTarget, type Channel, type JobPhase, type ServerJob } from '../lib/jobs';
import { useAccount } from '../lib/account';
import { isMuted, playAccept, playComplete, playNewCall, playPriorityCall, primeAudio, setMuted } from '../lib/audio';
import { MenuBar } from './MenuBar';
import { AccountBadge } from './AccountBadge';
import { ScenePacksDialog } from './ScenePacksDialog';
import { UpdateBanner, UpdateDialog } from './UpdateDialog';
const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-[#404040]">Loading map…</div>,
});

export type { Call, Hospital, Priority };

// Every job runs base → scene → (hospital if a patient) → base.
type Phase = 'enroute' | 'onscene' | 'transport' | 'athospital' | 'returning';
const PHASE_ORDER: Phase[] = ['enroute', 'onscene', 'transport', 'athospital', 'returning'];

const PHASE_PCT: Record<Phase, number> = {
  enroute: 20,
  onscene: 45,
  transport: 60,
  athospital: 75,
  returning: 92,
};
const PHASE_LABEL: Record<Phase, string> = {
  enroute: 'En route to scene',
  onscene: 'On scene',
  transport: 'Transporting patient',
  athospital: 'At hospital — handover',
  returning: 'Returning to base',
};

type Base = { name: string; lat: number; lon: number };
type ActiveMission = {
  jobId: string;
  call: Call;
  base: Base;
  agency: string;
  phase: Phase;
  acceptedAt: number;
  /** ms timestamp the current phase began — drives the auto timers */
  phaseSince: number;
  /** seconds to spend on scene (patient load / task work) before departing */
  onSceneSec: number;
  /** seconds at the hospital (handover / unload) before returning */
  atHospitalSec: number;
  /** true for airborne tasks (intercept/CAP/patrol) — no "landed" check for arrival */
  airborne: boolean;
  /** RAAFv intercept/AAR/escort: the AI aircraft(s) + route to spawn via FSLTL */
  targets?: AirTarget[];
};

/** Airborne-only tasks: arrival is "near the point", not "landed and slow". */
const AIRBORNE_KIND =
  /intercept|patrol|\bCAP\b|orbit|refuel|reconnaiss|recce|shadow|escort|containment|search|survey|mapping|surveillance/i;

/** Next-step button label; depends on whether the job has a patient transport leg. */
function phaseAction(phase: Phase, hasTransport: boolean): string {
  switch (phase) {
    case 'enroute':
      return 'Mark On Scene';
    case 'onscene':
      return hasTransport ? 'Patient Loaded — Depart' : 'Task Complete — Return to Base';
    case 'transport':
      return 'Arrived Hospital';
    case 'athospital':
      return 'Handover Done — Return to Base';
    case 'returning':
      return 'Arrived Base — Close Job';
  }
}

type ShiftLog = { cleared: number; avgResponseSec: number };

const SHIFT_EMPTY: ShiftLog = { cleared: 0, avgResponseSec: 0 };

const PRIORITY_SQUARE: Record<Priority, string> = { P1: '#e00000', P2: '#808000', P3: '#000080' };

function dur(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
function heading(deg: number): string {
  return `${Math.round(deg).toString().padStart(3, '0')}°`;
}
function receivedClock(offsetSec: number): string {
  const d = new Date(Date.now() - offsetSec * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Win9x-style vertical divider for toolbars / status rows. */
function Sep() {
  return <span className="mx-1 h-5 w-[2px] shrink-0" style={{ background: '#808080', boxShadow: '1px 0 0 #fff' }} />;
}

export function PriBadge({ priority }: { priority: Priority }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono font-bold">
      <span className="inline-block h-2.5 w-2.5" style={{ background: PRIORITY_SQUARE[priority] }} aria-hidden="true" />
      {priority}
    </span>
  );
}

function KeyRow({ label, value, wide = 92 }: { label: string; value: ReactNode; wide?: number }) {
  return (
    <div className="flex items-baseline gap-2 py-[3px]">
      <span className="shrink-0 text-right text-[#404040]" style={{ width: wide }}>
        {label}
      </span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

function GroupBox({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <fieldset className={`win-group ${className}`}>
      <div className="legend font-bold">{title}</div>
      {children}
    </fieldset>
  );
}

function SunkenField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-[3px] text-[11px] uppercase tracking-wide text-[#404040]">{label}</div>
      <div className="win-sunken px-2 py-1 font-mono text-[15px] font-bold">{value}</div>
    </div>
  );
}

/** A position is only usable once the sim actually reports one — reject null,
 *  non-finite, out-of-range, and the "null island" (0,0) the sim briefly emits. */
function validFix(p: SimStatus['position']): p is NonNullable<SimStatus['position']> {
  if (!p) return false;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return false;
  if (Math.abs(p.lat) < 0.02 && Math.abs(p.lon) < 0.02) return false;
  return true;
}

/** Adapt a server job to the `Call` shape the detail / tracking UI expects. */
function jobToCall(j: ServerJob): Call {
  return {
    id: j.id.slice(0, 8).toUpperCase(),
    lat: j.lat,
    lon: j.lon,
    kind: j.kind,
    category: j.category,
    place: j.place,
    latLon: j.latLon,
    sector: `${j.region} · ${j.aircraftClass === 'rotary' ? 'Rotary' : 'Fixed wing'}`,
    brief: j.brief,
    detail: j.detail,
    source: j.source,
    informant: j.informant,
    hazards: j.hazards,
    persons: j.persons,
    access: j.access,
    lz: j.lz,
    units: j.units,
    nearestAsset: `${j.agency} — dispatched from base`,
    weather: j.weather,
    priority: j.priority,
    bearing: 0,
    distanceNm: 0,
    receivedOffsetSec: Math.max(0, Math.round((Date.now() - j.createdAt) / 1000)),
    transportTo: j.transportTo,
  };
}

// The military profile is the RAAFv board (its own job channel, intercept tasking).
export default function DispatchConsole(props: { profileId: SplashProfileId; demo?: string }) {
  const channel: Channel = props.profileId === 'military' ? 'raafv' : 'emergency';
  const isRaafv = channel === 'raafv';
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveMission | null>(null);
  const [log, setLog] = useState<ShiftLog>(SHIFT_EMPTY);
  const [note, setNote] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const bootRef = useRef(Date.now());
  const claimIdsRef = useRef<Set<string>>(new Set());

  const account = useAccount();
  const myName = account.current?.name ?? 'Operator';

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    primeAudio();
  }, []);

  const secondsSinceBoot = Math.floor((Date.now() - bootRef.current) / 1000);
  const elapsed = active ? Math.floor((Date.now() - active.acceptedAt) / 1000) : 0;

  const simStatus = useSimStatus();
  const syncStatus = useSyncStatus();
  const peers = useSyncPeers();
  const [simBusy, setSimBusy] = useState(false);
  const [simNote, setSimNote] = useState<string | null>(null);
  const [scenePacksOpen, setScenePacksOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [objPreset, setObjPreset] = useState('windsock');
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [sceneCatalog, setSceneCatalog] = useState<{ id: string; label: string }[]>([]);
  const [testSceneId, setTestSceneId] = useState('mva');
  const [trail, setTrail] = useState<{ lat: number; lon: number }[]>([]);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus | null>(null);
  const [airports, setAirports] = useState<Airport[]>([]);
  const [muted, setMutedState] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => setMutedState(isMuted()), []);
  useEffect(() => {
    Promise.resolve(window.ipc?.invoke?.('getAppVersion'))
      .then((v) => typeof v === 'string' && setVersion(v))
      .catch(() => undefined);
  }, []);

  const hasFix = validFix(simStatus.position);
  const fix = hasFix ? simStatus.position : null;
  // Loading the sim IS going on duty — there's no separate toggle any more.
  const onDuty = simStatus.connected && hasFix;

  // --- shared job pool -------------------------------------------------
  const pool = useJobs((j) => {
    if (active) return; // on a job — don't chirp about new tasking
    if (j.priority === 'P1') playPriorityCall();
    else playNewCall();
  }, channel);
  const isMine = useCallback(
    (j: ServerJob) =>
      claimIdsRef.current.has(j.id) ||
      (j.status !== 'available' && (j.claimedByName === myName || (j.party ?? []).some((p) => p.name === myName))),
    [myName],
  );
  const available = useMemo(
    () => pool.filter((j) => j.status === 'available').sort((a, b) => a.createdAt - b.createdAt),
    [pool],
  );
  const myJob = useMemo(
    () => pool.find((j) => (j.status === 'claimed' || j.status === 'active') && isMine(j)) ?? null,
    [pool, isMine],
  );
  const othersActive = useMemo(
    () => pool.filter((j) => (j.status === 'claimed' || j.status === 'active') && !isMine(j)),
    [pool, isMine],
  );

  const claim = useCallback((j: ServerJob) => {
    claimIdsRef.current.add(j.id);
    void jobsApi.claim(j.id);
    setSelectedJobId(j.id);
    setDetailJobId(null);
    playAccept();
    setNote(`Claimed ${j.kind} — ${j.place}. Start Job to launch from base.`);
  }, []);

  const releaseJob = useCallback((j: ServerJob) => {
    claimIdsRef.current.delete(j.id);
    void jobsApi.release(j.id);
    setNote(`Left ${j.kind}.`);
  }, []);

  const joinJob = useCallback((j: ServerJob) => {
    claimIdsRef.current.add(j.id);
    void jobsApi.join(j.id);
    setSelectedJobId(j.id);
    setDetailJobId(null);
    playAccept();
    setNote(`Joined ${j.kind} — ${j.place}. ${j.claimedByName ?? 'Lead'} has the lead. Set a base and Start Job.`);
  }, []);

  // --- operating base -------------------------------------------------
  const [base, setBase] = useState<Base | null>(null);
  const [baseSel, setBaseSel] = useState('');

  // Airfields nearest the aircraft, for the base picker.
  const baseOptions = useMemo(() => {
    if (!fix) return [] as Airport[];
    return [...airports]
      .sort(
        (a, b) => (a.lat - fix.lat) ** 2 + (a.lon - fix.lon) ** 2 - ((b.lat - fix.lat) ** 2 + (b.lon - fix.lon) ** 2),
      )
      .slice(0, 12);
  }, [airports, fix]);

  // Pre-select the nearest field once we have a fix; drop the base if the sim goes.
  useEffect(() => {
    if (!hasFix) {
      setBase(null);
      setBaseSel('');
    } else if (!baseSel && baseOptions[0]) {
      setBaseSel(baseOptions[0].ident);
    }
  }, [hasFix, baseSel, baseOptions]);

  const setBaseTo = useCallback(
    (b: Base) => {
      setBase(b);
      void jobsApi.locate(b.lat, b.lon, channel); // bias new server jobs toward this base
      setNote(`Base set to ${b.name} — the ${isRaafv ? 'RAAFv tasking' : 'job'} board is live.`);
    },
    [channel, isRaafv],
  );

  const confirmBase = useCallback(
    (manualIdent?: string) => {
      if (!fix) return;
      const wantIdent = (manualIdent ?? baseSel).trim().toUpperCase();
      if (!wantIdent || wantIdent === '__POS__') {
        setBaseTo({ name: 'Present position', lat: fix.lat, lon: fix.lon });
        return;
      }
      const ap = airports.find((a) => a.ident.toUpperCase() === wantIdent);
      if (ap) setBaseTo({ name: ap.ident, lat: ap.lat, lon: ap.lon });
      else if (manualIdent)
        // Not in the facility list yet — anchor it to the current position but keep the name.
        setBaseTo({ name: wantIdent, lat: fix.lat, lon: fix.lon });
      else setBaseTo({ name: 'Present position', lat: fix.lat, lon: fix.lon });
    },
    [fix, baseSel, airports, setBaseTo],
  );

  const boardReady = hasFix && Boolean(base);

  const startJob = useCallback(
    (j: ServerJob) => {
      if (!base) {
        setNote('Set an operating base first.');
        return;
      }
      claimIdsRef.current.add(j.id);
      void jobsApi.start(j.id);
      const c = jobToCall(j);
      setActive({
        jobId: j.id,
        call: c,
        base,
        agency: j.agency,
        phase: 'enroute',
        acceptedAt: Date.now(),
        phaseSince: Date.now(),
        onSceneSec: 45 + Math.floor(Math.random() * 70),
        atHospitalSec: 40 + Math.floor(Math.random() * 45),
        airborne: Boolean(j.targets?.length) || AIRBORNE_KIND.test(j.kind),
        targets: j.targets,
      });
      setDetailJobId(null);
      setSelectedJobId(null);
      playAccept();
    },
    [base],
  );

  const completeMission = useCallback((cur: ActiveMission) => {
    void jobsApi.complete(cur.jobId);
    // Take the wreckage away with the job — otherwise every cleared call left
    // its ~22 objects in the sim for the rest of the session.
    void sim.clearScene(cur.jobId);
    sceneDoneRef.current = null;
    claimIdsRef.current.delete(cur.jobId);
    const responseSec = Math.floor((Date.now() - cur.acceptedAt) / 1000);
    setLog((prev) => ({
      cleared: prev.cleared + 1,
      avgResponseSec: Math.round((prev.avgResponseSec * prev.cleared + responseSec) / (prev.cleared + 1)),
    }));
    playComplete();
  }, []);

  // Manual override — force the next stage (the flow is otherwise automatic).
  const advance = useCallback(() => {
    setActive((cur) => {
      if (!cur) return cur;
      const hasT = Boolean(cur.call.transportTo);
      let next: Phase | null;
      if (cur.phase === 'enroute') next = 'onscene';
      else if (cur.phase === 'onscene') next = hasT ? 'transport' : 'returning';
      else if (cur.phase === 'transport') next = 'athospital';
      else if (cur.phase === 'athospital') next = 'returning';
      else next = null; // returning -> done

      if (next) {
        void jobsApi.progress(cur.jobId, next as JobPhase);
        return { ...cur, phase: next, phaseSince: Date.now() };
      }
      completeMission(cur);
      return null;
    });
  }, [completeMission]);

  const abandon = useCallback(() => {
    setActive((cur) => {
      if (cur) {
        claimIdsRef.current.delete(cur.jobId);
        void jobsApi.release(cur.jobId);
        void sim.clearScene(cur.jobId);
        sceneDoneRef.current = null;
      }
      return null;
    });
  }, []);

  useEffect(() => {
    Promise.resolve(sim.objectPresets())
      .then((p) => Array.isArray(p) && setPresets(p))
      .catch(() => undefined);
    Promise.resolve(sim.sceneList())
      .then((s) => Array.isArray(s) && s.length && (setSceneCatalog(s), setTestSceneId(s[0]!.id)))
      .catch(() => undefined);
  }, []);

  // Keep the local list of real airfields fresh while connected.
  useEffect(() => {
    if (!simStatus.connected) {
      setAirports([]);
      return;
    }
    let alive = true;
    const tick = () =>
      Promise.resolve(sim.getAirports())
        .then((a) => alive && Array.isArray(a) && setAirports(a as Airport[]))
        .catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [simStatus.connected]);

  // Poll the PMS50 GTN750 state while a job is active (for the GPS panel).
  useEffect(() => {
    if (!active) {
      setGpsStatus(null);
      return;
    }
    let alive = true;
    const tick = () =>
      Promise.resolve(sim.gpsGetStatus())
        .then((s) => alive && s && setGpsStatus(s))
        .catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [active]);

  // Full-flight breadcrumb. Keeps the whole sortie (not a rolling window): a
  // point is added only when the aircraft has moved ~15 m, so an hour of flight
  // is a few thousand points. It survives a brief SimConnect reconnect and is
  // only reset on a big position jump (new flight / teleport) or on Start Job.
  const posAt = fix?.at;
  useEffect(() => {
    if (!fix) return;
    setTrail((t) => {
      const last = t[t.length - 1];
      if (!last) return [{ lat: fix.lat, lon: fix.lon }];
      const dNm = rangeBearing(last, { lat: fix.lat, lon: fix.lon }).rangeNm;
      if (dNm > 30) return [{ lat: fix.lat, lon: fix.lon }]; // teleport / reloaded flight
      if (dNm < 0.008) return t; // < ~15 m — ignore
      const next = [...t, { lat: fix.lat, lon: fix.lon }];
      // Hard safety cap; thin the oldest half if we ever get there (very long session).
      if (next.length > 12000) return next.filter((_, i) => i % 2 === 0 || i > next.length - 2000);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posAt]);
  // Clear the trail if the sim link stays down for a while (a genuine session end,
  // not a brief SimConnect reconnect).
  useEffect(() => {
    if (simStatus.connected) return;
    const id = window.setTimeout(() => setTrail((t) => (t.length ? [] : t)), 30_000);
    return () => window.clearTimeout(id);
  }, [simStatus.connected]);

  const canInject = simStatus.connected && hasFix;
  const aircraftClass = classifyAircraft(fix?.engineType, fix?.aircraftTitle, fix?.atcModel || fix?.atcType);

  // --- fully automatic mission flow -----------------------------------
  // Fresh sim status for the interval below (avoids a stale closure).
  const simRef = useRef(simStatus);
  simRef.current = simStatus;
  const spawnedForRef = useRef<string | null>(null); // jobId we've auto-spawned the target/scene for
  const sceneDoneRef = useRef<string | null>(null); // jobId we've placed the ground scene for
  // Am I the lead of my current call? (lead / solo places the scene; others mirror.)
  const leadRef = useRef(true);
  leadRef.current = !myJob || !myJob.party?.length || myJob.party[0]?.name === myName || myJob.claimedByName === myName;

  // Auto-spawn: the moment a job is active + the sim is up, put what it needs in
  // the world. Intercept targets spawn now (they hold); ground scenes spawn when
  // you get within ~12 NM so they're there on arrival.
  useEffect(() => {
    if (!active || !simStatus.connected) return;
    if (active.targets?.length && spawnedForRef.current !== active.jobId) {
      spawnedForRef.current = active.jobId;
      for (const t of active.targets) {
        void sim.injectAirContact({
          route: t.route,
          loop: t.loop,
          titleHint: t.titleHint,
          formation: t.formation,
          holdUntilNm: t.holdUntilNm,
          label: t.label,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.jobId, simStatus.connected]);

  useEffect(() => {
    if (!active || !simStatus.connected || !hasFix) return;
    const tick = () => {
      const status = simRef.current;
      const p = status.position;
      if (!p) return;
      const now = Date.now();
      const rng = (t: { lat: number; lon: number }) => rangeBearing({ lat: p.lat, lon: p.lon }, t).rangeNm;

      setActive((cur) => {
        if (!cur) return cur;
        const scene = { lat: cur.call.lat, lon: cur.call.lon };
        const hosp = cur.call.transportTo ?? null;
        const home = { lat: cur.base.lat, lon: cur.base.lon };
        const hasT = Boolean(hosp);
        const since = (now - cur.phaseSince) / 1000;
        const settled = cur.airborne ? true : p.onGround || p.altitudeAglFt < 900 || p.groundSpeedKt < 45;
        const arrRadius = cur.airborne ? 6 : 1.6;

        // Place the ground scene once, when closing on it. Only the lead unit
        // places it (others mirror it via the session); seeded by the job id so
        // every unit sees the same layout.
        if (!cur.airborne && leadRef.current && sceneDoneRef.current !== cur.jobId && rng(scene) < 12) {
          sceneDoneRef.current = cur.jobId;
          void sim.injectScene({
            sceneId: 'auto',
            lat: cur.call.lat,
            lon: cur.call.lon,
            headingSeed: cur.jobId, // orientation follows the job, not the crew
            sceneKey: cur.jobId, // so it can be torn down when the job clears
            kind: cur.call.kind,
            category: cur.call.category,
            seed: cur.jobId,
          });
        }

        let next: Phase | null = cur.phase;
        if (cur.phase === 'enroute' && rng(scene) < arrRadius && settled && since > 6) next = 'onscene';
        else if (cur.phase === 'onscene' && since > cur.onSceneSec) next = hasT ? 'transport' : 'returning';
        else if (cur.phase === 'transport' && hosp && rng(hosp) < 1.3 && settled && since > 6) next = 'athospital';
        else if (cur.phase === 'athospital' && since > cur.atHospitalSec) next = 'returning';
        else if (cur.phase === 'returning' && rng(home) < 2 && settled && since > 6) next = null;

        if (next === cur.phase) return cur;
        if (next === null) {
          completeMission(cur);
          return null;
        }
        void jobsApi.progress(cur.jobId, next as JobPhase);
        if (next === 'onscene') playAccept();
        else if (next === 'returning') playAccept();
        return { ...cur, phase: next, phaseSince: now };
      });
    };
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.jobId, simStatus.connected, hasFix]);

  // Multi-crew: follow the shared call — catch up if another member advanced the
  // phase, and close out if a member completed or the call was dropped.
  useEffect(() => {
    if (!active) return;
    const j = pool.find((x) => x.id === active.jobId);
    if (!j) return;
    if (j.status === 'complete') {
      setActive((cur) => {
        if (cur) {
          claimIdsRef.current.delete(cur.jobId);
          playComplete();
          setNote('Call closed by another crew member.');
        }
        return null;
      });
      return;
    }
    const jp = (j.phase ?? null) as Phase | null;
    if (jp && PHASE_ORDER.indexOf(jp) > PHASE_ORDER.indexOf(active.phase)) {
      setActive((cur) => (cur ? { ...cur, phase: jp, phaseSince: Date.now() } : cur));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, active?.jobId, active?.phase]);

  const toggleMute = useCallback(() => {
    setMutedState((m) => {
      setMuted(!m);
      return !m;
    });
  }, []);

  // Share a sync session while on an active job so injected objects line up for
  // every unit; report presence + phase.
  useEffect(() => {
    sim.setSession(active ? `job:${active.jobId}` : 'standby');
    sim.setPresenceContext({
      phase: active ? active.phase : 'idle',
      jobId: active?.jobId ?? '',
      jobKind: active?.call.kind ?? '',
      jobLat: active?.call.lat ?? 0,
      jobLon: active?.call.lon ?? 0,
      jobPlace: active?.call.place ?? '',
      agency: active?.agency ?? '',
    });
  }, [active]);

  const injectTest = useCallback(async () => {
    setSimBusy(true);
    setSimNote(null);
    const res = await sim.injectTest({ preset: objPreset });
    setSimBusy(false);
    if (!res) setSimNote('SimConnect bridge unavailable.');
    else if (res.ok)
      setSimNote(
        res.shared
          ? `Placed "${res.object?.title ?? 'object'}" and shared it to session "${res.session}". Green tick below = the sim confirmed it.`
          : `Placed "${res.object?.title ?? 'object'}" locally — NOT shared: the sync server is unreachable.`,
      );
    else setSimNote(res.error ?? 'Injection failed.');
  }, [objPreset]);

  const dropSceneAhead = useCallback(async () => {
    setSimBusy(true);
    setSimNote(null);
    const res = await sim.injectSceneAhead({ sceneId: testSceneId, distanceMeters: 45 });
    setSimBusy(false);
    if (!res) setSimNote('SimConnect bridge unavailable.');
    else if (res.ok)
      setSimNote(
        `Dropped ${res.objects?.length ?? 0} object(s) ~45 m ahead on the ground. Check the ✓/✗ list below for what each resolved to — a ✗ or a windsock means that title isn't a spawnable dynamic SimObject here.`,
      );
    else setSimNote(res.error ?? 'Scene drop failed.');
  }, [testSceneId]);

  // Surface the sim's own rejection (e.g. unknown object) and per-object confirmation.
  const injectFeedback =
    simStatus.injected.length > 0
      ? simStatus.injected
          .map((o) =>
            o.error
              ? `✗ ${o.title}: ${o.error}`
              : o.objectId != null
                ? `✓ ${o.title} (sim id ${o.objectId})`
                : `… ${o.title} pending`,
          )
          .join('   ')
      : null;

  const clearInjected = useCallback(async () => {
    setSimBusy(true);
    const res = await sim.clearInjected();
    setSimBusy(false);
    setSimNote(res ? `Removed ${res.removed ?? 0} injected object(s).` : 'SimConnect bridge unavailable.');
  }, []);

  const detailJob = pool.find((j) => j.id === detailJobId) ?? null;
  const detailCall = detailJob ? jobToCall(detailJob) : null;
  const canClaimDetail = detailJob?.status === 'available';
  const statusText = active
    ? `On task — ${active.call.kind} · ${PHASE_LABEL[active.phase]}`
    : myJob
      ? `Job claimed — ${myJob.kind}. Start Job to launch.`
      : boardReady
        ? `${base?.name} — ${available.length} job(s) available`
        : hasFix
          ? 'Select an operating base to see the job board'
          : simStatus.connected
            ? 'Simulator connected — waiting for a position fix'
            : 'Waiting for a simulator connection';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MenuBar
        menus={[
          {
            label: 'File',
            items: [
              account.current
                ? { label: `Sign out (${account.current.name})`, onClick: () => void account.signOut() }
                : { label: 'Sign in…', disabled: true },
              { label: 'Open data folder', onClick: () => void window.ipc?.invoke?.('app:openDataFolder') },
              'separator',
              { label: 'Exit', onClick: () => window.ipc?.send?.('windowControl', 'close') },
            ],
          },
          {
            label: 'View',
            items: [
              { label: 'Mute alert sounds', checked: muted, onClick: toggleMute },
              { label: 'Reload console', onClick: () => void window.ipc?.invoke?.('window:reload') },
            ],
          },
          {
            label: 'Duty',
            items: [
              { label: onDuty ? 'On duty (sim loaded)' : 'Off duty — load the sim', disabled: true, checked: onDuty },
              {
                label: 'Leave current call',
                disabled: !myJob || Boolean(active),
                onClick: () => myJob && releaseJob(myJob),
              },
              { label: 'Abandon active job', disabled: !active, onClick: abandon },
            ],
          },
          {
            label: 'Help',
            items: [
              { label: 'Scene object packs (download & install)…', onClick: () => setScenePacksOpen(true) },
              {
                label: 'Install downloaded scene packs now',
                onClick: async () => {
                  const res = (await window.ipc?.invoke?.('addons:install')) as { message?: string } | undefined;
                  setSimNote(res?.message ?? 'Pack install attempted. Fully restart MSFS to load them.');
                },
              },
              {
                label: 'Re-install built-in fallback objects',
                onClick: async () => {
                  const res = (await window.ipc?.invoke?.('packages:install')) as { message?: string } | undefined;
                  setSimNote(
                    `${res?.message ?? 'Object package install attempted.'} You must fully restart MSFS for the sim to load the models.`,
                  );
                },
              },
              {
                label: 'Open MSFS Community folder',
                onClick: () => void window.ipc?.invoke?.('packages:openCommunity'),
              },
              { label: 'Model credits & licences…', onClick: () => void window.ipc?.invoke?.('app:openDataFolder') },
              'separator',
              { label: 'Check for updates…', onClick: () => setUpdateOpen(true) },
              'separator',
              { label: 'GPS control needs the PMS50 GTN750 Premium', disabled: true },
              { label: version ? `Aus Emergency Dispatcher ${version}` : 'Aus Emergency Dispatcher', disabled: true },
            ],
          },
        ]}
      />

      <UpdateBanner onOpen={() => setUpdateOpen(true)} />

      {/* Toolbar */}
      <div className="win-underline flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1">
        <span className="text-[#404040]">
          Duty <b className={onDuty ? 'text-black' : 'text-[#a00000]'}>{onDuty ? 'ON (sim loaded)' : 'OFF'}</b>
        </span>
        <Sep />
        <span className="text-[#404040]">
          Operator <b className="text-black">{myName}</b>
        </span>
        <Sep />
        <span className="text-[#404040]">
          Sim link{' '}
          <b className={simStatus.connected ? 'text-black' : 'text-[#a00000]'}>
            {simStatus.connected ? (simStatus.simName ?? 'Connected') : 'Not connected'}
          </b>
        </span>
        <Sep />
        <span className="text-[#404040]">
          Aircraft{' '}
          <b className={hasFix ? 'text-black' : 'text-[#a00000]'}>
            {hasFix ? (aircraftClass === 'rotary' ? 'Rotary' : 'Fixed wing') : 'N/A'}
          </b>
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[#606060]">Test object</span>
          <select
            className="win-sunken px-1 py-[2px] text-[12px]"
            value={objPreset}
            onChange={(e) => setObjPreset(e.target.value)}
            title="Object type — every unit in the session spawns the same one"
          >
            {(presets.length ? presets : [{ id: 'windsock', label: 'Windsock (marker)' }]).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="win-btn"
            disabled={!canInject || simBusy}
            onClick={injectTest}
            title={
              canInject
                ? 'Spawn it 5 m ahead and share it with the session'
                : 'Connect a sim with a known position first'
            }
          >
            Inject
          </button>
          <Sep />
          <span className="text-[11px] uppercase tracking-wide text-[#606060]">Scene</span>
          <select
            className="win-sunken px-1 py-[2px] text-[12px]"
            value={testSceneId}
            onChange={(e) => setTestSceneId(e.target.value)}
            title="Drop this scene on the ground ahead of the aircraft to check the models"
          >
            {(sceneCatalog.length ? sceneCatalog : [{ id: 'mva', label: 'Vehicle accident' }]).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="win-btn"
            disabled={!canInject || simBusy}
            onClick={dropSceneAhead}
            title={
              canInject
                ? 'Spawn the scene ~45 m ahead on the ground (local only)'
                : 'Connect a sim with a known position first'
            }
          >
            Drop ahead
          </button>
          <button
            type="button"
            className="win-btn"
            disabled={!simStatus.connected || simStatus.injected.length === 0 || simBusy}
            onClick={clearInjected}
          >
            Clear ({simStatus.injected.length})
          </button>
        </div>
      </div>

      {(simNote || injectFeedback || (simStatus.lastError && simStatus.connected)) && (
        <div className="win-underline max-h-24 space-y-0.5 overflow-auto px-2 py-1 text-[#404040]">
          {simNote && (
            <div>
              <b className="text-black">SimConnect:</b> {simNote}
            </div>
          )}
          {simStatus.lastError && simStatus.connected && (
            <div className="font-mono text-[11px] break-words">{simStatus.lastError}</div>
          )}
          {injectFeedback && <div className="font-mono text-[11px] break-words">{injectFeedback}</div>}
        </div>
      )}

      {note && (
        <div className="win-underline px-2 py-1 text-[#404040]">
          <b className="text-black">Dispatch:</b> {note}
        </div>
      )}

      {/* Work area */}
      <div className="flex min-h-0 flex-1 gap-2 overflow-auto p-2">
        {detailJob && detailCall ? (
          <CallDetail
            call={detailCall}
            canAccept={canClaimDetail}
            acceptLabel="Claim Job"
            onAccept={() => claim(detailJob)}
            onBack={() => setDetailJobId(null)}
          />
        ) : active ? (
          <ActiveJob
            mission={active}
            elapsed={elapsed}
            simStatus={simStatus}
            hasFix={hasFix}
            gpsStatus={gpsStatus}
            peers={peers}
            trail={trail}
            onAdvance={advance}
            onAbandon={abandon}
          />
        ) : (
          <>
            <OnWatch log={log} simStatus={simStatus} hasFix={hasFix} base={base} myJob={myJob} />
            {boardReady ? (
              <JobBoard
                available={available}
                myJob={myJob}
                othersActive={othersActive}
                aircraftClass={hasFix ? aircraftClass : null}
                estRangeNm={fix?.estRangeNm ?? 0}
                base={base!}
                boardTitle={isRaafv ? 'RAAFv Tasking' : 'Job Board'}
                selectedId={selectedJobId}
                onSelect={setSelectedJobId}
                onOpen={setDetailJobId}
                onClaim={claim}
                onJoin={joinJob}
                onRelease={releaseJob}
                onStart={startJob}
                canStart={boardReady}
              />
            ) : (
              <BasePicker
                hasFix={hasFix}
                connected={simStatus.connected}
                options={baseOptions}
                value={baseSel}
                onChange={setBaseSel}
                onConfirm={confirmBase}
                fix={fix}
              />
            )}
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="win-statusbar">
        <span className="grow">{detailJob ? `Viewing ${detailJob.kind}` : statusText}</span>
        <span className="w-[130px]">{available.length} available</span>
        <span className="flex w-[150px] items-center justify-center">
          <AccountBadge account={account} />
        </span>
        <span className="w-[84px] text-center">{new Date().toLocaleTimeString([], { hour12: false })}</span>
      </div>

      {scenePacksOpen && <ScenePacksDialog onClose={() => setScenePacksOpen(false)} />}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
    </div>
  );
}

function OnWatch({
  log,
  simStatus,
  hasFix,
  base,
  myJob,
}: {
  log: ShiftLog;
  simStatus: SimStatus;
  hasFix: boolean;
  base: Base | null;
  myJob: ServerJob | null;
}) {
  const pos = hasFix ? simStatus.position : null;
  return (
    <div className="flex w-[268px] shrink-0 flex-col gap-2">
      <GroupBox title="On Watch">
        <KeyRow label="Simulator" value={simStatus.connected ? (simStatus.simName ?? 'Connected') : 'No link'} />
        <KeyRow
          label="Duty"
          value={<b className={hasFix ? 'text-black' : 'text-[#a00000]'}>{hasFix ? 'ON (sim loaded)' : 'Off'}</b>}
        />
        <KeyRow
          label="Callsign"
          value={
            pos?.tailNumber ? (
              <span className="font-mono">
                {pos.tailNumber}
                {pos.tailNumberSource === 'menu' ? <span className="ml-1 text-[#404040]">(menu)</span> : null}
              </span>
            ) : pos ? (
              'Livery has no rego'
            ) : (
              '—'
            )
          }
        />
        <KeyRow label="Aircraft" value={pos?.atcModel || pos?.aircraftTitle || 'Awaiting sim link'} />
        <KeyRow label="Base" value={<span className="font-mono">{base?.name ?? '—'}</span>} />
        <KeyRow
          label="Range est"
          value={
            <span className="font-mono">
              {pos && pos.estRangeNm > 40 ? `${pos.estRangeNm} NM @ ${pos.cruiseKt} kt` : pos ? 'computing…' : '—'}
            </span>
          }
        />
        {pos && (
          <>
            <KeyRow label="Position" value={<span className="font-mono text-[11px]">{formatLatLon(pos)}</span>} />
            <KeyRow
              label="State"
              value={
                <span className="font-mono">
                  {pos.altitudeFt.toFixed(0)} ft · {pos.groundSpeedKt.toFixed(0)} kt ·{' '}
                  {pos.onGround ? 'on ground' : 'airborne'}
                </span>
              }
            />
          </>
        )}
        {simStatus.lastError && !simStatus.connected && (
          <p className="mt-1 text-[11px] text-[#404040]">{simStatus.lastError}</p>
        )}
        <p className="mt-2 border-t border-[#808080] pt-2 text-[#404040]">
          {myJob
            ? 'Job claimed. Load into the sim, then Start Job to launch from base.'
            : !simStatus.connected
              ? 'Browse and claim jobs now; loading the sim puts you on duty.'
              : !hasFix
                ? 'Simulator connected — waiting for a position fix.'
                : 'On duty. Claim a job from the board, then Start Job.'}
        </p>
      </GroupBox>

      <GroupBox title="This Shift">
        <KeyRow label="Jobs cleared" value={<span className="font-mono">{log.cleared}</span>} />
        <KeyRow
          label="Avg on task"
          value={<span className="font-mono">{log.cleared ? dur(log.avgResponseSec) : '—'}</span>}
        />
      </GroupBox>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={`border-b-2 border-[#808080] px-2 py-1 font-bold ${className}`}
      style={{ boxShadow: 'inset -1px 0 0 #fff, inset 1px 0 0 #808080' }}
    >
      {children}
    </th>
  );
}

/** Pick where the unit operates from before the job board goes live. */
function BasePicker({
  hasFix,
  connected,
  options,
  value,
  onChange,
  onConfirm,
  fix,
}: {
  hasFix: boolean;
  connected: boolean;
  options: Airport[];
  value: string;
  onChange: (v: string) => void;
  onConfirm: (manualIdent?: string) => void;
  fix: SimStatus['position'];
}) {
  const [manual, setManual] = useState('');
  return (
    <fieldset className="win-group flex min-w-0 flex-1 flex-col">
      <div className="legend font-bold">Operating Base</div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        {!connected ? (
          <p className="max-w-[440px] text-[#404040]">
            Start Microsoft Flight Simulator and load onto a ramp. Once the aircraft reports a position you choose the
            airfield you&apos;re operating from — the job board opens after that.
          </p>
        ) : !hasFix ? (
          <p className="text-[#404040]">Simulator connected — waiting for a position fix…</p>
        ) : (
          <>
            <p className="max-w-[440px] text-[#404040]">
              Choose the airfield you&apos;re operating from. Jobs are dispatched from here and every task ends back at
              this base. {options.length} airfield(s) in range.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <select
                className="win-sunken min-w-[240px] px-2 py-[3px] font-mono text-[12px]"
                value={value}
                onChange={(e) => onChange(e.target.value)}
              >
                {options.map((a) => (
                  <option key={a.ident} value={a.ident}>
                    {a.ident}
                    {fix
                      ? ` — ${rangeBearing({ lat: fix.lat, lon: fix.lon }, { lat: a.lat, lon: a.lon }).rangeNm.toFixed(0)} NM`
                      : ''}
                  </option>
                ))}
                <option value="__pos__">Present position</option>
              </select>
              <button type="button" className="win-btn is-default" onClick={() => onConfirm()}>
                Set Base
              </button>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-[#404040]">
              <span>Not listed? Type an ICAO</span>
              <input
                className="win-sunken w-[92px] px-2 py-[3px] font-mono text-[12px] uppercase"
                value={manual}
                maxLength={5}
                placeholder="YMEN"
                onChange={(e) => setManual(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && manual.trim() && onConfirm(manual.trim())}
              />
              <button
                type="button"
                className="win-btn"
                disabled={!manual.trim()}
                onClick={() => onConfirm(manual.trim())}
              >
                Use
              </button>
            </div>
          </>
        )}
      </div>
    </fieldset>
  );
}

/** The shared job board — available jobs plus what other units are on. */
function JobBoard({
  available,
  myJob,
  othersActive,
  aircraftClass,
  estRangeNm,
  base,
  boardTitle,
  selectedId,
  onSelect,
  onOpen,
  onClaim,
  onJoin,
  onRelease,
  onStart,
  canStart,
}: {
  available: ServerJob[];
  myJob: ServerJob | null;
  othersActive: ServerJob[];
  aircraftClass: 'rotary' | 'fixed' | null;
  estRangeNm: number;
  base: Base;
  boardTitle: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onClaim: (j: ServerJob) => void;
  onJoin: (j: ServerJob) => void;
  onRelease: (j: ServerJob) => void;
  onStart: (j: ServerJob) => void;
  canStart: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const d = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => rangeBearing(a, b).rangeNm;
  const rangeTo = (j: ServerJob) => rangeBearing({ lat: base.lat, lon: base.lon }, { lat: j.lat, lon: j.lon });
  /** Full sortie: base → job → (hospital) → base. */
  const routeNm = (j: ServerJob) => {
    const toJob = d(base, j);
    if (j.transportTo) return toJob + d(j, j.transportTo) + d(j.transportTo, base);
    return toJob + d(j, base);
  };
  // Use the aircraft's fuel-based range when we have it, else a class default.
  const reach = estRangeNm > 40 ? estRangeNm : aircraftClass === 'fixed' ? 900 : 300;
  // Default view is jobs CLOSE to base (leg distance), not everything the tanks
  // could round-trip — "Show all in range" opens it up to the full fuel reach.
  const localCap = Math.min(reach * 0.98, aircraftClass === 'fixed' ? 320 : 130);
  const sorted = useMemo(() => {
    const byRange = [...available].sort((a, b) => routeNm(a) - routeNm(b));
    if (showAll) return byRange.filter((j) => routeNm(j) <= reach * 0.98);
    return byRange.filter((j) => d(base, j) <= localCap && routeNm(j) <= reach * 0.98);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, base.lat, base.lon, showAll, reach, localCap]);
  const hiddenCount = available.length - sorted.length;
  const selected = sorted.find((j) => j.id === selectedId) ?? null;

  return (
    <fieldset className="win-group flex min-w-0 flex-1 flex-col">
      <div className="legend flex items-center gap-2 font-bold">
        {boardTitle} — {base.name} ·{' '}
        {showAll
          ? `reach ${Math.round(reach)} NM${estRangeNm > 40 ? ' (fuel)' : ''}`
          : `within ${Math.round(localCap)} NM`}
        <label className="ml-2 flex items-center gap-1 font-normal text-[11px] text-[#404040]">
          <input
            type="checkbox"
            className="win-checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show all in range{hiddenCount > 0 ? ` (+${hiddenCount})` : ''}
        </label>
      </div>

      {myJob && (
        <div className="mb-2 win-sunken flex items-center gap-2 px-2 py-1.5">
          <PriBadge priority={myJob.priority} />
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => onOpen(myJob.id)}
            title="Open the full brief"
          >
            <div className="font-bold underline decoration-dotted">
              {myJob.kind}
              {(myJob.party?.length ?? 0) > 1 ? (
                <span className="ml-2 font-normal text-[11px] text-[#1a6a1a]">
                  crew of {myJob.party!.length}
                  {myJob.claimedByName ? ` · lead ${myJob.claimedByName}` : ''}
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-[#404040]">{myJob.place}</div>
          </button>
          <button type="button" className="win-btn" onClick={() => onOpen(myJob.id)}>
            Details
          </button>
          {myJob.status === 'claimed' ? (
            <>
              <button
                type="button"
                className="win-btn is-default"
                disabled={!canStart}
                title={canStart ? 'Launch from base' : 'Set an operating base first'}
                onClick={() => onStart(myJob)}
              >
                Start Job
              </button>
              <button type="button" className="win-btn" onClick={() => onRelease(myJob)}>
                Release
              </button>
            </>
          ) : (
            <span className="font-mono text-[11px] text-[#404040]">active — {myJob.phase}</span>
          )}
        </div>
      )}

      <div className="win-list flex-1">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#d4d0c8] text-left">
              <Th className="w-[46px]">Pri</Th>
              <Th>Tasking</Th>
              <Th className="w-[190px]">Location</Th>
              <Th className="w-[64px]">Type</Th>
              <Th className="w-[104px] text-right">From base</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-6 text-center text-[#404040]">
                  {hiddenCount > 0
                    ? `No tasking within ${Math.round(localCap)} NM of ${base.name}. ${hiddenCount} further out — tick "Show all in range".`
                    : 'No tasking right now — the pool tops up automatically.'}
                </td>
              </tr>
            ) : (
              sorted.map((j) => {
                const sel = j.id === selectedId;
                const rb = rangeTo(j);
                const mismatch = aircraftClass && aircraftClass !== j.aircraftClass;
                return (
                  <tr
                    key={j.id}
                    onClick={() => onSelect(j.id)}
                    onDoubleClick={() => onOpen(j.id)}
                    className={`win-row border-b border-[#e6e3de] ${sel ? 'is-selected' : ''}`}
                  >
                    <td className="px-2 py-[5px] align-top">
                      <PriBadge priority={j.priority} />
                    </td>
                    <td className="px-2 py-[5px] align-top">
                      <div className="font-bold">{j.kind}</div>
                      <div className={sel ? 'text-[#d8d8ff]' : 'text-[#404040]'}>{j.agency}</div>
                    </td>
                    <td className="px-2 py-[5px] align-top">{j.place}</td>
                    <td className={`px-2 py-[5px] align-top ${mismatch ? 'text-[#a00000]' : ''}`}>
                      {j.aircraftClass === 'rotary' ? 'Rotary' : 'Fixed'}
                      {mismatch ? ' ⚠' : ''}
                    </td>
                    <td className="px-2 py-[5px] text-right align-top font-mono">
                      {heading(rb.bearingDeg)} / {rb.rangeNm.toFixed(0)}
                      <span
                        className={`ml-1 text-[10px] ${routeNm(j) > reach ? 'text-[#a00000]' : 'text-[#606060]'}`}
                        title="round trip base → job → hospital → base"
                      >
                        (rt {routeNm(j).toFixed(0)})
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="win-btn is-default"
          disabled={!selected || Boolean(myJob)}
          onClick={() => selected && onClaim(selected)}
          title={myJob ? 'Leave your current call first' : 'Claim this job'}
        >
          Claim Job
        </button>
        <button type="button" className="win-btn" disabled={!selected} onClick={() => selected && onOpen(selected.id)}>
          Details
        </button>
        <span className="ml-1 truncate text-[#404040]">
          {selected ? `Selected: ${selected.kind}` : 'Select a job. Double-click for the full brief.'}
        </span>
      </div>

      {othersActive.length > 0 && !myJob && (
        <div className="mt-2 win-sunken max-h-28 overflow-auto p-1.5">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-[#606060]">
            Calls other crews are on — join one
          </div>
          {othersActive.map((j) => (
            <div key={j.id} className="flex items-center gap-2 border-b border-[#e6e3de] px-1 py-[3px] last:border-0">
              <PriBadge priority={j.priority} />
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpen(j.id)}>
                <b>{j.kind}</b> <span className="text-[#404040]">· {j.place}</span>
                <span className="ml-1 text-[11px] text-[#606060]">
                  · lead {j.claimedByName ?? '—'}
                  {(j.party?.length ?? 0) > 1 ? ` +${j.party!.length - 1}` : ''} · {j.phase ?? j.status}
                </span>
              </button>
              <button type="button" className="win-btn" onClick={() => onJoin(j)}>
                Join
              </button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function CallDetail({
  call,
  canAccept,
  acceptLabel = 'Accept Call',
  onAccept,
  onBack,
}: {
  call: Call;
  canAccept: boolean;
  acceptLabel?: string;
  onAccept: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="win-window flex min-h-0 flex-1 flex-col">
        <div className="win-titlebar">
          <span className="flex-1 truncate">
            Job Detail &mdash; {call.kind} &nbsp;[{call.category}]
          </span>
          <button type="button" className="win-titlebar-btn" aria-label="Close" onClick={onBack}>
            {'✕'}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-2 flex items-center gap-3">
            <PriBadge priority={call.priority} />
            <span className="text-[15px] font-bold">{call.kind}</span>
            <span className="text-[#404040]">{call.place}</span>
          </div>

          <div className="grid grid-cols-2 gap-x-3">
            <GroupBox title="Summary">
              <KeyRow label="Call ID" value={<span className="font-mono">{call.id}</span>} wide={104} />
              <KeyRow label="Category" value={call.category} wide={104} />
              <KeyRow label="Priority" value={<PriBadge priority={call.priority} />} wide={104} />
              <KeyRow
                label="Received"
                value={<span className="font-mono">{receivedClock(call.receivedOffsetSec)}</span>}
                wide={104}
              />
              <KeyRow label="Source" value={call.source} wide={104} />
              <KeyRow label="Informant" value={call.informant} wide={104} />
            </GroupBox>

            <GroupBox title="Location">
              <KeyRow label="Place" value={call.place} wide={104} />
              <KeyRow label="Lat / Long" value={<span className="font-mono">{call.latLon}</span>} wide={104} />
              <KeyRow label="Sector" value={call.sector} wide={104} />
              <KeyRow label="Access" value={call.access} wide={104} />
              <KeyRow label="Landing" value={call.lz} wide={104} />
            </GroupBox>
          </div>

          <GroupBox title="Situation">
            <div className="win-sunken px-2 py-1.5 leading-relaxed">{call.detail}</div>
            <div className="mt-2 grid grid-cols-2 gap-x-3">
              <KeyRow label="Hazards" value={call.hazards} wide={104} />
              <KeyRow label="Persons" value={call.persons} wide={104} />
            </div>
          </GroupBox>

          <div className="grid grid-cols-2 gap-x-3">
            <GroupBox title="Response">
              <KeyRow label="Nearest asset" value={call.nearestAsset} wide={104} />
              <div className="mt-1 text-[#404040]">Units:</div>
              <ul className="ml-4 list-disc">
                {call.units.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </GroupBox>

            <GroupBox title="Weather">
              <div className="win-sunken px-2 py-1.5 font-mono">{call.weather}</div>
              <p className="mt-2 text-[11px] text-[#404040]">
                Live map, tracking and unit positions open on the job console once the call is accepted.
              </p>
            </GroupBox>
          </div>
        </div>

        <div
          className="flex items-center gap-2 border-t-2 border-[#808080] p-2"
          style={{ boxShadow: '0 1px 0 #fff inset' }}
        >
          <button type="button" className="win-btn is-default" disabled={!canAccept} onClick={onAccept}>
            Accept Call
          </button>
          <button type="button" className="win-btn" onClick={onBack}>
            Back to List
          </button>
          {!canAccept && <span className="ml-1 text-[#404040]">Go on duty (and clear the current job) to accept.</span>}
        </div>
      </div>
    </div>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`win-raised -mb-[2px] border-b-0 px-4 py-1 ${active ? 'relative z-10 font-bold' : 'text-[#404040]'}`}
      style={active ? { background: '#d4d0c8', boxShadow: 'inset 1px 1px 0 #fff' } : undefined}
    >
      {label}
    </button>
  );
}

type Target = { name: string; lat: number; lon: number; label: 'To Scene' | 'To Hospital' | 'To Base' };

/** Where the crew is heading right now: base → scene → hospital → base. */
function activeTarget(call: Call, phase: Phase, base: Base): Target {
  if (phase === 'returning') return { name: base.name, lat: base.lat, lon: base.lon, label: 'To Base' };
  if ((phase === 'transport' || phase === 'athospital') && call.transportTo) {
    return { ...call.transportTo, label: 'To Hospital' };
  }
  return { name: call.kind, lat: call.lat, lon: call.lon, label: 'To Scene' };
}

function TrackingTab({
  call,
  sim,
  phase,
  base,
  targets,
}: {
  call: Call;
  sim: SimStatus;
  phase: Phase;
  base: Base;
  targets?: AirTarget[];
}) {
  const pos = sim.position;
  const tgt = activeTarget(call, phase, base);
  const rb = pos ? rangeBearing({ lat: pos.lat, lon: pos.lon }, { lat: tgt.lat, lon: tgt.lon }) : null;

  // RAAFv intercept picture: live contact if it's airborne, else the spawn point.
  const liveContact = sim.injected.find((o) => o.isAircraft && o.objectId != null && Number.isFinite(o.lat));
  const primary = targets?.[0];
  const aim = liveContact
    ? {
        lat: liveContact.lat,
        lon: liveContact.lon,
        live: true,
        holding: liveContact.holding,
        alt: liveContact.altFt,
        spd: liveContact.speedKt,
      }
    : primary?.route[0]
      ? {
          lat: primary.route[0].lat,
          lon: primary.route[0].lon,
          live: false,
          holding: false,
          alt: primary.route[0].altFt,
          spd: primary.route[0].speedKt,
        }
      : null;
  const irb = pos && aim ? rangeBearing({ lat: pos.lat, lon: pos.lon }, { lat: aim.lat, lon: aim.lon }) : null;
  // rough time to close, using own groundspeed + a head-on closure assumption
  const closeKt = pos ? Math.max(60, pos.groundSpeedKt + (aim?.live && !aim.holding ? (aim.spd ?? 0) * 0.4 : 0)) : 0;

  return (
    <div className="space-y-3">
      <GroupBox title="Aircraft">
        {!sim.connected || !pos ? (
          <p className="py-2 text-[#404040]">
            {sim.connected ? 'Waiting for aircraft data…' : 'No simulator link. Start MSFS to track the aircraft.'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-x-4">
            <KeyRow
              label="Callsign"
              value={
                <span className="font-mono">
                  {pos.tailNumber || '—'}
                  {pos.tailNumber ? (
                    <span className="ml-1 font-sans text-[#404040]">
                      (
                      {pos.tailNumberSource === 'livery.cfg'
                        ? 'from livery'
                        : pos.tailNumberSource === 'livery name'
                          ? 'from livery name'
                          : 'menu override'}
                      )
                    </span>
                  ) : null}
                </span>
              }
              wide={92}
            />
            <KeyRow label="Type" value={pos.atcModel || pos.atcType || '—'} wide={72} />
            <KeyRow label="Livery" value={pos.liveryName || '—'} wide={92} />
            <KeyRow
              label="Container"
              value={<span className="text-[11px]">{pos.aircraftTitle || '—'}</span>}
              wide={72}
            />
            <KeyRow
              label="Position"
              value={<span className="font-mono text-[11px]">{formatLatLon(pos)}</span>}
              wide={92}
            />
            <KeyRow
              label="Heading"
              value={<span className="font-mono">{heading(pos.headingTrueDeg)} T</span>}
              wide={72}
            />
            <KeyRow
              label="Altitude"
              value={
                <span className="font-mono">
                  {pos.altitudeFt.toFixed(0)} ft{' '}
                  <span className="text-[#404040]">({pos.altitudeAglFt.toFixed(0)} AGL)</span>
                </span>
              }
              wide={92}
            />
            <KeyRow
              label="Speed"
              value={
                <span className="font-mono">
                  {pos.groundSpeedKt.toFixed(0)} kt · {pos.verticalSpeedFpm >= 0 ? '+' : ''}
                  {pos.verticalSpeedFpm.toFixed(0)} fpm
                </span>
              }
              wide={72}
            />
            <KeyRow label="On ground" value={pos.onGround ? 'Yes' : 'No — airborne'} wide={92} />
          </div>
        )}
      </GroupBox>

      <GroupBox title={tgt.label}>
        <div className="flex gap-3">
          <SunkenField label="Bearing" value={rb ? heading(rb.bearingDeg) : '—'} />
          <SunkenField label="Range" value={rb ? `${rb.rangeNm.toFixed(1)} NM` : '—'} />
          <SunkenField label="ETA" value={rb && pos ? formatEta(rb.rangeNm, pos.groundSpeedKt) : '—'} />
        </div>
        <p className="mt-2 text-[11px] text-[#404040]">
          {tgt.label === 'To Base' ? 'Base' : tgt.label === 'To Hospital' ? 'Destination' : 'Scene'}: {tgt.name}
          {tgt.label === 'To Scene' ? ` — ${call.place}` : ''}
          {rb && rb.rangeNm < 0.8 && phase === 'enroute' ? ' · overhead — mark on scene' : ''}
          {rb && rb.rangeNm < 0.8 && phase === 'transport' ? ' · over the pad — arrived hospital' : ''}
          {rb && rb.rangeNm < 1.0 && phase === 'returning' ? ' · overhead base — close the job' : ''}
        </p>
        {call.transportTo && (
          <p className="mt-1 text-[11px] text-[#404040]">
            Patient destination: <b className="text-black">{call.transportTo.name}</b>
          </p>
        )}
      </GroupBox>

      {primary && (
        <GroupBox title={aim?.live ? 'Target — live' : 'Target — spawn point'}>
          <div className="flex gap-3">
            <SunkenField label="Bearing" value={irb ? heading(irb.bearingDeg) : '—'} />
            <SunkenField label="Range" value={irb ? `${irb.rangeNm.toFixed(1)} NM` : '—'} />
            <SunkenField label="To close" value={irb && closeKt ? formatEta(irb.rangeNm, closeKt) : '—'} />
          </div>
          <p className="mt-2 text-[11px] text-[#404040]">
            <b className="text-black">{primary.label}</b>
            {aim?.alt ? ` · FL${Math.round(aim.alt / 100)}` : ''}
            {aim?.spd ? ` · ${Math.round(aim.spd)} kt` : ''}
            {primary.squawk && primary.squawk !== '0000'
              ? ` · squawk ${primary.squawk}`
              : primary.squawk === '0000'
                ? ' · no squawk'
                : ''}
          </p>
          <p className="mt-1 text-[11px] text-[#404040]">
            {!aim?.live
              ? `Not launched — press "Launch target". It will spawn here${primary.holdUntilNm ? ` and hold until you close inside ${primary.holdUntilNm} NM` : ''}.`
              : aim.holding
                ? `Holding for you — close inside ${primary.holdUntilNm ?? 80} NM and it will commit on its route.`
                : irb && irb.rangeNm < 5
                  ? 'Merge — visually acquire and identify.'
                  : 'Committed on its route — vector for a converging intercept.'}
          </p>
        </GroupBox>
      )}
    </div>
  );
}

function BriefingTab({ call }: { call: Call }) {
  return (
    <div className="space-y-3">
      <GroupBox title="Situation">
        <div className="win-sunken px-2 py-1.5 leading-relaxed">{call.detail}</div>
        <div className="mt-2 grid grid-cols-2 gap-x-4">
          <KeyRow label="Category" value={call.category} wide={92} />
          <KeyRow
            label="Received"
            value={<span className="font-mono">{receivedClock(call.receivedOffsetSec)}</span>}
            wide={72}
          />
          <KeyRow label="Source" value={call.source} wide={92} />
          <KeyRow label="Informant" value={call.informant} wide={72} />
        </div>
      </GroupBox>

      <div className="grid grid-cols-2 gap-x-3">
        <GroupBox title="Risk">
          <KeyRow label="Hazards" value={call.hazards} wide={72} />
          <KeyRow label="Persons" value={call.persons} wide={72} />
          <KeyRow label="Sector" value={call.sector} wide={72} />
        </GroupBox>
        <GroupBox title="Approach">
          <KeyRow label="Access" value={call.access} wide={72} />
          <KeyRow label="Landing" value={call.lz} wide={72} />
        </GroupBox>
      </div>

      <div className="grid grid-cols-2 gap-x-3">
        <GroupBox title="Response">
          <KeyRow label="Nearest" value={call.nearestAsset} wide={72} />
          <div className="mt-1 text-[#404040]">Units:</div>
          <ul className="ml-4 list-disc">
            {call.units.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </GroupBox>
        <GroupBox title="Weather">
          <div className="win-sunken px-2 py-1.5 font-mono">{call.weather}</div>
        </GroupBox>
      </div>
    </div>
  );
}

function ActiveJob({
  mission,
  elapsed,
  simStatus,
  hasFix,
  gpsStatus,
  peers,
  trail,
  onAdvance,
  onAbandon,
}: {
  mission: ActiveMission;
  elapsed: number;
  simStatus: SimStatus;
  hasFix: boolean;
  gpsStatus: GpsStatus | null;
  peers: PeerPresence[];
  trail: { lat: number; lon: number }[];
  onAdvance: () => void;
  onAbandon: () => void;
}) {
  const { call, phase, base } = mission;
  const [tab, setTab] = useState<'track' | 'briefing'>('track');
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [scenes, setScenes] = useState<{ id: string; label: string }[]>([]);
  const [sceneId, setSceneId] = useState('auto');
  const [sceneNote, setSceneNote] = useState<string | null>(null);
  const pct = PHASE_PCT[phase];
  const phaseLabel = PHASE_LABEL[phase];
  const primary = phaseAction(phase, Boolean(call.transportTo));
  const tgt = activeTarget(call, phase, base);
  const atScene = phase === 'enroute' || phase === 'onscene';

  // Automatic-flow status line + dwell countdowns (recomputes each 1s render).
  const inPhaseSec = Math.max(0, Math.floor((Date.now() - mission.phaseSince) / 1000));
  const loadLeft = Math.max(0, mission.onSceneSec - inPhaseSec);
  const unloadLeft = Math.max(0, mission.atHospitalSec - inPhaseSec);
  const sceneWord = mission.airborne ? 'the tasking area' : 'the scene';
  const autoLine =
    phase === 'enroute'
      ? `flying to ${sceneWord} — advances on arrival`
      : phase === 'onscene'
        ? call.transportTo
          ? `on scene, patient load ${loadLeft}s → depart for ${call.transportTo.name}`
          : `on task ${inPhaseSec}s → ${loadLeft}s to task complete, then RTB`
        : phase === 'transport'
          ? `en route ${call.transportTo?.name ?? 'hospital'} — advances on arrival`
          : phase === 'athospital'
            ? `handover / unload ${unloadLeft}s → return to ${base.name}`
            : `returning to ${base.name} — job closes on arrival`;

  useEffect(() => {
    Promise.resolve(sim.sceneList())
      .then((s) => Array.isArray(s) && s.length && setScenes(s))
      .catch(() => undefined);
  }, []);

  const sendToGps = useCallback(async () => {
    setGpsBusy(true);
    setGpsNote('Exporting route as fpl.pln…');
    const res = await sim.gpsDirectTo({
      jobId: `${call.kind.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}-${mission.jobId.slice(0, 5)}`,
      base: { name: base.name, lat: base.lat, lon: base.lon },
      scene: { name: call.kind, lat: call.lat, lon: call.lon },
      hospital: call.transportTo ?? null,
    });
    setGpsBusy(false);
    setGpsNote(res?.note ?? 'GPS bridge unavailable.');
  }, [call.kind, call.lat, call.lon, call.transportTo, base, mission.jobId]);

  const placeScene = useCallback(async () => {
    setSceneNote('Placing…');
    const res = await sim.injectScene({
      sceneId,
      lat: call.lat,
      lon: call.lon,
      headingSeed: mission.jobId, // same orientation as the shared placement
      sceneKey: mission.jobId,
      kind: call.kind,
      category: call.category,
      seed: `replace-${Date.now()}`, // a fresh variation each press
    });
    if (!res) setSceneNote('SimConnect bridge unavailable.');
    else if (res.ok)
      setSceneNote(
        `Placed ${res.objects?.length ?? 0} object(s) at the scene${
          res.session ? ` — shared to "${res.session}"` : ''
        }. Watch the ✓/✗ list below the toolbar for what each sim resolved.`,
      );
    else setSceneNote(res.error ?? 'Scene placement failed.');
  }, [sceneId, call.lat, call.lon, call.bearing, call.kind, call.category]);

  const [fsltl, setFsltl] = useState<{ installed: boolean; trafficBase: boolean } | null>(null);
  useEffect(() => {
    Promise.resolve(sim.fsltlStatus())
      .then((s) => s && setFsltl({ installed: s.installed, trafficBase: s.trafficBase }))
      .catch(() => undefined);
  }, []);
  const targets = mission.targets ?? [];
  const primaryTarget = targets[0];
  const spawnContact = useCallback(async () => {
    if (targets.length) {
      // RAAFv tasking: spawn the briefed aircraft(s) at the start of their route.
      // Each holds near its spawn point until you're within range (so it can't
      // fly past before you're airborne), then flies the route smoothly. Shared.
      setSceneNote(`Launching ${primaryTarget?.label ?? 'target'}…`);
      let ok = true;
      let err = '';
      for (const t of targets) {
        const res = await sim.injectAirContact({
          route: t.route,
          loop: t.loop,
          titleHint: t.titleHint,
          formation: t.formation,
          holdUntilNm: t.holdUntilNm,
          label: t.label,
        });
        if (!res?.ok) {
          ok = false;
          err = res?.error ?? 'spawn failed';
        }
      }
      setSceneNote(
        ok
          ? `${primaryTarget?.label ?? 'Target'} airborne — ${primaryTarget?.holdUntilNm ? `holding until you close inside ${primaryTarget.holdUntilNm} NM, ` : ''}shown on the map. Vector to intercept.`
          : `Target spawn: ${err}.`,
      );
      return;
    }
    // Emergency: a contact ~6 NM off the scene, tracking toward it at medium level.
    const brg = Math.random() * 360;
    const d = 6 / 60;
    const lat = call.lat + Math.cos((brg * Math.PI) / 180) * d;
    const lon = call.lon + (Math.sin((brg * Math.PI) / 180) * d) / Math.cos((call.lat * Math.PI) / 180);
    setSceneNote('Spawning airborne contact…');
    const res = await sim.injectAirContact({
      lat,
      lon,
      altFt: 6000 + Math.round(Math.random() * 12) * 500,
      headingDeg: (brg + 180) % 360,
      speedKt: 180 + Math.round(Math.random() * 8) * 20,
    });
    setSceneNote(
      res?.ok
        ? 'Airborne contact spawned and shared — it tracks on its own and every unit sees it move.'
        : (res?.error ?? 'Contact spawn failed.'),
    );
  }, [call.lat, call.lon, targets, primaryTarget]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="win-window flex min-h-0 flex-1 flex-col">
        <div className="win-titlebar">
          <span className="flex-1 truncate">
            Active Job &mdash; {call.kind} · from {base.name}
          </span>
          <button type="button" className="win-titlebar-btn" aria-label="Abandon" onClick={onAbandon}>
            {'✕'}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-bold">
              <PriBadge priority={call.priority} />
              {call.kind}
            </div>
            <div className="text-[#404040]">{call.place}</div>
          </div>

          <div className="my-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-[#404040]">
            <span>Status</span>
            <span className="font-bold normal-case tracking-normal text-black">{phaseLabel}</span>
          </div>
          <div className="win-sunken h-[16px] p-[2px]">
            <div className="h-full" style={{ width: `${pct}%`, background: '#000080' }} />
          </div>

          <div className="mt-3 flex items-end gap-1 border-b-2 border-[#808080]">
            <Tab label="Track" active={tab === 'track'} onClick={() => setTab('track')} />
            <Tab label="Briefing" active={tab === 'briefing'} onClick={() => setTab('briefing')} />
          </div>

          <div
            className={`win-groove min-h-0 flex-1 border-t-0 bg-[#d4d0c8] ${tab === 'briefing' ? 'overflow-auto p-3' : ''}`}
          >
            {tab === 'briefing' ? (
              <BriefingTab call={call} />
            ) : (
              <div className="flex h-full min-h-0">
                <div className="w-[320px] shrink-0 overflow-auto border-r-2 border-[#808080] p-3">
                  <TrackingTab call={call} sim={simStatus} phase={phase} base={base} targets={mission.targets} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2 border-b border-[#808080] px-2 py-1">
                    <button type="button" className="win-btn" onClick={sendToGps} disabled={gpsBusy}>
                      Export route to GTN750
                    </button>
                    <span className="ml-auto font-mono text-[11px] text-[#404040]">
                      GTN750{' '}
                      {gpsStatus?.gtnDetected
                        ? `${gpsStatus.gtnPremium ? 'Premium' : 'Lite'} · pg ${gpsStatus.currentPage}${
                            gpsStatus.lastAction ? ` · ${gpsStatus.lastAction}` : ''
                          }`
                        : 'not detected'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 border-b border-[#808080] px-2 py-1">
                    <span className="text-[11px] uppercase tracking-wide text-[#606060]">Scene</span>
                    <select
                      className="win-sunken px-1 py-[2px] text-[12px]"
                      value={sceneId}
                      onChange={(e) => setSceneId(e.target.value)}
                      title="Objects to place at the scene — every unit in the session spawns the same set"
                    >
                      <option value="auto">Auto — match incident</option>
                      {(scenes.length ? scenes : [{ id: 'mva', label: 'Vehicle accident' }]).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="win-btn"
                      onClick={placeScene}
                      disabled={!simStatus.connected || !atScene}
                      title={
                        atScene
                          ? 'Auto-placed as you approach — press to re-place / change the set'
                          : 'Only while en route / on scene'
                      }
                    >
                      Re-place scene
                    </button>
                    <button
                      type="button"
                      className="win-btn"
                      onClick={spawnContact}
                      disabled={!simStatus.connected}
                      title={
                        primaryTarget
                          ? `Auto-launched on start — press to re-spawn ${primaryTarget.label}`
                          : fsltl?.installed
                            ? 'Spawn a moving airborne contact near the job (FSLTL), synced to every unit'
                            : 'FSLTL not detected — a base aircraft is used instead'
                      }
                    >
                      {primaryTarget ? 'Re-launch target' : 'Add air contact'}
                    </button>
                    <span className="ml-auto font-mono text-[11px] text-[#404040]">
                      {fsltl?.installed ? 'FSLTL ✓ · ' : ''}
                      {peers.length} unit(s)
                    </span>
                  </div>
                  {(gpsNote || sceneNote) && (
                    <div className="border-b border-[#808080] px-2 py-1 font-mono text-[11px] text-[#404040]">
                      {gpsNote && <div>GPS: {gpsNote}</div>}
                      {sceneNote && <div>Scene: {sceneNote}</div>}
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <MapView
                      aircraft={hasFix ? simStatus.position : null}
                      trail={hasFix ? trail : []}
                      job={{ lat: tgt.lat, lon: tgt.lon, name: tgt.name }}
                      scene={tgt.label === 'To Scene' ? null : { lat: call.lat, lon: call.lon, name: call.kind }}
                      base={{ lat: base.lat, lon: base.lon, name: base.name }}
                      peers={peers}
                      objects={simStatus.injected}
                      targetRoutes={targets.map((t) => ({ label: t.label, route: t.route, loop: t.loop }))}
                      contacts={simStatus.injected
                        .filter((o) => o.isAircraft && o.objectId != null && Number.isFinite(o.lat))
                        .map((o) => ({
                          lat: o.lat,
                          lon: o.lon,
                          headingDeg: o.headingDeg,
                          label: o.label ?? primaryTarget?.label ?? 'contact',
                          altFt: o.altFt,
                          speedKt: o.speedKt,
                          holding: o.holding,
                        }))}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div
          className="flex items-center gap-2 border-t-2 border-[#808080] p-2"
          style={{ boxShadow: '0 1px 0 #fff inset' }}
        >
          <span className="min-w-0 flex-1 truncate text-[12px] text-[#404040]">
            <b className="text-black">Auto</b> · {autoLine}
          </span>
          <button type="button" className="win-btn" onClick={onAdvance} title="Skip straight to the next stage">
            Force: {primary}
          </button>
          <button type="button" className="win-btn" onClick={onAbandon}>
            Abandon
          </button>
          <span className="font-mono text-[11px] text-[#404040]">On task {dur(elapsed)}</span>
        </div>
      </div>
    </div>
  );
}
