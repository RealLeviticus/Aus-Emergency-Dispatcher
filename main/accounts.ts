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
  /** linked Discord identity (one of two ways to hold RAAFv access) */
  discord?: { id: string; username: string; avatar: string | null };
  /** linked RAAFv crew centre (phpVMS) pilot — the other, and the stronger one */
  phpvms?: { id: string; ident: string | null; username: string; rank: string | null };
  /**
   * What this operator may open. `raafv` is the answer; `raafvVia` records
   * which link granted it, so unlinking one identity does not revoke access the
   * other still justifies.
   */
  entitlements?: { raafv?: boolean; raafvVia?: { discord?: boolean; phpvms?: boolean } };
};

type Shape = { accounts: Account[]; currentId: string | null };

const store = new Store<Shape>({ name: 'accounts', defaults: { accounts: [], currentId: null } });

function clean(s: string, max: number): string {
  return String(s ?? '').trim().slice(0, max);
}

/**
 * Attach or clear one of the two RAAFv identity links, then recompute the
 * entitlement from BOTH. A member who signed in with their crew centre key and
 * also linked Discord must not lose RAAFv access by unlinking one of them.
 */
function setLink(
  id: string,
  which: 'discord' | 'phpvms',
  link: { profile: Account['discord'] | Account['phpvms']; raafv: boolean } | null,
): Account | null {
  const list = store.get('accounts', []);
  const acc = list.find((a) => a.id === id);
  if (!acc) return null;

  // Accounts linked before raafvVia existed only recorded the boolean. Infer
  // the granter from what they have, or an existing Discord user would lose
  // access the moment they touched either link.
  const via = acc.entitlements?.raafvVia ?? {
    discord: Boolean(acc.discord) && acc.entitlements?.raafv === true,
    phpvms: Boolean(acc.phpvms) && acc.entitlements?.raafv === true,
  };
  const grants: Record<'discord' | 'phpvms', boolean> = {
    discord: Boolean(acc.discord && via.discord),
    phpvms: Boolean(acc.phpvms && via.phpvms),
  };

  if (link) {
    if (which === 'discord') acc.discord = link.profile as Account['discord'];
    else acc.phpvms = link.profile as Account['phpvms'];
    grants[which] = link.raafv;
  } else {
    if (which === 'discord') delete acc.discord;
    else delete acc.phpvms;
    grants[which] = false;
  }

  acc.entitlements = {
    ...(acc.entitlements ?? {}),
    raafv: grants.discord || grants.phpvms,
    raafvVia: { ...grants },
  };
  store.set('accounts', list);
  return acc;
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

  /** Attach (or clear, with null) a Discord identity. */
  setDiscord(
    id: string,
    link: { discord: Account['discord']; raafv: boolean } | null,
  ): Account | null {
    return setLink(id, 'discord', link ? { profile: link.discord, raafv: link.raafv } : null);
  },

  /** Attach (or clear, with null) a RAAFv crew centre pilot. */
  setPhpvms(
    id: string,
    link: { phpvms: Account['phpvms']; raafv: boolean } | null,
  ): Account | null {
    return setLink(id, 'phpvms', link ? { profile: link.phpvms, raafv: link.raafv } : null);
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
