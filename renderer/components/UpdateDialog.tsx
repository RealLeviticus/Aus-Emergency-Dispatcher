import { useEffect, useState } from 'react';
import { formatBytes, formatRate, updates, useUpdateState } from '../lib/updates';
import { WinDialog } from './WinDialog';

/**
 * Win9x-style "check for updates" window (Help ▸ Check for updates), and the
 * place the update banner sends you. The launch-time path lives on the splash;
 * this one never blocks a job — an operator decides when to restart.
 */
export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const state = useUpdateState();
  const [checked, setChecked] = useState(false);

  // Opening the window is itself a request to check, unless one is in flight or
  // an update is already sitting there waiting to be installed.
  useEffect(() => {
    if (checked) return;
    setChecked(true);
    const settled = state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'installing';
    if (!settled) void updates.check();
  }, [checked, state.phase]);

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'available';
  const ready = state.phase === 'downloaded';

  const headline =
    state.phase === 'checking'
      ? 'Checking for updates…'
      : state.phase === 'available'
        ? `Version ${state.newVersion} found`
        : state.phase === 'downloading'
          ? `Downloading version ${state.newVersion}`
          : ready
            ? `Version ${state.newVersion} is ready`
            : state.phase === 'installing'
              ? 'Restarting to install…'
              : state.phase === 'error'
                ? 'Could not check for updates'
                : state.phase === 'disabled'
                  ? 'Updates are off in this build'
                  : `You are up to date`;

  return (
    <WinDialog
      title="Software update"
      width={480}
      onClose={onClose}
      footer={
        <>
          <label className="flex items-center gap-1.5 text-[11px] text-[#303030]">
            <input
              type="checkbox"
              checked={state.channel === 'beta'}
              onChange={(e) => void updates.setChannel(e.target.checked ? 'beta' : 'latest')}
            />
            Get beta builds
          </label>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="win-btn"
              disabled={busy || state.phase === 'installing'}
              onClick={() => void updates.check()}
            >
              Check again
            </button>
            {ready ? (
              <button type="button" className="win-btn is-default" onClick={() => void updates.install()}>
                Restart &amp; install
              </button>
            ) : (
              <button type="button" className="win-btn" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </>
      }
    >
      <>
        <div className="win-sunken mb-2 px-2 py-[6px]">
          <div className="font-bold">{headline}</div>
          <div className="text-[11px] text-[#404040]">
            Installed: <b>{state.currentVersion || '—'}</b>
            {state.channel === 'beta' && <span className="ml-2 text-[#a05000]">beta channel</span>}
            {state.lastCheckedAt && (
              <span className="ml-2 text-[#606060]">
                last checked {new Date(state.lastCheckedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {(state.phase === 'downloading' || state.phase === 'available') && (
          <div className="mb-2">
            <div className="win-sunken h-[14px] w-full p-[2px]">
              <div
                className="h-full transition-[width] duration-200"
                style={{ width: `${state.percent}%`, background: '#000080' }}
              />
            </div>
            <div className="mt-[2px] flex justify-between text-[11px] text-[#404040]">
              <span>{state.percent}%</span>
              <span>
                {state.total > 0
                  ? `${formatBytes(state.transferred)} of ${formatBytes(state.total)}  ${formatRate(state.bytesPerSecond)}`
                  : 'Starting…'}
              </span>
            </div>
          </div>
        )}

        {ready && (
          <p className="mb-2">
            The update installs when the console closes. Restart now if you are not on a job — it takes a few seconds
            and reopens straight back here.
          </p>
        )}

        {state.phase === 'error' && (
          <p className="mb-2 text-[#a00000]">
            {state.error}
            <br />
            <span className="text-[#404040]">The console works normally; it will try again on the next launch.</span>
          </p>
        )}

        {state.releaseNotes && (ready || state.phase === 'downloading' || state.phase === 'available') && (
          <fieldset className="win-group p-2">
            <legend className="px-1">What&rsquo;s new in {state.newVersion}</legend>
            <div className="win-sunken max-h-[160px] overflow-y-auto whitespace-pre-wrap px-2 py-1 text-[11px]">
              {state.releaseNotes}
            </div>
          </fieldset>
        )}
      </>
    </WinDialog>
  );
}

/**
 * One-line strip above the console when an update is waiting. Deliberately
 * quiet — it must never pull attention off a live job.
 */
export function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  const state = useUpdateState();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || state.phase !== 'downloaded') return null;

  return (
    <div className="flex items-center gap-2 border-b border-[#808080] bg-[#ffffe1] px-2 py-[3px] text-[11px] text-black">
      <span className="font-bold">Update ready</span>
      <span>Version {state.newVersion} has downloaded. It installs when you close the console, or restart now.</span>
      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" className="win-btn px-2 py-0" onClick={onOpen}>
          Details
        </button>
        <button type="button" className="win-btn px-2 py-0" onClick={() => void updates.install()}>
          Restart now
        </button>
        <button type="button" className="win-btn px-2 py-0" onClick={() => setDismissed(true)} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}
