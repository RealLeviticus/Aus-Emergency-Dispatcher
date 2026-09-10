import { screen, BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from 'electron';
import Store from 'electron-store';

type WindowState = Rectangle & { isMaximized?: boolean };

export const createWindow = (
  windowName: string,
  options: BrowserWindowConstructorOptions,
  opts?: { maximizeOnFirstRun?: boolean },
): BrowserWindow => {
  const key = 'window-state';
  const name = `window-state-${windowName}`;
  const store = new Store<WindowState>({ name });
  const hasStoredState = store.has(key);
  const defaultState: WindowState = {
    width: options.width,
    height: options.height,
    x: options.x,
    y: options.y,
    isMaximized: false,
  };
  let state: WindowState = {} as WindowState;

  const restore = (): WindowState => store.get(key, defaultState);

  const windowWithinBounds = (windowState: WindowState, bounds: Rectangle) => {
    return (
      typeof windowState.x === 'number' &&
      typeof windowState.y === 'number' &&
      typeof windowState.width === 'number' &&
      typeof windowState.height === 'number' &&
      windowState.x >= bounds.x &&
      windowState.y >= bounds.y &&
      windowState.x + windowState.width <= bounds.x + bounds.width &&
      windowState.y + windowState.height <= bounds.y + bounds.height
    );
  };

  const resetToDefaults = (): WindowState => {
    const bounds = screen.getPrimaryDisplay().bounds;
    return Object.assign({}, defaultState, {
      x: (bounds.width - (defaultState.width || 800)) / 2,
      y: (bounds.height - (defaultState.height || 600)) / 2,
    });
  };

  const ensureVisibleOnSomeDisplay = (windowState: WindowState): WindowState => {
    const visible = screen.getAllDisplays().some((display) => windowWithinBounds(windowState, display.bounds));
    if (!visible) {
      // Window is partially or fully not visible now. Reset it to safe defaults.
      return resetToDefaults();
    }
    return windowState;
  };

  const saveState = () => {
    if (!win) return;
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    store.set(key, { ...bounds, isMaximized });
  };

  state = ensureVisibleOnSomeDisplay(restore());
  const { isMaximized, ...positioning } = state;
  const shouldMaximize = Boolean(isMaximized) || (!hasStoredState && opts?.maximizeOnFirstRun);

  const win = new BrowserWindow({
    ...positioning,
    ...options,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      ...options.webPreferences,
    },
  });

  if (shouldMaximize) {
    win.maximize();
  }

  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', saveState);

  return win;
};
