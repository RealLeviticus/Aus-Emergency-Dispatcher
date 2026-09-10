import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';
import { SplashProfileId } from '../config/splash';
import DispatchConsole from '../components/DispatchConsole';
import { ScenePacksDialog } from '../components/ScenePacksDialog';
import { account } from '../lib/account';
import { sim } from '../lib/sim';

type AppId = 'emergency' | 'raafv';

type AppDef = {
  id: AppId;
  profileId: SplashProfileId;
  name: string;
  short: string;
  color: string;
  logoSrc?: string;
  entitlement: 'emergency' | 'raafv';
};

const APPS: AppDef[] = [
  {
    id: 'emergency',
    profileId: 'emergency',
    name: 'Aus Emergency Dispatcher',
    short: 'AED',
    color: '#c0392b',
    logoSrc: '/logo-mark.png',
    entitlement: 'emergency',
  },
  {
    id: 'raafv',
    profileId: 'military',
    name: 'RAAFv Tasking Dispatcher',
    short: 'RAAFv',
    color: '#2e5a2e',
    entitlement: 'raafv',
  },
];

type Entitlements = { emergency?: boolean; raafv?: boolean };

function AppIcon({
  short,
  color,
  size = 16,
  logoSrc,
}: {
  short: string;
  color: string;
  size?: number;
  logoSrc?: string;
}) {
  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        className="inline-block shrink-0 bg-slate-950"
        style={{
          width: size,
          height: size,
          border: '1px solid rgba(0,0,0,0.45)',
        }}
        draggable={false}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center font-bold text-white"
      style={{
        width: size,
        height: size,
        background: color,
        border: '1px solid rgba(0,0,0,0.45)',
        fontSize: Math.round(size * 0.4),
        letterSpacing: '-0.04em',
      }}
    >
      {short.slice(0, 3).toUpperCase()}
    </span>
  );
}

function winControl(action: 'minimize' | 'maximize' | 'close') {
  try {
    window.ipc?.send?.('windowControl', action);
  } catch {
    /* running outside Electron */
  }
}

