import { useEffect, useState } from 'react';
import { defaultSplashProfile, splashProfiles, SplashProfileId } from '../config/splash';
import { formatBytes, formatRate, updates, useUpdateState } from '../lib/updates';

export default function ServiceIndex() {
  const [version, setVersion] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<SplashProfileId>(defaultSplashProfile.id);
  const update = useUpdateState();

  const profile = splashProfiles[profileId];

  useEffect(() => {
    window.ipc
      .invoke('getSplashProfile')
      .then((value) => {
        if (value === 'emergency' || value === 'military') setProfileId(value);
      })
      .catch(() => undefined);

    window.ipc
      .invoke('getAppVersion')
      .then((value) => setVersion(String(value)))
      .catch(() => setVersion(null));

    // The launch gate. Main resolves 'proceed' for every outcome except an
    // update that is about to restart the app, so a dead update server or a
    // missing feed can never strand anyone on the splash.
    let cancelled = false;
    Promise.resolve(updates.launchCheck())
      .catch(() => 'proceed' as const)
      .then((verdict) => {
        if (!cancelled && verdict !== 'installing') window.ipc.send('openApp', null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const busy = update.phase === 'available' || update.phase === 'downloading';

  const status =
    update.phase === 'checking'
      ? 'Checking for updates'
      : update.phase === 'available'
        ? `Update ${update.newVersion} found`
        : update.phase === 'downloading'
          ? `Downloading update ${update.newVersion}`
          : update.phase === 'installing'
            ? 'Installing update — restarting'
            : 'Initialising console';

  return (
    <div
      className={`splash-stage splash-stage-${profile.lightPattern} relative flex h-screen w-screen flex-col items-center justify-center overflow-hidden text-white`}
      style={
        {
          '--splash-accent': profile.accent,
          '--splash-secondary': profile.secondary,
          '--splash-background': profile.background,
        } as React.CSSProperties
      }
    >
      <div className="splash-lights" aria-hidden="true">
        <span className="splash-beacon splash-beacon-secondary" />
        <span className="splash-beacon splash-beacon-accent" />
        <span className="splash-scan" />
      </div>

      <div className="splash-frame relative z-10 flex flex-col items-center px-8 py-3">
        <div className="mb-2 overflow-hidden rounded-lg ring-1 ring-white/20 shadow-[0_8px_28px_rgba(0,0,0,0.55)]">
          <img
            src="/logo.png"
            alt="Aus Emergency Dispatcher"
            className="block size-[104px] object-cover"
            draggable={false}
          />
        </div>
        <p className="max-w-[20rem] text-center font-mono text-[9px] font-semibold uppercase leading-4 tracking-[0.26em] text-white/45">
          {profile.organisation}
        </p>
        <h1 className="mt-1.5 text-center text-base font-semibold tracking-tight">{profile.title}</h1>
        <p className="mt-0.5 text-center text-[11px] text-white/50">{profile.subtitle}</p>

        {busy || update.phase === 'installing' ? (
          <div className="mt-3 w-[248px]">
            <div className="h-[6px] w-full overflow-hidden rounded-sm bg-white/12 ring-1 ring-white/10">
              <div
                className="h-full rounded-sm transition-[width] duration-200"
                style={{
                  width: `${update.phase === 'installing' ? 100 : update.percent}%`,
                  background: 'var(--splash-accent)',
                }}
              />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[9px] tracking-wide text-white/40">
              <span>{update.phase === 'downloading' ? `${update.percent}%` : 'Preparing'}</span>
              <span>
                {update.total > 0
                  ? `${formatBytes(update.transferred)} / ${formatBytes(update.total)}  ${formatRate(update.bytesPerSecond)}`
                  : ''}
              </span>
            </div>
          </div>
        ) : (
          <div className="splash-loader mt-3" role="progressbar" aria-label="Loading" />
        )}

        {/* Same face as the title and subtitle above — the mono/uppercase
            treatment is reserved for the organisation kicker and the version. */}
        <p className="mt-2 text-center text-[11px] text-white/50">{status}</p>
      </div>

      <p className="absolute bottom-2.5 right-4 z-10 font-mono text-[10px] tracking-wide text-white/30">
        v{version || '…'}
      </p>
    </div>
  );
}
