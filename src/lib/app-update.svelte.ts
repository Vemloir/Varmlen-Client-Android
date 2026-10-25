import {
  appUpdateProgress,
  checkAppUpdate,
  installAppUpdate,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from "$lib/api";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Phases after which the native updater has nothing more to report. */
const SETTLED = new Set(["idle", "installing", "needs_permission", "error"]);

/** Settings' "Check for updates": the newest stable release and preview, and
 *  the download of one of them, polled while it runs. */
class AppUpdateStore {
  info = $state<AppUpdateInfo | null>(null);
  checking = $state(false);
  error = $state<string | null>(null);
  progress = $state<AppUpdateProgress | null>(null);
  private polling: ReturnType<typeof setTimeout> | null = null;

  async check(): Promise<void> {
    this.checking = true;
    this.error = null;
    try {
      this.info = await checkAppUpdate();
    } catch (e) {
      this.error = msg(e);
    } finally {
      this.checking = false;
    }
  }

  async install(tag: string): Promise<void> {
    this.error = null;
    try {
      await installAppUpdate(tag);
      this.progress = { phase: "downloading", tag, downloaded: 0, total: 0 };
      this.poll();
    } catch (e) {
      this.error = msg(e);
    }
  }

  /** Is a download or check of `tag` under way? */
  busy(tag: string): boolean {
    const p = this.progress;
    return p?.tag === tag && (p.phase === "downloading" || p.phase === "verifying");
  }

  private poll(): void {
    if (this.polling) clearTimeout(this.polling);
    this.polling = setTimeout(async () => {
      this.polling = null;
      try {
        this.progress = await appUpdateProgress();
      } catch (e) {
        this.error = msg(e);
        return;
      }
      if (!SETTLED.has(this.progress.phase)) this.poll();
    }, 300);
  }
}

export const appUpdate = new AppUpdateStore();
