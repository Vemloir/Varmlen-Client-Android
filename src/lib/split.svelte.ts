import { browser } from "$app/environment";
import type { SplitTab } from "./nav-zones";
import { migrateSitePatterns } from "./site-pattern";

export type Mode = "selective" | "general";

export interface AppEntry {
  /** Process name on Linux/Windows or package on Android. */
  id: string;
  /** Display name. */
  name: string;
  /** Emoji, short text, or a `data:` icon URI. Null when the application has no
   *  icon at all -- the row then shows no icon rather than a placeholder. */
  icon: string | null;
  enabled: boolean;
}

export interface SiteEntry {
  id: string;
  pattern: string;
  enabled: boolean;
}

interface ModeBuckets<T> {
  general: T[];
  selective: T[];
}

/** Apps and sites are INDEPENDENT: each has its own mode and its own per-mode
 *  lists. Switching a category's mode swaps that category's list; the mode
 *  governs whether the listed entries are the blacklist (general: listed stay
 *  direct) or the whitelist (selective: only listed are tunneled). */
interface Persisted {
  appsMode: Mode;
  sitesMode: Mode;
  apps: ModeBuckets<AppEntry>;
  sites: ModeBuckets<SiteEntry>;
}

const KEY = "varmlen.split";

function defaults(): Persisted {
  // Default to "general": VPN carries everything, exceptions are direct.
  return {
    appsMode: "general",
    sitesMode: "general",
    apps: { general: [], selective: [] },
    sites: { general: [], selective: [] },
  };
}

function asMode(x: unknown): Mode {
  return x === "selective" ? "selective" : "general";
}
function arr<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

function load(): Persisted {
  if (!browser) return defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const p = JSON.parse(raw) as Record<string, any>;

    // Current shape: independent apps/sites modes + per-mode buckets.
    if (p.appsMode !== undefined || p.sitesMode !== undefined) {
      return {
        appsMode: asMode(p.appsMode),
        sitesMode: asMode(p.sitesMode),
        apps: {
          general: arr<AppEntry>(p.apps?.general),
          selective: arr<AppEntry>(p.apps?.selective),
        },
        sites: {
          general: arr<SiteEntry>(p.sites?.general),
          selective: arr<SiteEntry>(p.sites?.selective),
        },
      };
    }

    // Prior shape: a single shared mode + buckets of { apps, sites } per mode.
    // Migrate by splitting each bucket's apps/sites into the two categories;
    // both categories inherit the old shared mode.
    if (p.general || p.selective) {
      const m = asMode(p.mode);
      return {
        appsMode: m,
        sitesMode: m,
        apps: {
          general: arr<AppEntry>(p.general?.apps),
          selective: arr<AppEntry>(p.selective?.apps),
        },
        sites: {
          general: arr<SiteEntry>(p.general?.sites),
          selective: arr<SiteEntry>(p.selective?.sites),
        },
      };
    }

    // Oldest shape: one flat apps/sites list. Put it in the persisted mode.
    if (Array.isArray(p.apps) || Array.isArray(p.sites)) {
      const m = asMode(p.mode);
      const out = defaults();
      out.appsMode = m;
      out.sitesMode = m;
      out.apps[m] = arr<AppEntry>(p.apps);
      out.sites[m] = arr<SiteEntry>(p.sites);
      return out;
    }

    return defaults();
  } catch {
    return defaults();
  }
}

// Patterns are shown to the user, so they are stored in the current notation. The
// rewrite preserves meaning -- the router maps the old "*.host" spelling to the same
// rule as the plain host -- so this is a display fix, not a routing change.
const _initialSplit = (() => {
  const loaded = load();
  return {
    ...loaded,
    sites: {
      general: migrateSitePatterns(loaded.sites.general).sites,
      selective: migrateSitePatterns(loaded.sites.selective).sites,
    },
  };
})();

class SplitStore {
  appsMode = $state<Mode>(_initialSplit.appsMode);
  sitesMode = $state<Mode>(_initialSplit.sitesMode);
  appsBuckets = $state<ModeBuckets<AppEntry>>(_initialSplit.apps);
  sitesBuckets = $state<ModeBuckets<SiteEntry>>(_initialSplit.sites);

  /** Which half of the split page the reader is looking at. It lives here rather
   *  than in the page because the swipe strip has to know it too: applications and
   *  websites are two places in the strip that share one route, and a drag from Home
   *  has to land on the right half without navigating twice. Not persisted -- it is
   *  where the eyes were, not a setting. */
  tab = $state<SplitTab>("apps");

  setTab(tab: SplitTab): void {
    this.tab = tab;
  }

  /** Active-mode apps — what the UI binds to and what's sent to the backend. */
  get apps(): AppEntry[] {
    return this.appsBuckets[this.appsMode];
  }
  get sites(): SiteEntry[] {
    return this.sitesBuckets[this.sitesMode];
  }

  private setApps(next: AppEntry[]): void {
    this.appsBuckets = { ...this.appsBuckets, [this.appsMode]: next };
    this.persist();
  }
  private setSites(next: SiteEntry[]): void {
    this.sitesBuckets = { ...this.sitesBuckets, [this.sitesMode]: next };
    this.persist();
  }

  private persist(): void {
    if (!browser) return;
    const payload: Persisted = {
      appsMode: this.appsMode,
      sitesMode: this.sitesMode,
      apps: this.appsBuckets,
      sites: this.sitesBuckets,
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  }

  setAppsMode(m: Mode): void {
    this.appsMode = m;
    this.persist();
  }
  setSitesMode(m: Mode): void {
    this.sitesMode = m;
    this.persist();
  }

  toggleApp(id: string): void {
    this.setApps(this.apps.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  }

  addApp(app: Omit<AppEntry, "enabled">): void {
    if (this.apps.some((a) => a.id === app.id)) return;
    this.setApps([...this.apps, { ...app, enabled: true }]);
  }

  removeApp(id: string): void {
    this.setApps(this.apps.filter((a) => a.id !== id));
  }

  addSite(pattern: string): void {
    const v = pattern.trim();
    if (!v) return;
    if (this.sites.some((s) => s.pattern === v)) return;
    this.setSites([...this.sites, { id: crypto.randomUUID(), pattern: v, enabled: true }]);
  }

  toggleSite(id: string): void {
    this.setSites(this.sites.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  }

  removeSite(id: string): void {
    this.setSites(this.sites.filter((s) => s.id !== id));
  }
}

export const split = new SplitStore();
