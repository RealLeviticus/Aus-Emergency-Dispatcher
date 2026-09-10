import { ReactNode, useState } from 'react';
import { useRouter } from 'next/router';
import { motion } from 'framer-motion';
import {
  HiBell,
  HiChartBar,
  HiClipboardList,
  HiCog,
  HiLocationMarker,
  HiMenu,
  HiPhone,
  HiSpeakerphone,
  HiTruck,
  HiX,
} from 'react-icons/hi';

const navigationItems = [
  { name: 'Overview', path: '/home', icon: HiChartBar },
  { name: 'Call Intake', path: '/home?section=calls', icon: HiPhone },
  { name: 'Dispatch Queue', path: '/home?section=dispatch', icon: HiClipboardList },
  { name: 'Units', path: '/home?section=units', icon: HiTruck },
  { name: 'Map', path: '/home?section=map', icon: HiLocationMarker },
  { name: 'Radio', path: '/home?section=radio', icon: HiSpeakerphone },
  { name: 'Alerts', path: '/home?section=alerts', icon: HiBell },
  { name: 'Settings', path: '/settings', icon: HiCog },
];

export default function Layout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fadeOutContent, setFadeOutContent] = useState(false);

  const handleNavigation = (path: string) => {
    if (path === router.asPath) return;

    setFadeOutContent(true);
    setTimeout(() => {
      router.push(path).finally(() => setFadeOutContent(false));
    }, 180);
  };

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-zinc-900 text-slate-200">
      <motion.button
        onClick={() => setSidebarOpen((open) => !open)}
        initial={false}
        animate={{ x: sidebarOpen ? 256 : 16, y: 72 }}
        transition={{ type: 'tween', duration: 0.22 }}
        className="fixed top-[-30px] z-30 rounded-md bg-slate-700 p-2 text-white shadow-lg hover:bg-slate-600"
        style={{ left: sidebarOpen ? '5px' : '-10px' }}
        aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        {sidebarOpen ? <HiX size={24} /> : <HiMenu size={24} />}
      </motion.button>

      <motion.aside
        initial={false}
        animate={{ x: sidebarOpen ? 0 : -300 }}
        transition={{ type: 'tween', duration: 0.22 }}
        className="fixed left-0 top-0 z-20 flex h-screen w-64 flex-col border-r-2 border-slate-600 bg-gradient-to-br from-slate-900 to-slate-800 p-4"
      >
        <div className="mb-5 flex items-center gap-3 border-b border-slate-700 pb-4">
          <img
            src="/logo.svg"
            alt=""
            className="size-10 shrink-0 rounded-md bg-slate-950 object-contain shadow-lg shadow-red-900/30 ring-1 ring-slate-400/40"
            draggable={false}
          />
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-white">Aus Emergency</h1>
            <p className="truncate text-xs text-slate-400">Dispatcher</p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col space-y-2" aria-label="Main navigation">
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const active =
              router.asPath === item.path ||
              (item.path === '/home' && router.pathname === '/home' && !router.asPath.includes('?'));

            return (
              <button
                key={item.name}
                onClick={() => handleNavigation(item.path)}
                className={`flex items-center gap-3 rounded-md p-3 text-left text-sm transition ${
                  active ? 'bg-blue-500 font-bold text-white' : 'text-slate-300 hover:bg-slate-700'
                }`}
                type="button"
              >
                <Icon size={18} />
                <span className="truncate">{item.name}</span>
              </button>
            );
          })}
        </nav>

        <div className="rounded-md border border-slate-700 bg-slate-900/70 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-500" />
            Offline Mode
          </div>
          <p className="mt-1 text-xs text-slate-500">Local prototype</p>
        </div>
      </motion.aside>

      <motion.main
        animate={{
          marginLeft: sidebarOpen ? 256 : 0,
          opacity: fadeOutContent ? 0 : 1,
        }}
        transition={{
          marginLeft: { type: 'tween', duration: 0.22 },
          opacity: { type: 'tween', duration: 0.18 },
        }}
        className="relative h-screen w-full overflow-hidden"
      >
        {children}
      </motion.main>
    </div>
  );
}
