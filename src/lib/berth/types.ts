export type Engine = "chrome" | "reader";

export type SurfaceControl = {
  tag: string;
  label: string;
  href?: string;
  /** Number the model uses to point at this control: [ref] in its list. */
  ref?: number;
  /** What it is, for the model: link, button, text, search, checkbox, select, option, tab… */
  kind?: string;
  /** Current value of a field, or the chosen option of a select. */
  value?: string;
  /** Choices of a select. */
  options?: string[];
};

export type TaskMetrics = {
  elapsedMs: number;
  modelCalls: number;
  /** True when the task ran out of time or steps and answered with what it had. */
  partial: boolean;
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
  metrics?: TaskMetrics;
};

export type DockFail = { ok: false; error: string };

export type DockResult = DockView | DockFail;
