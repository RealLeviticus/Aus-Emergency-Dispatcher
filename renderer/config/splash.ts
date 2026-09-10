export type SplashProfileId = 'emergency' | 'military';

export type SplashProfile = {
  id: SplashProfileId;
  organisation: string;
  title: string;
  subtitle: string;
  mark: string;
  accent: string;
  secondary: string;
  background: string;
  lightPattern: 'emergency' | 'military';
};

export const splashProfiles: Record<SplashProfileId, SplashProfile> = {
  emergency: {
    id: 'emergency',
    organisation: 'Australian emergency operations',
    title: 'Aus Emergency Dispatcher',
    subtitle: 'Dispatch operations console',
    mark: 'AED',
    accent: '#ef4444',
    secondary: '#2563eb',
    background: '#09090b',
    lightPattern: 'emergency',
  },
  military: {
    id: 'military',
    organisation: 'Royal Australian Air Force virtual operations',
    title: 'RAAFv Tasking Dispatcher',
    subtitle: 'Mission tasking and coordination system',
    mark: 'RAAFv',
    accent: '#facc15',
    secondary: '#38bdf8',
    background: '#071018',
    lightPattern: 'military',
  },
};

export const defaultSplashProfile = splashProfiles.emergency;