import { useCallback, useEffect, useState } from 'react';
import { isMuted, setMuted } from '../lib/audio';
import { account } from '../lib/account';
import { sim } from '../lib/sim';
import { updates, useUpdateState } from '../lib/updates';
import type { SplashProfileId } from '../config/splash';

/**
 * Win9x options window — the one place for preferences that were previously
 * scattered across three menus, or had no interface at all.
 *
 * Replaces the orphaned `/settings` Next page, which nothing linked to and which
 * was drawn in a completely different visual language. Three of the settings
 * below (always-on-top, splash profile, open app-data folder) had working main
 * process handlers and no UI whatsoever until this existed.
 */
export function OptionsDialog({ onClose }: { onClose: () => void }) {
  const [muted, setMutedUi] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [profile, setProfile] = useState<SplashProfileId>('emergency');
  const [packPrompt, setPackPrompt] = useState(true);
  const [raafv, setRaafv] = useState(false);
  const update = useUpdateState();

  useEffect(() => {
    setMutedUi(isMuted());
    Promise.resolve(window.ipc?.invoke?.('getSplashProfile'))
      .then((v) => (v === 'emergency' || v === 'military') && setProfile(v))
      .catch(() => undefined);
    Promise.resolve(sim.addonPromptSuppressed())
      .then((v) => setPackPrompt(v !== true))
      .catch(() => undefined);
    Promise.resolve(account.raafvOverride())
      .then((v) => setRaafv(v === true))
      .catch(() => undefined);
  }, []);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMutedUi(next);
    setMuted(next);
  }, [muted]);

  const toggleOnTop = useCallback(() => {
    const next = !onTop;
    setOnTop(next);
    void window.ipc?.invoke?.('window:setAlwaysOnTop', next);
  }, [onTop]);

  const chooseProfile = useCallback((p: SplashProfileId) => {
    setProfile(p);
    void window.ipc?.invoke?.('setSplashProfile', p);
  }, []);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className="win-window flex max-h-[88vh] w-[560px] flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Options"
      >
        <div className="win-titlebar flex items-center justify-between px-2 py-[2px]">
          <span className="font-bold">Options</span>
          <button type="button" className="win-titlebar-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px] leading-snug">
          <fieldset className="win-group mb-2 p-2">
            <legend className="px-1">Console</legend>
            <label className="flex items-center gap-2 py-[2px]">
              <input type="checkbox" checked={muted} onChange={toggleMute} />
              Mute alert sounds
              <span className="text-[11px] text-[#606060]">— alerts only sound once you&rsquo;re on duty</span>
            </label>
            <label className="flex items-center gap-2 py-[2px]">
              <input type="checkbox" checked={onTop} onChange={toggleOnTop} />
              Keep the console on top
              <span className="text-[11px] text-[#606060]">— stays above the simulator window</span>
            </label>
            <label className="flex items-center gap-2 py-[2px]">
              <input
                type="checkbox"
                checked={packPrompt}
                onChange={(e) => {
                  setPackPrompt(e.target.checked);
                  void sim.addonSuppressPrompt(!e.target.checked);
                }}
              />
              Show the scene-pack setup prompt at startup
            </label>
          </fieldset>

          <fieldset className="win-group mb-2 p-2">
            <legend className="px-1">Startup screen</legend>
            <div className="flex gap-4">
              {(
                [
                  ['emergency', 'Emergency services'],
                  ['military', 'RAAFv / military'],
                ] as [SplashProfileId, string][]
              ).map(([id, label]) => (
                <label key={id} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="splash-profile"
                    checked={profile === id}
                    onChange={() => chooseProfile(id)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-[#606060]">Takes effect the next time the app starts.</p>
          </fieldset>

          <fieldset className="win-group mb-2 p-2">
            <legend className="px-1">Updates</legend>
            <div className="flex flex-wrap items-center gap-2">
              <span>
                Installed <b>{update.currentVersion || '—'}</b>
              </span>
              <label className="ml-2 flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={update.channel === 'beta'}
                  onChange={(e) => void updates.setChannel(e.target.checked ? 'beta' : 'latest')}
                />
                Get beta builds
              </label>
              <button
                type="button"
                className="win-btn ml-auto px-3 py-0"
                disabled={update.phase === 'checking' || update.phase === 'downloading'}
                onClick={() => void updates.check()}
              >
                Check now
              </button>
            </div>
            {update.phase === 'downloaded' && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-[#006000]">Version {update.newVersion} is ready.</span>
                <button type="button" className="win-btn px-3 py-0" onClick={() => void updates.install()}>
                  Restart &amp; install
                </button>
              </div>
            )}
          </fieldset>

          <fieldset className="win-group mb-2 p-2">
            <legend className="px-1">Files</legend>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="win-btn px-3 py-0"
                onClick={() => void window.ipc?.invoke?.('app:openDataFolder')}
                title="Routes, credits, scene-title overrides and the AddonPacks drop folder"
              >
                Open data folder
              </button>
              <button
                type="button"
                className="win-btn px-3 py-0"
                onClick={() => void window.ipc?.invoke?.('app:openUserData')}
                title="Settings, operator accounts and logs"
              >
                Open app data
              </button>
              <button
                type="button"
                className="win-btn px-3 py-0"
                onClick={() => void window.ipc?.invoke?.('packages:openCommunity')}
              >
                Open MSFS Community folder
              </button>
            </div>
          </fieldset>

          <fieldset className="win-group p-2">
            <legend className="px-1">Testing</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={raafv}
                onChange={(e) => {
                  setRaafv(e.target.checked);
                  void account.setRaafvOverride(e.target.checked);
                }}
              />
              Unlock RAAFv Tasking without signing in
            </label>
            <p className="mt-1 text-[11px] text-[#606060]">
              Developer switch for FSLTL and tasking tests. Leave it off — RAAFv should be unlocked by signing in with
              your crew centre account from the operator menu.
            </p>
          </fieldset>
        </div>

        <div className="flex justify-end border-t border-[#808080] p-2">
          <button type="button" className="win-btn px-4 py-[2px]" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
