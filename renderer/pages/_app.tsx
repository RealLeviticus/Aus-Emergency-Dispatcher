import React from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';

import 'leaflet/dist/leaflet.css';
import '../components/index.css';

import FlyonuiScript from '../components/meta/FlyonUI';

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <main className="prevent-select h-screen overflow-hidden bg-zinc-800 text-zinc-200">
      <Head>
        <title>Aus Emergency Dispatcher</title>
        <link rel="icon" type="image/png" href="/logo-mark.png" />
      </Head>
      <Component {...pageProps} />
      <FlyonuiScript />
    </main>
  );
}

export default MyApp;
