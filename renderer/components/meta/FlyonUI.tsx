'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';

import { IStaticMethods } from 'flyonui/flyonui';
declare global {
    interface Window {
        HSStaticMethods: IStaticMethods;
    }
}

export default function FlyonUI() {
    const { asPath } = useRouter();
    const loaded = useRef(false);

    useEffect(() => {
        const loadFlyonui = async () => {
            if (loaded.current) return;
            if (typeof window === 'undefined') return;

            try {
                await import('flyonui/flyonui');
                // Defer initialization until after the import finishes and the DOM settles.
                setTimeout(() => window.HSStaticMethods?.autoInit?.(), 500);
                loaded.current = true;
            } catch (err) {
                // Keep it non-fatal; log for diagnostics and allow future retries.
                console.error('Failed to load FlyonUI', err);
                loaded.current = false;
            }
        };
        loadFlyonui();
    }, [asPath]);

    return null;
}