import { useEffect, useRef, useState } from 'react';
import type { Account } from '../lib/account';

type AccountApi = {
  current: Account | null;
  roster: Account[];
  signIn: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
  createAndUse: (input: { name: string; callsign?: string; role?: string }) => Promise<void>;
  save: (id: string, patch: { name?: string; callsign?: string; role?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  linkDiscord: () => Promise<{ ok: boolean; error?: string; raafv?: boolean; roleReason?: string } | undefined>;
  unlinkDiscord: () => Promise<void>;
};

/** Person icon + operator menu, sits in the status bar next to the clock. */
export function AccountBadge({ account }: { account: AccountApi }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | { mode: 'new' | 'edit'; id?: string }>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const cur = account.current;
  const label = cur ? cur.callsign || cur.name : 'Sign in';

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        // sits on the blue status bar, so hover lifts with a wash rather than navy-on-navy
        className="flex items-center gap-1 px-1 hover:bg-white/25"
        title={cur ? `${cur.name}${cur.role ? ` · ${cur.role}` : ''}` : 'No operator signed in'}
        onClick={() => setOpen((o) => !o)}
      >
        <PersonGlyph />
        <span className="max-w-[120px] truncate">{label}</span>
      </button>

      {open && (
        <div
          className="win-raised absolute bottom-full right-0 z-50 mb-1 min-w-[210px] py-1"
          style={{ background: 'var(--w-face, #d4d0c8)' }}
        >
          {cur && (
            <div className="px-3 py-1 text-[11px] text-[#404040]">
              Signed in as <b className="text-black">{cur.name}</b>
              {cur.callsign ? ` (${cur.callsign})` : ''}
              <div>
                RAAFv:{' '}
                <b className={cur.entitlements?.raafv ? 'text-[#1a6a1a]' : 'text-[#404040]'}>
                  {cur.entitlements?.raafv ? 'granted' : 'not linked'}
                </b>
                {cur.discord ? ` · ${cur.discord.username}` : ''}
              </div>
            </div>
          )}
          {account.roster
            .filter((a) => a.id !== cur?.id)
            .map((a) => (
              <MenuRow key={a.id} onClick={() => (setOpen(false), account.signIn(a.id))}>
                Switch to {a.name}
                {a.callsign ? ` (${a.callsign})` : ''}
              </MenuRow>
            ))}
          <div className="my-1 border-t border-[#808080]" style={{ boxShadow: '0 1px 0 #fff' }} />
          {cur && (
            <MenuRow onClick={() => (setOpen(false), setDialog({ mode: 'edit', id: cur.id }))}>Edit profile…</MenuRow>
          )}
          {cur &&
            (cur.discord ? (
              <MenuRow onClick={() => (setOpen(false), account.unlinkDiscord())}>Unlink Discord</MenuRow>
            ) : (
              <MenuRow
                onClick={async () => {
                  setOpen(false);
                  const r = await account.linkDiscord();
                  if (r && !r.ok) alert(r.error ?? 'Discord sign-in failed.');
                  else if (r && r.ok && !r.raafv) alert(`Discord linked, but RAAFv access not granted (${r.roleReason ?? 'no role'}).`);
                }}
              >
                Link Discord for RAAFv…
              </MenuRow>
            ))}
          <MenuRow onClick={() => (setOpen(false), setDialog({ mode: 'new' }))}>New operator…</MenuRow>
          {cur && <MenuRow onClick={() => (setOpen(false), account.signOut())}>Sign out</MenuRow>}
        </div>
      )}

      {dialog && (
        <AccountDialog
          mode={dialog.mode}
          account={dialog.mode === 'edit' ? account.roster.find((a) => a.id === dialog.id) ?? null : null}
          onClose={() => setDialog(null)}
          onSubmit={async (vals) => {
            if (dialog.mode === 'edit' && dialog.id) await account.save(dialog.id, vals);
            else await account.createAndUse(vals);
            setDialog(null);
          }}
          onDelete={
            dialog.mode === 'edit' && dialog.id
              ? async () => {
                  await account.remove(dialog.id!);
                  setDialog(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function MenuRow({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="block w-full px-3 py-[3px] text-left hover:bg-[#000080] hover:text-white"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PersonGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      <circle cx="6" cy="3.4" r="2.4" fill="currentColor" />
      <path d="M1.2 11c0-2.7 2.1-4.3 4.8-4.3S10.8 8.3 10.8 11z" fill="currentColor" />
    </svg>
  );
}

function AccountDialog({
  mode,
  account,
  onClose,
  onSubmit,
  onDelete,
}: {
  mode: 'new' | 'edit';
  account: Account | null;
  onClose: () => void;
  onSubmit: (v: { name: string; callsign: string; role: string }) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(account?.name ?? '');
  const [callsign, setCallsign] = useState(account?.callsign ?? '');
  const [role, setRole] = useState(account?.role ?? '');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div className="win-window w-[360px]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="win-titlebar">
          <span className="flex-1">{mode === 'edit' ? 'Edit operator' : 'New operator'}</span>
          <button type="button" className="win-titlebar-btn" aria-label="Close" onClick={onClose}>
            {'✕'}
          </button>
        </div>
        <form
          className="space-y-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSubmit({ name: name.trim(), callsign: callsign.trim(), role: role.trim() });
          }}
        >
          <label className="flex items-center gap-2">
            <span className="w-[74px] text-right text-[#404040]">Name</span>
            <input
              autoFocus
              className="win-sunken min-w-0 flex-1 px-2 py-[3px]"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-[74px] text-right text-[#404040]">Callsign</span>
            <input
              className="win-sunken min-w-0 flex-1 px-2 py-[3px] font-mono"
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              placeholder="e.g. Rescue 51"
              maxLength={24}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-[74px] text-right text-[#404040]">Role</span>
            <input
              className="win-sunken min-w-0 flex-1 px-2 py-[3px]"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. HEMS crew, RFDS"
              maxLength={40}
            />
          </label>
          <div className="flex items-center gap-2 border-t-2 border-[#808080] pt-2" style={{ boxShadow: '0 1px 0 #fff inset' }}>
            <button type="submit" className="win-btn is-default" disabled={!name.trim()}>
              {mode === 'edit' ? 'Save' : 'Create & sign in'}
            </button>
            <button type="button" className="win-btn" onClick={onClose}>
              Cancel
            </button>
            {onDelete && (
              <button type="button" className="win-btn ml-auto" onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
