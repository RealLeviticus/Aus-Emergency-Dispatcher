import { useEffect, useState } from 'react';
import { account as accountApi, type PhpvmsConfig, type PhpvmsLinkResult } from '../lib/account';

/**
 * RAAFv sign-in. phpVMS gives every pilot an API key on their own profile, so
 * this is the whole flow: paste it once, we ask the crew centre who it belongs
 * to. Deliberately says where the key lives and what happens to it — people are
 * right to be wary of pasting a credential into a third-party app.
 */
export function CrewCentreDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (apiKey: string) => Promise<PhpvmsLinkResult | undefined>;
}) {
  const [cfg, setCfg] = useState<PhpvmsConfig | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void accountApi.phpvmsConfig().then((c) => {
      if (live) setCfg(c ?? null);
    });
    return () => {
      live = false;
    };
  }, []);

  const name = cfg?.name ?? 'RAAF Virtual';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div className="win-window w-[420px]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="win-titlebar">
          <span className="flex-1">Sign in with {name}</span>
          <button type="button" className="win-titlebar-btn" aria-label="Close" onClick={onClose}>
            {'✕'}
          </button>
        </div>
        <form
          className="space-y-2 p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!key.trim() || busy) return;
            setBusy(true);
            setError(null);
            const r = await onSubmit(key.trim());
            setBusy(false);
            if (!r?.ok) {
              setError(r?.error ?? 'Sign-in failed.');
              return;
            }
            if (!r.raafv) {
              setError(`Signed in, but RAAFv tasking was not granted (${r.roleReason ?? 'unknown reason'}).`);
              return;
            }
            onClose();
          }}
        >
          <p className="text-[#404040]">
            Use your existing {name} crew centre account — no new login. Your API key is on your crew centre profile
            page.
          </p>
          <label className="flex items-center gap-2">
            <span className="w-[64px] shrink-0 text-right text-[#404040]">API key</span>
            <input
              autoFocus
              type="password"
              className="win-sunken min-w-0 flex-1 px-2 py-[3px] font-mono"
              value={key}
              onChange={(e) => (setKey(e.target.value), setError(null))}
              placeholder="paste it here"
              maxLength={128}
              spellCheck={false}
            />
          </label>
          {cfg?.profileUrl && (
            <p className="pl-[72px] text-[11px] text-[#404040]">
              <a className="underline" href={cfg.profileUrl} target="_blank" rel="noreferrer">
                Open my crew centre profile
              </a>
            </p>
          )}
          <p className="pl-[72px] text-[11px] text-[#404040]">
            The key is stored encrypted on this PC and only ever sent to {name}. To revoke access, regenerate it on your
            profile.
          </p>
          {error && (
            <p className="win-sunken px-2 py-1 text-[11px] text-[#a00000]" role="alert">
              {error}
            </p>
          )}
          <div
            className="flex items-center gap-2 border-t-2 border-[#808080] pt-2"
            style={{ boxShadow: '0 1px 0 #fff inset' }}
          >
            <button type="submit" className="win-btn is-default" disabled={!key.trim() || busy}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button type="button" className="win-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

