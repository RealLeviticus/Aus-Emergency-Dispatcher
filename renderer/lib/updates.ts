import { useEffect, useState } from 'react';

/** Mirrors UpdateState in main/updater.ts. */
export type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export type UpdateChannel = 'latest' | 'beta';

export type UpdateState = {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  error: string | null;
  channel: UpdateChannel;
  gating: boolean;
  lastCheckedAt: number | null;
};

export const IDLE_UPDATE_STATE: UpdateState = {
  phase: 'idle',
  currentVersion: '',
  newVersion: null,
  releaseNotes: null,
  releaseDate: null,
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  error: null,
  channel: 'latest',
  gating: false,
  lastCheckedAt: null,
};

export const updates = {
  getState: () => window.ipc?.invoke?.('update:getState') as Promise<UpdateState> | undefined,
  check: () => window.ipc?.invoke?.('update:check') as Promise<UpdateState> | undefined,
  install: () => window.ipc?.invoke?.('update:install') as Promise<UpdateState> | undefined,
  setChannel: (c: UpdateChannel) => window.ipc?.invoke?.('update:setChannel', c) as Promise<UpdateState> | undefined,
  /** Only the splash calls this - it is what holds the app back on launch. */
  launchCheck: () => window.ipc?.invoke?.('update:launchCheck') as Promise<'proceed' | 'installing'> | undefined,
};

/** Live update state, seeded from main and kept current by 'update:state'. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>(IDLE_UPDATE_STATE);

  useEffect(() => {
    let alive = true;
    Promise.resolve(updates.getState())
      .then((s) => {
        if (alive && s) setState(s);
      })
      .catch(() => undefined);

    let off: (() => void) | undefined;
    try {
      off = window.ipc?.on?.('update:state', (next) => setState(next as UpdateState));
    } catch {
      /* not running in Electron */
    }
    return () => {
      alive = false;
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return state;
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 MB';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!bytesPerSecond) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** One line describing where the updater is up to, for a status strip. */
export function updateSummary(s: UpdateState): string {
  switch (s.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Version ${s.newVersion} found — preparing download…`;
    case 'downloading':
      return `Downloading ${s.newVersion} — ${s.percent}%`;
    case 'downloaded':
      return `Version ${s.newVersion} is ready to install`;
    case 'installing':
      return 'Installing update — the app will restart';
    case 'up-to-date':
      return `Up to date (${s.currentVersion})`;
    case 'error':
      return `Update check failed — ${s.error ?? 'unknown error'}`;
    case 'disabled':
      return 'Updates are off in a development build';
    default:
      return '';
  }
}
