export type Engine = "chrome" | "reader";

export type SurfaceControl = {
  tag: string;
  label: string;
  href?: string;
};

export type Surface = {
  url: string;
  title: string;
  image: string | null;
  text: string;
  controls: SurfaceControl[];
  engine: Engine;
  challenge: boolean;
};

export type Step = { label: string };

export type DockStatus = "ready" | "hold" | "challenge";

export type DockView = {
  ok: true;
  surface: Surface;
  vaultHeld: boolean;
  steps: Step[];
  summary: string;
  status: DockStatus;
  pendingLabel: string | null;
};

export type DockFail = { ok: false; error: string };

export type DockResult = DockView | DockFail;
