import { useEffect, useRef, useState } from 'react';

export type MenuItem =
  | 'separator'
  | {
      label: string;
      onClick?: () => void;
      disabled?: boolean;
      checked?: boolean;
    };

export type Menu = {
  /** the visible label; the first char is underlined as the mnemonic */
  label: string;
  items: MenuItem[];
};

/** Win9x-style click-to-open menu bar. */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={barRef} className="win-menu win-underline relative flex">
      {menus.map((m, i) => (
        <div key={m.label} className="relative">
          <button
            type="button"
            className={`px-2 py-[1px] ${open === i ? 'bg-[#000080] text-white' : ''}`}
            onClick={() => setOpen((o) => (o === i ? null : i))}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            <u>{m.label.slice(0, 1)}</u>
            {m.label.slice(1)}
          </button>
          {open === i && (
            <div
              className="win-raised absolute left-0 top-full z-50 min-w-[200px] py-1"
              style={{ background: 'var(--w-face, #d4d0c8)' }}
            >
              {m.items.map((it, j) =>
                it === 'separator' ? (
                  <div key={j} className="my-1 border-t border-[#808080]" style={{ boxShadow: '0 1px 0 #fff' }} />
                ) : (
                  <button
                    key={j}
                    type="button"
                    disabled={it.disabled}
                    className={`flex w-full items-center gap-2 px-3 py-[3px] text-left hover:bg-[#000080] hover:text-white ${
                      it.disabled ? 'text-[#808080] hover:!bg-transparent hover:!text-[#808080]' : ''
                    }`}
                    onClick={() => {
                      setOpen(null);
                      it.onClick?.();
                    }}
                  >
                    <span className="w-3 text-center">{it.checked ? '✓' : ''}</span>
                    <span className="flex-1">{it.label}</span>
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
