import { useCallback, useEffect, useState } from 'react';

/**
 * Where the RAAFv fleet is right now.
 *
 * The same snapshot the server built the tasking board from, so what an operator
 * reads here explains what they are looking at on the board: a base with nothing
 * parked gets no sorties, and a brief that quotes a tail number is quoting one of
 * these aircraft.
 */

export type FleetAircraft = {
  registration: string;
  type: string;
  icao: string;
  squadron: string | null;
  airborne: boolean;
};

export type FleetBase = {
  base: string;
  ident: string;
  region: string;
  /** a RAAFv "dry base": no resident squadron, stood up as a detachment */
  dry: boolean;
  squadrons: string[];
  aircraft: FleetAircraft[];
  roles: string[];
};

export type FleetList = {
  /** 'crew-centre' means these are live positions; 'roster' is the published ORBAT */
  source: 'crew-centre' | 'roster';
  fetchedAt: number;
  note?: string;
  total: number;
  airborne: number;
  homeBases: string[];
  bases: FleetBase[];
};

export type MyAircraft = FleetAircraft & { at: string | null; home: string | null };

const ipc = () => (typeof window !== 'undefined' ? window.ipc : undefined);

export const fleet = {
  list: () => Promise.resolve(ipc()?.invoke?.('fleet:list')) as Promise<FleetList | null | undefined>,
  mine: () =>
    Promise.resolve(ipc()?.invoke?.('fleet:mine')) as Promise<
      { ok: boolean; error?: string; aircraft?: MyAircraft[] } | undefined
    >,
};

/** Load the fleet once, with a manual refresh — it changes on the order of minutes. */
export function useFleet() {
  const [list, setList] = useState<FleetList | null>(null);
  const [mine, setMine] = useState<MyAircraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const l = (await fleet.list()) ?? null;
      setList(l);
      if (!l) setError('Could not reach the dispatcher API for the fleet list.');
      // A pilot who has not signed in simply has no personal fleet; that is not
      // an error worth showing next to the full list.
      const m = await fleet.mine();
      setMine(m?.ok ? (m.aircraft ?? []) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { list, mine, error, busy, refresh };
}
