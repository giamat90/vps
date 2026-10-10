import { create } from "zustand";

interface SettingsState {
  youtubeCookiesPath: string | null;
  setYoutubeCookiesPath: (path: string | null) => void;
  collapsedFolders: Record<string, boolean>;
  setFolderCollapsed: (folderId: string, collapsed: boolean) => void;
}

type PersistedSettings = {
  youtubeCookiesPath: string | null;
  collapsedFolders: Record<string, boolean>;
};

function _loadSettings(): PersistedSettings {
  try {
    const raw = JSON.parse(localStorage.getItem("vps_settings") ?? "{}") as Record<string, unknown>;
    const cookiesPath = raw.youtubeCookiesPath;
    const collapsed = raw.collapsedFolders;
    return {
      youtubeCookiesPath: typeof cookiesPath === "string" ? cookiesPath : null,
      collapsedFolders:
        collapsed && typeof collapsed === "object" && !Array.isArray(collapsed)
          ? (collapsed as Record<string, boolean>)
          : {},
    };
  } catch (e) {
    console.warn("[settings] Could not load settings:", e);
    return { youtubeCookiesPath: null, collapsedFolders: {} };
  }
}

function _persistSettings(settings: PersistedSettings): void {
  try {
    localStorage.setItem("vps_settings", JSON.stringify(settings));
  } catch (e) {
    console.warn("[settings] Could not persist settings:", e);
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ..._loadSettings(),

  setYoutubeCookiesPath: (path) => {
    set({ youtubeCookiesPath: path });
    _persist(get);
  },

  setFolderCollapsed: (folderId, collapsed) => {
    set({ collapsedFolders: { ...get().collapsedFolders, [folderId]: collapsed } });
    _persist(get);
  },
}));

function _persist(get: () => SettingsState): void {
  _persistSettings({
    youtubeCookiesPath: get().youtubeCookiesPath,
    collapsedFolders: get().collapsedFolders,
  });
}