export default function Home() {
  // Optimistic: both windows open. Real gating (getEntitlements → raafv:false) can revoke.
  const [entitlements, setEntitlements] = useState<Entitlements>({ emergency: true, raafv: true });
  const [activeId, setActiveId] = useState<AppId>('emergency');
  const [startOpen, setStartOpen] = useState(false);
  const [clock, setClock] = useState('');
  const [raafvOverride, setRaafvOverrideState] = useState(false);
  const [packPrompt, setPackPrompt] = useState(false);

  // On launch, if a required scene-object pack is missing (and the user hasn't
  // opted out), show the setup dialog so they can install packs before flying.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [suppressed, status] = await Promise.all([sim.addonPromptSuppressed(), sim.addonStatus()]);
        if (!cancelled && suppressed !== true && status && !status.ready) setPackPrompt(true);
      } catch {
        /* not running in Electron */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    Promise.resolve(account.raafvOverride())
      .then((v) => setRaafvOverrideState(v === true))
      .catch(() => undefined);
  }, []);
  const toggleRaafvOverride = async () => {
    const next = !raafvOverride;
    setRaafvOverrideState(next);
    await account.setRaafvOverride(next); // fires 'entitlements:changed' -> reload below
  };

  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const demo = params?.get('demo') ?? undefined;

  useEffect(() => {
    const load = () =>
      Promise.resolve(window.ipc?.invoke?.('getEntitlements'))
        .then((v) => {
          if (v && typeof v === 'object') setEntitlements(v as Entitlements);
          else setEntitlements({ emergency: true, raafv: false });
        })
        .catch(() => setEntitlements({ emergency: true, raafv: false }));
    load();
    let off: (() => void) | undefined;
    try {
      off = window.ipc?.on?.('entitlements:changed', () => load());
    } catch {
      /* not electron */
    }

    const appParam = new URLSearchParams(window.location.search).get('app');
    if (appParam === 'raafv') {
      setActiveId('raafv');
    } else {
      Promise.resolve(window.ipc?.invoke?.('getSplashProfile'))
        .then((v) => {
          if (v === 'military') setActiveId('raafv');
        })
        .catch(() => undefined);
    }
    return () => {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }));
    tick();
    const id = window.setInterval(tick, 15000);
    return () => window.clearInterval(id);
  }, []);

  const openApps = useMemo(() => APPS.filter((a) => entitlements[a.entitlement] !== false), [entitlements]);

  // Derived, not corrected in an effect: if the selected app is revoked (RAAFv
  // entitlement lost) we simply fall back while rendering, instead of setting
  // state from an effect and forcing a second render pass.
  const activeApp = openApps.find((a) => a.id === activeId) ?? openApps[0] ?? APPS[0];

  return (
    <>
      <Head>
        <title>{activeApp.name}</title>
      </Head>

      <div
        className="y2k relative flex h-full w-full flex-col overflow-hidden"
        style={{ background: 'radial-gradient(120% 90% at 50% 0%, #2a4d6b 0%, #16283a 55%, #0d1a26 100%)' }}
      >
        {/* Application window — this IS the app's frame (Electron window is frameless) */}
        <div className="win-window m-[3px] flex min-h-0 flex-1 flex-col">
          <div className="win-titlebar titlebar">
            <AppIcon short={activeApp.short} color={activeApp.color} logoSrc={activeApp.logoSrc} size={16} />
            <span className="flex-1 truncate">{activeApp.name} — Live Dispatch</span>
            <button
              type="button"
              className="win-titlebar-btn titlebar-button"
              aria-label="Minimize"
              onClick={() => winControl('minimize')}
            >
              _
            </button>
            <button
              type="button"
              className="win-titlebar-btn titlebar-button"
              aria-label="Maximize"
              onClick={() => winControl('maximize')}
            >
              {'□'}
            </button>
            <button
              type="button"
              className="win-titlebar-btn titlebar-button"
              aria-label="Close"
              onClick={() => winControl('close')}
            >
              {'✕'}
            </button>
          </div>

          {/* Each entitled app stays mounted; only the active one is shown */}
          <div className="flex min-h-0 flex-1 flex-col">
            {openApps.map((a) => (
              <div
                key={a.id}
                className={a.id === activeId ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
                aria-hidden={a.id !== activeId}
              >
                <DispatchConsole profileId={a.profileId} demo={a.id === activeId ? demo : undefined} />
              </div>
            ))}
          </div>
        </div>

        {/* Taskbar — one button per open app */}
        <div className="win-taskbar titlebar-button">
          <button
            type="button"
            className={`win-startbtn ${startOpen ? 'is-open' : ''}`}
            onClick={() => setStartOpen((o) => !o)}
          >
            <span className="win-flag" aria-hidden="true" />
            Start
          </button>

          <span className="mx-1 h-5 w-[2px]" style={{ background: '#808080', boxShadow: '1px 0 0 #fff' }} />

          {openApps.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`win-taskitem ${a.id === activeId ? 'is-active' : ''}`}
              onClick={() => setActiveId(a.id)}
            >
              <AppIcon short={a.short} color={a.color} logoSrc={a.logoSrc} size={14} />
              <span className="max-w-[190px] truncate">{a.name}</span>
            </button>
          ))}

          {!entitlements.raafv && (
            <button
              type="button"
              className="win-taskitem"
              style={{ opacity: 0.7 }}
              title="Locked — needs RAAFv Discord role. Click to unlock locally for testing (FSLTL / tasking)."
              onClick={toggleRaafvOverride}
            >
              <span
                className="inline-block h-3.5 w-3.5"
                style={{ background: '#8a8a8a', border: '1px solid #5a5a5a' }}
                aria-hidden="true"
              />
              RAAFv Tasking (locked — click to unlock)
            </button>
          )}

          <div className="win-tasktray">{clock}</div>
        </div>

        {startOpen && (
          <div
            className="win-window absolute bottom-[32px] left-[3px] w-[240px] p-1"
            style={{ zIndex: 50 }}
            onMouseLeave={() => setStartOpen(false)}
          >
            <div className="flex">
              <div
                className="flex w-6 shrink-0 items-end justify-center pb-2 font-bold text-white"
                style={{
                  writingMode: 'vertical-rl',
                  transform: 'rotate(180deg)',
                  background: 'linear-gradient(#000080,#1084d0)',
                }}
              >
                Dispatch OS
              </div>
              <ul className="flex-1">
                {openApps.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#000080] hover:text-white"
                      onClick={() => {
                        setActiveId(a.id);
                        setStartOpen(false);
                      }}
                    >
                      <AppIcon short={a.short} color={a.color} logoSrc={a.logoSrc} size={18} />
                      {a.name}
                    </button>
                  </li>
                ))}
                <li className="my-1 border-t border-[#808080]" />
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#000080] hover:text-white"
                    onClick={() => {
                      void toggleRaafvOverride();
                      setStartOpen(false);
                    }}
                    title="Enable the RAAFv Tasking Dispatcher without a Discord link, for testing"
                  >
                    <span
                      className="inline-block h-[18px] w-[18px]"
                      style={{ background: raafvOverride ? '#2e5a2e' : '#808080', border: '1px solid #5a5a5a' }}
                      aria-hidden="true"
                    />
                    RAAFv local unlock: {raafvOverride ? 'ON' : 'OFF'}
                  </button>
                </li>
                <li className="my-1 border-t border-[#808080]" />
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#000080] hover:text-white"
                    onClick={() => {
                      setStartOpen(false);
                      winControl('close');
                    }}
                  >
                    <span className="inline-block h-[18px] w-[18px] bg-[#808080]" aria-hidden="true" />
                    Shut Down…
                  </button>
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {packPrompt && <ScenePacksDialog firstRun onClose={() => setPackPrompt(false)} />}
    </>
  );
}
