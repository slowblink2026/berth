import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DockRecord = {
  id: string;
  name: string;
  url: string;
  memory: string;
  vaultLabel: string;
};

type DockState = {
  docks: DockRecord[];
  activeId: string | null;
  add: (dock: DockRecord) => void;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Omit<DockRecord, "id">>) => void;
  setActive: (id: string | null) => void;
};

export const useDockStore = create<DockState>()(
  persist(
    (set) => ({
      docks: [],
      activeId: null,
      add: (dock) =>
        set((state) => ({
          docks: [dock, ...state.docks.filter((item) => item.id !== dock.id)].slice(0, 12),
          activeId: dock.id,
        })),
      remove: (id) =>
        set((state) => {
          const docks = state.docks.filter((item) => item.id !== id);
          const activeId = state.activeId === id ? (docks[0]?.id ?? null) : state.activeId;
          return { docks, activeId };
        }),
      update: (id, patch) =>
        set((state) => ({
          docks: state.docks.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        })),
      setActive: (id) => set({ activeId: id }),
    }),
    { name: "berth-docks", skipHydration: true },
  ),
);

export const SUGGESTED = [
  {
    name: "Example",
    url: "https://example.com",
    blurb: "A quiet page. Ask what it says.",
  },
  {
    name: "Harbor",
    url: "https://en.wikipedia.org/wiki/Harbor",
    blurb: "One article. Don't wander off the site.",
  },
  {
    name: "HTML",
    url: "https://developer.mozilla.org/en-US/docs/Web/HTML",
    blurb: "A long document to read back.",
  },
] as const;
