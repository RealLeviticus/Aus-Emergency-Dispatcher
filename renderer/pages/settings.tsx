import Head from 'next/head';
import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { splashProfiles, SplashProfileId } from '../config/splash';

const settingsRows = [
  { label: 'CAD Connection', value: 'Not configured' },
  { label: 'Map Provider', value: 'Not configured' },
  { label: 'Radio Gateway', value: 'Not configured' },
  { label: 'Region Profile', value: 'NSW Metro' },
];

export default function Settings() {
  const [splashProfile, setSplashProfile] = useState<SplashProfileId>('emergency');

  useEffect(() => {
    window.ipc
      .invoke('getSplashProfile')
      .then((value) => {
        if (value === 'emergency' || value === 'military') setSplashProfile(value);
      })
      .catch(() => undefined);
  }, []);

  const chooseSplashProfile = (profile: SplashProfileId) => {
    setSplashProfile(profile);
    void window.ipc.invoke('setSplashProfile', profile);
  };

  return (
    <Layout>
      <Head>
        <title>Settings - Aus Emergency Dispatcher</title>
      </Head>

      <div className="flex h-full flex-col overflow-y-auto bg-zinc-900">
        <header className="flex min-h-[72px] items-center border-b border-slate-700 bg-zinc-900 px-8">
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500">Configuration</p>
            <h2 className="text-2xl font-semibold text-white">Settings</h2>
          </div>
        </header>

        <main className="max-w-4xl space-y-6 p-8">
          <section className="rounded-lg border border-slate-700 bg-slate-900/80">
            <div className="border-b border-slate-700 px-5 py-4">
              <h3 className="text-base font-semibold text-white">System Links</h3>
            </div>

            <div className="divide-y divide-slate-800">
              {settingsRows.map((row) => (
                <div key={row.label} className="grid grid-cols-[220px_1fr] gap-4 px-5 py-4 text-sm">
                  <span className="text-slate-400">{row.label}</span>
                  <span className="text-slate-200">{row.value}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-700 bg-slate-900/80 p-5">
            <h3 className="text-base font-semibold text-white">Operator Defaults</h3>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="block text-sm text-slate-300">
                Default Desk
                <input
                  className="mt-2 w-full rounded-md border border-slate-700 bg-zinc-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-blue-500"
                  defaultValue="Metro East"
                />
              </label>

              <label className="block text-sm text-slate-300">
                Callsign Prefix
                <input
                  className="mt-2 w-full rounded-md border border-slate-700 bg-zinc-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-blue-500"
                  defaultValue="AED"
                />
              </label>
            </div>
          </section>

          <section className="rounded-lg border border-slate-700 bg-slate-900/80 p-5">
            <div className="border-b border-slate-700 pb-4">
              <h3 className="text-base font-semibold text-white">Startup Profile</h3>
              <p className="mt-1 text-sm text-slate-400">Choose the identity shown while the dispatcher starts.</p>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {(Object.keys(splashProfiles) as SplashProfileId[]).map((profileId) => {
                const profile = splashProfiles[profileId];
                const selected = splashProfile === profileId;

                return (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => chooseSplashProfile(profile.id)}
                    className={`rounded-md border p-4 text-left transition ${
                      selected ? 'border-blue-400 bg-blue-500/10 ring-1 ring-blue-400/50' : 'border-slate-700 bg-zinc-800 hover:border-slate-500'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-white">{profile.title}</span>
                      <span className="h-3 w-3 rounded-full" style={{ background: profile.accent }} />
                    </span>
                    <span className="mt-2 block text-xs text-slate-400">{profile.subtitle}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-slate-500">The selected profile appears on the next application start.</p>
          </section>
        </main>
      </div>
    </Layout>
  );
}
