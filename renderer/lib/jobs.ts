import { useEffect, useRef, useState } from 'react';
import type { Priority } from './jobgen';

export type AircraftClass = 'rotary' | 'fixed';
export type JobStatus = 'available' | 'claimed' | 'active' | 'complete';
export type JobPhase = 'enroute' | 'onscene' | 'transport' | 'athospital' | 'returning';
export type Channel = 'emergency' | 'raafv';

export type Hospital = { name: string; lat: number; lon: number };

/** RAAFv only: an AI aircraft to spawn (via FSLTL) that flies a set route. */
export type AirTarget = {
  label: string;
  titleHint: 'jet' | 'heavy' | 'prop' | 'light';
  loop?: boolean;
  /** spawn this many in trail */
  formation?: number;
  /** loiters at route[0] until the interceptor is within this range */
  holdUntilNm?: number;
  squawk?: string;
  route: { lat: number; lon: number; altFt: number; speedKt: number }[];
};

/**
 * A moving GROUND or surface vehicle a job wants spawned — the car in a police
 * pursuit, a monitored convoy, a vessel of interest. Its route follows the real
 * road graph (see API/src/roads.ts).
 */
export type GroundTarget = {
  label: string;
  vehicle: 'car' | 'bike' | 'truck' | 'boat';
  /** `flee` runs and bails out at the end; `cruise` drives on, unaware */
  behaviour: 'flee' | 'cruise';
  /** waits at route[0] until the aircraft is within this range */
  holdUntilNm?: number;
  /** spawn this many in trail */
  convoy?: number;
  rego?: string;
  roads?: string[];
  route: { lat: number; lon: number; speedKt: number }[];
};

/** A job from the shared server pool (see API/src/jobgen.ts). */
export type ServerJob = {
  id: string;
  createdAt: number;
  status: JobStatus;
  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: number | null;
  phase: JobPhase | null;

  aircraftClass: AircraftClass;
  priority: Priority;
  kind: string;
  category: string;
  agency: string;
  callsign: string;

  lat: number;
  lon: number;
  place: string;
  region: string;
  latLon: string;

  brief: string;
  detail: string;
  source: string;
  informant: string;
  hazards: string;
  persons: string;
  access: string;
  lz: string;
  units: string[];
  weather: string;
  transportTo?: Hospital;
  patient?: string;
  timeline?: string;
  /**
   * RAAFv only: the airframe the tasking was written for. `registration` is a
   * real tail number from the crew centre fleet, present only when that aircraft
   * is genuinely parked at the base and not already flying.
   */
  tasked?: {
    type: string;
    squadron: string;
    registration?: string;
    /** where the sortie launches from — not necessarily the squadron's home */
    homeBase: string;
    /** the squadron is deployed there rather than based there */
    detachment?: boolean;
    source: 'crew-centre' | 'roster';
  };
  channel: Channel;
  targets?: AirTarget[];
  /** vehicles / vessels to spawn and track — police pursuits and surveillance */
  groundTargets?: GroundTarget[];
  /** everyone working this call (lead + anyone who joined) */
  party?: { clientId: string; name: string; joinedAt: number }[];
};

const ipc = () => (typeof window !== 'undefined' ? window.ipc : undefined);

export const jobs = {
  list: () => Promise.resolve(ipc()?.invoke?.('jobs:list')) as Promise<ServerJob[] | undefined>,
  locate: (lat: number, lon: number, channel: Channel = 'emergency') =>
    Promise.resolve(ipc()?.invoke?.('jobs:locate', lat, lon, channel)) as Promise<boolean | undefined>,
  claim: (id: string) => Promise.resolve(ipc()?.invoke?.('jobs:claim', id)) as Promise<boolean | undefined>,
  join: (id: string) => Promise.resolve(ipc()?.invoke?.('jobs:join', id)) as Promise<boolean | undefined>,
  leave: (id: string) => Promise.resolve(ipc()?.invoke?.('jobs:leave', id)) as Promise<boolean | undefined>,
  release: (id: string) => Promise.resolve(ipc()?.invoke?.('jobs:release', id)) as Promise<boolean | undefined>,
  start: (id: string) => Promise.resolve(ipc()?.invoke?.('jobs:start', id)) as Promise<boolean | undefined>,
  progress: (id: string, phase: JobPhase) =>
    Promise.resolve(ipc()?.invoke?.('jobs:progress', id, phase)) as Promise<boolean | undefined>,
  complete: (id: string) => Promise.resolve(ipc()?.invoke?.('jobs:complete', id)) as Promise<boolean | undefined>,
};

/**
 * Live view of the shared job pool, filtered to one board (`channel`).
 * `onArrive` fires for each newly-seen available job on that board.
 */
export function useJobs(onArrive?: (job: ServerJob) => void, channel: Channel = 'emergency'): ServerJob[] {
  const [list, setList] = useState<ServerJob[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const cb = useRef(onArrive);
  cb.current = onArrive;

  useEffect(() => {
    const apply = (arr: unknown) => {
      const all = Array.isArray(arr) ? (arr as ServerJob[]) : [];
      const next = all.filter((j) => (j.channel ?? 'emergency') === channel);
      for (const j of next) {
        if (!seen.current.has(j.id)) {
          seen.current.add(j.id);
          if (j.status === 'available') cb.current?.(j);
        }
      }
      // forget ids that dropped out so a re-add can alert again
      const ids = new Set(next.map((j) => j.id));
      for (const id of seen.current) if (!ids.has(id)) seen.current.delete(id);
      setList(next);
    };
    Promise.resolve(jobs.list()).then(apply).catch(() => undefined);
    let off: (() => void) | undefined;
    try {
      off = window.ipc?.on?.('jobs:feed', (v: unknown) => apply(v));
    } catch {
      /* not electron */
    }
    return () => {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, [channel]);

  return list;
}
