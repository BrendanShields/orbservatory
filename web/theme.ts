export type ThemeSetting = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(setting: ThemeSetting, systemDark: boolean): ResolvedTheme {
  if (setting === 'light' || setting === 'dark') return setting;
  return systemDark ? 'dark' : 'light';
}

type Listener = (t: ResolvedTheme) => void;

class ThemeManager {
  private setting: ThemeSetting = 'system';
  private mq: MediaQueryList | null = null;
  private listeners = new Set<Listener>();
  resolved: ResolvedTheme = 'dark';

  constructor() {
    if (typeof matchMedia === 'function') {
      this.mq = matchMedia('(prefers-color-scheme: dark)');
      this.mq.addEventListener('change', () => this.apply());
    }
    this.apply();
  }

  setSetting(s: ThemeSetting) {
    if (s === this.setting) return;
    this.setting = s;
    this.apply();
  }

  getSetting(): ThemeSetting { return this.setting; }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.resolved);
  }

  private apply() {
    const systemDark = this.mq ? this.mq.matches : true;
    const next = resolveTheme(this.setting, systemDark);
    if (typeof document !== 'undefined') {
      if (next === this.resolved && document.documentElement.dataset.theme) return;
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    }
    this.resolved = next;
    for (const fn of this.listeners) fn(next);
  }
}

export const theme = new ThemeManager();
