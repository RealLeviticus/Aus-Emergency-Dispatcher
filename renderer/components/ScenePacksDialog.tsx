import { useCallback, useEffect, useState } from 'react';
import { sim, type AddonStatus } from '../lib/sim';
import { WinDialog } from './WinDialog';

/**
 * Win9x-style dialog for getting the free flightsim.to scene-object packs
 * (30West HEMS Objects, HPG H145 Action Pack) into the MSFS Community folder.
 *
 * We can't ship or download these — their licences forbid redistribution — so
 * this walks the user through: download each ZIP → drop it in the AddonPacks
 * folder → the app extracts it into every Community folder.
 */
export function ScenePacksDialog({
  onClose,
  firstRun = false,
}: {
  onClose: () => void;
  /** shown automatically on launch because a required pack is missing */
  firstRun?: boolean;
}) {
  const [status, setStatus] = useState<AddonStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dontShow, setDontShow] = useState(false);

  const refresh = useCallback(async () => {
    const s = await sim.addonStatus();
    if (s) setStatus(s);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const close = useCallback(() => {
    if (firstRun) void sim.addonSuppressPrompt(dontShow);
    onClose();
  }, [firstRun, dontShow, onClose]);

  const install = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await sim.addonInstall();
      setNote(res?.message ?? 'Install attempted.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const zipCount = status?.zips.length ?? 0;
  const communities = status?.communityFolders ?? [];

  return (
    <WinDialog
      title={firstRun ? 'Set up scene objects before you fly' : 'Scene object packs'}
      width={620}
      onClose={close}
      footer={
        <>
          {firstRun ? (
            <label className="flex items-center gap-1.5 text-[11px] text-[#303030]">
              <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
              Don&rsquo;t show this on startup again
            </label>
          ) : (
            <span />
          )}
          <button type="button" className="win-btn ml-auto" onClick={close}>
            {firstRun ? 'Continue' : 'Close'}
          </button>
        </>
      }
    >
      <>
        {firstRun && (
          <div className="win-sunken mb-2 border-l-4 border-[#a05000] px-2 py-[6px] text-[11px]">
            <b>Some scene object packs aren&rsquo;t installed yet.</b> Without them the dispatcher falls back to basic
            shapes at MVA, rescue and fire jobs. Set them up now, then fully restart MSFS — you only do this once.
          </div>
        )}
        <p className="mb-2">
          The dispatcher drops real vehicles, wrecks, crew, patients, fire and smoke at each job. Those props come from
          a few free <b>flightsim.to</b> packs. Their licences don&rsquo;t let this app bundle or download them, so
          it&rsquo;s a one-time manual step:
        </p>
        <ol className="mb-3 ml-5 list-decimal space-y-[2px]">
          <li>
            Open the packs folder and read the note there, then download each ZIP from flightsim.to (sign in first).
          </li>
          <li>
            Drop the ZIP files into that folder — <i>no need to unzip</i>.
          </li>
          <li>
            Click <b>Install downloaded packs</b> below (the app also does this automatically on startup).
          </li>
          <li>Fully restart MSFS so the sim loads the new packages.</li>
        </ol>

        <div className="mb-2 flex flex-wrap gap-2">
          <button type="button" className="win-btn" onClick={() => void sim.addonOpenFolder()}>
            Open packs folder
          </button>
          <button type="button" className="win-btn is-default" disabled={busy} onClick={() => void install()}>
            {busy
              ? 'Installing…'
              : `Install downloaded packs${zipCount ? ` (${zipCount} ZIP${zipCount > 1 ? 's' : ''})` : ''}`}
          </button>
          <button type="button" className="win-btn" disabled={busy} onClick={() => void refresh()}>
            Rescan
          </button>
        </div>

        <div className="win-sunken win-path mb-2 px-2 py-1 text-[11px]">
          {communities.length === 0 ? (
            <span className="text-[#a00000]">No MSFS Community folder detected — start MSFS once, then Rescan.</span>
          ) : (
            <span>
              Community folder{communities.length > 1 ? 's' : ''}: {communities.join('  ·  ')}
            </span>
          )}
        </div>

        <fieldset className="win-group p-2">
          <legend className="px-1">Packs</legend>
          <div className="space-y-2">
            {(status?.packs ?? []).map((p) => (
              <div key={p.id} className="win-sunken px-2 py-[6px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold">
                    {p.name}
                    {!p.required && <span className="ml-1 font-normal text-[#404040]">(optional)</span>}
                  </span>
                  <span className={p.installed ? 'text-[#006000]' : p.partial ? 'text-[#a05000]' : 'text-[#a00000]'}>
                    {p.installed ? '● installed' : p.partial ? '◐ partly installed' : '○ not installed'}
                  </span>
                </div>
                <div className="text-[11px] text-[#303030]">{p.usedFor}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  <button type="button" className="win-btn px-2" onClick={() => void sim.addonOpenUrl(p.url)}>
                    Open page
                  </button>
                  <span className="text-[#606060]">by {p.author}</span>
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        {note && <div className="win-sunken mt-2 px-2 py-1 text-[11px]">{note}</div>}

        <p className="mt-2 text-[10px] text-[#606060]">
          Packs stay under their authors&rsquo; own licences and copyright. This app never re-hosts or redistributes
          them; it only extracts the copies you download.
        </p>
      </>
    </WinDialog>
  );
}
