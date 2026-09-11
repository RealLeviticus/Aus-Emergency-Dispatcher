import { useCallback, useEffect, useState } from 'react';

/**
 * RAAFv crew centre sign-in — the only identity the app has.
 *
 * There are no local operator profiles: nothing needs a name, callsigns come
 * from the tasking agency, and RAAFv access is proved by the crew centre key
 * rather than by a profile carrying an entitlement flag.
 */
export type PhpvmsConfig = { configured: boolean; name: string; url: string; profileUrl: string };

export type PhpvmsPilot = { id: string; ident: string | null; username: string; rank: string | null };

export type PhpvmsLinkResult = {
  ok: boolean;
  error?: string;
  raafv?: boolean;
  roleReason?: string;
  user?: PhpvmsPilot & { avatar: string | null };
};

const ipc = () => (typeof window !== 'undefined' ? window.ipc : undefined);

export const account = {
  phpvmsConfig: () => Promise.resolve(ipc()?.invoke?.('auth:phpvmsConfig')) as Promise<PhpvmsConfig | null | undefined>,
  pilot: () => Promise.resolve(ipc()?.invoke?.('auth:phpvmsPilot')) as Promise<PhpvmsPilot | null | undefined>,
  linkPhpvms: (apiKey: string) =>
    Promise.resolve(ipc()?.invoke?.('auth:phpvmsLink', apiKey)) as Promise<PhpvmsLinkResult | undefined>,
  unlinkPhpvms: () => Promise.resolve(ipc()?.invoke?.('auth:phpvmsUnlink')) as Promise<boolean | undefined>,
};

/** The linked crew centre pilot, refreshed when the entitlement changes. */
export function usePilot() {
  const [pilot, setPilot] = useState<PhpvmsPilot | null>(null);

  const refresh = useCallback(async () => {
    setPilot((await account.pilot()) ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    let off: (() => void) | undefined;
    try {
      off = window.ipc?.on?.('entitlements:changed', () => void refresh());
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
  }, [refresh]);

  return { pilot, refresh };
}
