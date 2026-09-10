import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const handler = {
  send(channel: string, value: unknown) {
    ipcRenderer.send(channel, value);
  },
  on(channel: string, callback: (...args: unknown[]) => void) {
    const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  invoke(channel: string, ...args: unknown[]) {
    return ipcRenderer.invoke(channel, ...args);
  },
};

contextBridge.exposeInMainWorld('ipc', handler);

/**
 * Warm the routes the console actually navigates to, so the first paint after
 * the splash is instant. `/settings` used to be in this list; it was an
 * unreachable page and has been removed. Failures are silent by design — this
 * is an optimisation, and a noisy console on every window is not worth it.
 */
void (async () => {
  for (const page of ['/', '/home']) {
    try {
      await fetch(page, { cache: 'force-cache' });
    } catch {
      /* the route still loads normally on navigation */
    }
  }
})();

export type IpcHandler = typeof handler;
