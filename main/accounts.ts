import { randomUUID } from 'crypto';
import Store from 'electron-store';

/**
 * Local operator accounts. This is a single-machine profile store (no server
 * auth yet) — it identifies who is on console for attribution, Discord presence
 * and the shared-object session, and lets a household/crew room switch operator
 * without reinstalling.
 */
export type Account = {
  id: string;
  name: string;
  /** radio callsign shown on the map / presence, e.g. "Rescue 51" */
  callsign: string;
  /** free text: "HEMS crew", "Police Air Wing", "RFDS", … */
  role: string;
  createdAt: number;
  lastSeenAt: number;
  /** linked Discord identity (only needed for RAAFv) */
  discord?: { id: string; username: string; avatar: string | null };
  /** what this operator may open */
  entitlements?: { raafv?: boolean };
};

type Shape = { accounts: Account[]; currentId: string | null };

const store = new Store<Shape>({ name: 'accounts', defaults: { accounts: [], currentId: null } });

function clean(s: string, max: number): string {
  return String(s ?? '').trim().slice(0, max);
}

export const accounts = {
  list(): Account[] {
    return store.get('accounts', []);
  },

  current(): Account | null {
    const id = store.get('currentId', null);
    if (!id) return null;
    return store.get('accounts', []).find((a) => a.id === id) ?? null;
  },

  create(input: { name: string; callsign?: string; role?: string }): Account {
    const name = clean(input.name, 40) || 'Operator';
    const acc: Account = {
      id: randomUUID(),
      name,
      callsign: clean(input.callsign ?? '', 24),
      role: clean(input.role ?? '', 40),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    const list = store.get('accounts', []);
    list.push(acc);
    store.set('accounts', list);
    store.set('currentId', acc.id);
    return acc;
  },

  update(id: string, patch: Partial<Pick<Account, 'name' | 'callsign' | 'role'>>): Account | null {
    const list = store.get('accounts', []);
    const acc = list.find((a) => a.id === id);
    if (!acc) return null;
    if (patch.name !== undefined) acc.name = clean(patch.name, 40) || acc.name;
    if (patch.callsign !== undefined) acc.callsign = clean(patch.callsign, 24);
    if (patch.role !== undefined) acc.role = clean(patch.role, 40);
    store.set('accounts', list);
    return acc;
  },

  /** Attach (or clear, with null) a Discord identity + RAAFv entitlement. */
  setDiscord(
    id: string,
    link: { discord: Account['discord']; raafv: boolean } | null,
  ): Account | null {
    const list = store.get('accounts', []);
    const acc = list.find((a) => a.id === id);
    if (!acc) return null;
    if (link) {
      acc.discord = link.discord;
      acc.entitlements = { ...(acc.entitlements ?? {}), raafv: link.raafv };
    } else {
      delete acc.discord;
      acc.entitlements = { ...(acc.entitlements ?? {}), raafv: false };
    }
    store.set('accounts', list);
    return acc;
  },

  switch(id: string | null): Account | null {
    if (id === null) {
      store.set('currentId', null);
      return null;
    }
    const acc = store.get('accounts', []).find((a) => a.id === id);
    if (!acc) return null;
    acc.lastSeenAt = Date.now();
    store.set('accounts', store.get('accounts', []));
    store.set('currentId', id);
    return acc;
  },

  remove(id: string): void {
    const list = store.get('accounts', []).filter((a) => a.id !== id);
    store.set('accounts', list);
    if (store.get('currentId', null) === id) store.set('currentId', list[0]?.id ?? null);
  },
};
