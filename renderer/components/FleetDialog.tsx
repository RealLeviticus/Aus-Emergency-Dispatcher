import { useMemo, useState } from 'react';
import { useFleet, type FleetBase } from '../lib/fleet';
import { WinDialog } from './WinDialog';

/**
 * "Where is the fleet?" — the aircraft state board.
 *
 * This is the same snapshot the server generates RAAFv tasking from, which is
 * the point of showing it: if Tindal has no jobs on the board, this is where an
 * operator sees that Tindal has no aircraft parked. Airframes away from their
 * home base are listed where they ARE, because that is what tasking goes on.
 */
export function FleetDialog({ onClose }: { onClose: () => void }) {
  const { list, mine, error, busy, refresh } = useFleet();
  const [showEmpty, setShowEmpty] = useState(false);

  const bases = useMemo(() => {
    const all = list?.bases ?? [];
    // Without live data every base reads as empty, so hiding empties would hide
    // the whole board — only filter when there is something to filter by.
    if (showEmpty || list?.source !== 'crew-centre') return all;
    return all.filter((b) => b.aircraft.length > 0);
  }, [list, showEmpty]);

  const live = list?.source === 'crew-centre';

  return (
    <WinDialog
      title="RAAFv fleet — aircraft state board"
      width={720}
      onClose={onClose}
      footer={
        <>
          <span className="text-[11px] text-[#404040]">
            {list
              ? live
                ? `${list.total} airframes · ${list.airborne} airborne · read ${new Date(list.fetchedAt).toLocaleTimeString()}`
                : 'Live fleet positions unavailable — showing the published order of battle.'
              : 'Loading…'}
          </span>
          <button type="button" className="win-btn ml-auto" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Reading…' : 'Refresh'}
          </button>
          <button type="button" className="win-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {error && (
        <p className="win-sunken mb-2 px-2 py-1 text-[11px] text-[#a00000]" role="alert">
          {error}
        </p>
      )}

      {!live && list?.note && (
        <div className="win-sunken mb-2 border-l-4 border-[#a05000] px-2 py-[6px] text-[11px]">
          <b>Not live.</b> {list.note} Tasking still only uses squadrons that are really at each base — it just
          cannot name the individual aircraft.
        </div>
      )}

      {mine && mine.length > 0 && (
        <fieldset className="win-group mb-2 p-2">
          <legend className="px-1">Cleared for you</legend>
          <div className="text-[11px]">
            {mine.map((a) => (
              <div key={a.registration} className="flex items-center gap-2 py-[1px]">
                <span className="w-[86px] font-mono font-bold">{a.registration}</span>
                <span className="flex-1 truncate">{a.type}</span>
                <span className="font-mono">{a.at ?? '—'}</span>
                {a.airborne && <span className="text-[#a05000]">airborne</span>}
                {!a.airborne && a.at && a.home && a.at !== a.home && (
                  <span className="text-[#404040]">away from {a.home}</span>
                )}
              </div>
            ))}
          </div>
        </fieldset>
      )}

      <div className="win-list max-h-[46vh] overflow-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="sticky top-0 bg-[#d4d0c8] text-left">
              <th className="px-2 py-[3px] font-bold">Base</th>
              <th className="w-[54px] px-2 py-[3px] font-bold">ICAO</th>
              <th className="px-2 py-[3px] font-bold">Resident squadrons</th>
              <th className="px-2 py-[3px] font-bold">{live ? 'On the line now' : 'Can be tasked for'}</th>
            </tr>
          </thead>
          <tbody>
            {bases.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-2 py-6 text-center text-[#404040]">
                  {busy ? 'Reading the crew centre…' : 'No fleet data.'}
                </td>
              </tr>
            ) : (
              bases.map((b) => <BaseRow key={b.ident} base={b} live={live} />)
            )}
          </tbody>
        </table>
      </div>

      {live && (
        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-[#404040]">
          <input
            type="checkbox"
            className="win-checkbox"
            checked={showEmpty}
            onChange={(e) => setShowEmpty(e.target.checked)}
          />
          Show bases with nothing parked
        </label>
      )}

      <p className="mt-2 text-[10px] text-[#606060]">
        Read from the RAAF Virtual crew centre. An aircraft already flying someone else&rsquo;s sortie is not
        offered for tasking.
      </p>
    </WinDialog>
  );
}

function BaseRow({ base, live }: { base: FleetBase; live: boolean }) {
  return (
    <tr className="border-b border-[#e6e3de] align-top">
      <td className="px-2 py-[4px]">
        <span className="font-bold">{base.base}</span>
        {base.dry && <span className="ml-1 text-[#606060]">(dry base)</span>}
        <div className="text-[#606060]">{base.region}</div>
      </td>
      <td className="px-2 py-[4px] font-mono">{base.ident}</td>
      <td className="px-2 py-[4px]">
        {base.squadrons.length ? (
          base.squadrons.map((s) => <div key={s}>{s}</div>)
        ) : (
          <span className="text-[#606060]">none — stood up as a detachment</span>
        )}
      </td>
      <td className="px-2 py-[4px]">
        {live ? (
          base.aircraft.length ? (
            base.aircraft.map((a) => (
              <div key={a.registration} className={a.airborne ? 'text-[#808080]' : ''}>
                <span className="font-mono font-bold">{a.registration}</span> {a.type}
                {a.airborne && <span className="ml-1">— airborne</span>}
              </div>
            ))
          ) : (
            <span className="text-[#606060]">nothing parked</span>
          )
        ) : base.roles.length ? (
          <span className="text-[#404040]">{base.roles.join(', ')}</span>
        ) : (
          <span className="text-[#606060]">—</span>
        )}
      </td>
    </tr>
  );
}
