import { useCallback, useEffect, useState } from 'react';

export type Account = {
  id: string;
  name: string;
  callsign: string;
  role: string;
  createdAt: number;
  lastSeenAt: number;
  discord?: { id: string; username: string; avatar: string | null };
  phpvms?: { id: string; ident: string | null; username: string; rank: string | null };
  entitlements?: { raafv?: boolean; raafvVia?: { discord?: boolean; phpvms?: boolean } };
};

export type DiscordLinkResult = {
  ok: boolean;
  error?: string;
  raafv?: boolean;
  roleReason?: string;
  user?: { id: string; username: string; avatar: string | null };
};

export type PhpvmsConfig = { configured: boolean; name: string; url: string; profileUrl: string };

export type PhpvmsLinkResult = {
  ok: boolean;
  error?: string;
  raafv?: boolean;
  roleReason?: string;
  user?: { id: string; ident: string | null; username: string; rank: string | null; avatar: string | null };
};

const ipc = () => (typeof window !== 'undefined' ? window.ipc : undefined);

export const account = {
  list: () => Promise.resolve(ipc()?.invoke?.('account:list')) as Promise<Account[] | undefined>,
  current: () => Promise.resolve(ipc()?.invoke?.('account:current')) as Promise<Account | null | undefined>,
  create: (input: { name: string; callsign?: string; role?: string }) =>
    Promise.resolve(ipc()?.invoke?.('account:create', input)) as Promise<Account | undefined>,
  update: (id: string, patch: { name?: string; callsign?: string; role?: string }) =>
    Promise.resolve(ipc()?.invoke?.('account:update', id, patch)) as Promise<Account | undefined>,
  switch: (id: string | null) =>
    Promise.resolve(ipc()?.invoke?.('account:switch', id)) as Promise<Account | null | undefined>,
  remove: (id: string) => Promise.resolve(ipc()?.invoke?.('account:delete', id)) as Promise<Account[] | undefined>,
  discordConfigured: () => Promise.resolve(ipc()?.invoke?.('auth:discordConfigured')) as Promise<boolean | undefined>,
  linkDiscord: () => Promise.resolve(ipc()?.invoke?.('auth:discordLink')) as Promise<DiscordLinkResult | undefined>,
  unlinkDiscord: () => Promise.resolve(ipc()?.invoke?.('auth:discordUnlink')) as Promise<Account | null | undefined>,
  phpvmsConfig: () => Promise.resolve(ipc()?.invoke?.('auth:phpvmsConfig')) as Promise<PhpvmsConfig | null | undefined>,
  linkPhpvms: (apiKey: string) =>
    Promise.resolve(ipc()?.invoke?.('auth:phpvmsLink', apiKey)) as Promise<PhpvmsLinkResult | undefined>,
  unlinkPhpvms: () => Promise.resolve(ipc()?.invoke?.('auth:phpvmsUnlink')) as Promise<Account | null | undefined>,
};

/** Current operator + the roster, with helpers that keep both in sync. */
export function useAccount() {
  const [current, setCurrent] = useState<Account | null>(null);
  const [roster, setRoster] = useState<Account[]>([]);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const [c, l] = await Promise.all([account.current(), account.list()]);
    setCurrent(c ?? null);
    setRoster(Array.isArray(l) ? l : []);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (id: string) => {
      await account.switch(id);
      await refresh();
    },
    [refresh],
  );
  const signOut = useCallback(async () => {
    await account.switch(null);
    await refresh();
  }, [refresh]);
  const createAndUse = useCallback(
    async (input: { name: string; callsign?: string; role?: string }) => {
      await account.create(input);
      await refresh();
    },
    [refresh],
  );
  const save = useCallback(
    async (id: string, patch: { name?: string; callsign?: string; role?: string }) => {
      await account.update(id, patch);
      await refresh();
    },
    [refresh],
  );
  const remove = useCallback(
    async (id: string) => {
      await account.remove(id);
      await refresh();
    },
    [refresh],
  );
  const linkDiscord = useCallback(async () => {
    const r = await account.linkDiscord();
    await refresh();
    return r;
  }, [refresh]);
  const unlinkDiscord = useCallback(async () => {
    await account.unlinkDiscord();
    await refresh();
  }, [refresh]);
  const linkPhpvms = useCallback(
    async (apiKey: string) => {
      const r = await account.linkPhpvms(apiKey);
      await refresh();
      return r;
    },
    [refresh],
  );
  const unlinkPhpvms = useCallback(async () => {
    await account.unlinkPhpvms();
    await refresh();
  }, [refresh]);

  return {
    current,
    roster,
    ready,
    refresh,
    signIn,
    signOut,
    createAndUse,
    save,
    remove,
    linkDiscord,
    unlinkDiscord,
    linkPhpvms,
    unlinkPhpvms,
  };
}
