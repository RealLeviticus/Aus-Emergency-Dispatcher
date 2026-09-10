import { safeStorage } from 'electron';
import Store from 'electron-store';
import { DEFAULT_SYNC_URL } from './syncclient';

/**
 * RAAFv sign-in against the crew centre's phpVMS API.
 *
 * phpVMS v7 issues every pilot an API key at registration (visible on their own
 * profile page), and the REST API is enabled by default — so this needs nothing
 * from RAAFv staff: no bot, no admin, no new login for the member.
 *
 * The key is a real credential for their crew centre account, so:
 *   - it goes to our API only, which forwards it to the crew centre and keeps
 *     no copy. Verifying server-side (rather than calling the crew centre from
 *     here) is what will let the API stop trusting the client's word about
 *     membership once the job channels are gated there;
 *   - locally it is encrypted with the OS keystore (DPAPI on Windows) so we can
 *     silently re-check on launch. Re-checking is what makes revocation work:
 *     the member regenerates their key in the crew centre and access dies.
 * Unlinking wipes it.
 *
 * NOTE: like the Discord path, this currently gates the UI only — the API still
 * serves the `raafv` channel to any client that asks for it. Making the gate
 * real needs a server-issued session presented on the websocket.
 */

type Shape = { key: string | null; encrypted: boolean };
const store = new Store<Shape>({ name: 'raafv', defaults: { key: null, encrypted: false } });

export type PhpvmsUser = {
  id: string;
  ident: string | null;
  username: string;
  rank: string | null;
  avatar: string | null;
};

export type PhpvmsLinkResult = {
  ok: boolean;
  error?: string;
  raafv?: boolean;
  roleReason?: string;
  user?: PhpvmsUser;
};

/** REST base derived from the sync URL (ws://host:3100/ws -> http://host:3100). */
function apiBase(): string {
  try {
    const u = new URL(DEFAULT_SYNC_URL);
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  } catch {
    return 'http://139.99.195.169:3100';
  }
}

function saveKey(key: string): void {
  // safeStorage needs the app ready and a usable OS keystore; on a machine
  // without one we keep the key only for this install rather than dropping the
  // feature, and record which form it is in.
  if (safeStorage.isEncryptionAvailable()) {
    store.set('key', safeStorage.encryptString(key).toString('base64'));
    store.set('encrypted', true);
  } else {
    store.set('key', key);
    store.set('encrypted', false);
  }
}

function readKey(): string | null {
  const raw = store.get('key', null);
  if (!raw) return null;
  if (!store.get('encrypted', false)) return raw;
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch {
    // Keystore changed under us (new machine, new user profile) — the key is
    // unreadable, so drop it and make the member paste it again.
    clearKey();
    return null;
  }
}

function clearKey(): void {
  store.set('key', null);
  store.set('encrypted', false);
}

export function hasStoredKey(): boolean {
  return Boolean(store.get('key', null));
}

export type PhpvmsConfig = { configured: boolean; name: string; url: string; profileUrl: string };

export async function getConfig(): Promise<PhpvmsConfig | null> {
  try {
    const r = await fetch(`${apiBase()}/auth/phpvms/config`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return (await r.json()) as PhpvmsConfig;
  } catch {
    return null;
  }
}

export async function isConfigured(): Promise<boolean> {
  return (await getConfig())?.configured ?? false;
}

async function verify(apiKey: string): Promise<PhpvmsLinkResult> {
  try {
    const r = await fetch(`${apiBase()}/auth/phpvms/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = (await r.json()) as PhpvmsLinkResult;
    if (!r.ok) return { ok: false, error: data?.error ?? `Sign-in failed (${r.status}).` };
    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Verify a freshly pasted key and, if it checks out, remember it. */
export async function linkPhpvms(apiKey: string): Promise<PhpvmsLinkResult> {
  const key = String(apiKey ?? '').trim();
  if (!key) return { ok: false, error: 'Enter your crew centre API key.' };
  const res = await verify(key);
  if (res.ok) saveKey(key);
  return res;
}

/**
 * Re-check the stored key. Returns null when there is nothing stored, so a
 * caller can tell "not linked" from "linked but the crew centre says no".
 * A network failure resolves ok:false WITHOUT clearing the key — being offline
 * must not sign a member out.
 */
export async function revalidate(): Promise<PhpvmsLinkResult | null> {
  const key = readKey();
  if (!key) return null;
  const res = await verify(key);
  // Only a definite rejection drops the key; anything else may be transient.
  if (!res.ok && /did not accept/i.test(res.error ?? '')) clearKey();
  return res;
}

export function unlinkPhpvms(): void {
  clearKey();
}
