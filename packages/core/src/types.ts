/**
 * FocusLock domain types.
 *
 * These types describe the *entire* world the Rule Engine reasons about.
 * Everything the user wants to restrict is a {@link Target}. Every target has
 * exactly ONE {@link Rule}. All state needed to make a decision lives in
 * {@link EngineState}.
 *
 * The engine is intentionally free of I/O and clock access — callers pass the
 * current time in as `now` (epoch milliseconds). This keeps every decision
 * deterministic and trivially testable, which is essential for a tool whose
 * entire value proposition is that it can be *trusted*.
 */

/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

/** The kinds of things FocusLock can block. Everything is a Target. */
export type TargetKind = 'url' | 'domain' | 'keyword' | 'app' | 'executable' | 'category';

/** A single thing the user may want to restrict. */
export interface Target {
  /** Stable unique id (uuid). */
  id: string;
  kind: TargetKind;
  /**
   * The match value.
   * - `domain`: bare host, e.g. "youtube.com" (matches subdomains).
   * - `url`: a full/partial URL prefix, e.g. "https://reddit.com/r/all".
   * - `keyword`: a substring matched against the site's host after stripping
   *   punctuation, e.g. "123movies" blocks 123movies.com, 123-movies.net,
   *   ww1.123moviesfree.la, and other mirrors/iterations.
   * - `app` / `executable`: process name, e.g. "Discord" or "steam.exe".
   * - `category`: a category id from {@link CATEGORY_IDS}.
   */
  value: string;
  /** Human-friendly label shown in the UI, e.g. "YouTube". */
  label: string;
}

/** Every target has exactly one of these rules. No combinations. */
export type Rule =
  | PermanentBlockRule
  | DailyBreakRule
  | ScheduledRule
  | AlwaysAllowedRule;

export type RuleType = Rule['type'];

/** Always blocked. Never receives breaks. */
export interface PermanentBlockRule {
  type: 'permanent-block';
}

/** Blocked unless the user spends a global daily break token to unlock it. */
export interface DailyBreakRule {
  type: 'daily-break';
}

/** Allowed only inside the given recurring time windows; blocked otherwise. */
export interface ScheduledRule {
  type: 'scheduled';
  windows: TimeWindow[];
}

/** No restrictions, ever. */
export interface AlwaysAllowedRule {
  type: 'always-allowed';
}

/**
 * A recurring daily time window in the user's local wall-clock time.
 * `start`/`end` are "HH:MM" 24h strings. A window may wrap past midnight
 * (e.g. 22:00–02:00). `days` optionally restricts to specific weekdays
 * (0 = Sunday … 6 = Saturday); omitted means every day.
 */
export interface TimeWindow {
  start: string;
  end: string;
  days?: number[];
}

/** A target bound to its rule — the unit the engine evaluates. */
export interface ManagedTarget {
  target: Target;
  rule: Rule;
}

/**
 * A Mode is a named preset that instantly swaps the active rule set.
 * Examples: Work, Study, Weekend, Gaming, Vacation, Sleep.
 *
 * A mode lists per-target rule overrides and declares what happens to any
 * target NOT listed via `defaultPolicy`:
 * - `use-base`: fall back to the target's base rule (normal behaviour).
 * - `allow`: everything unlisted is allowed.
 * - `block`: everything unlisted is permanently blocked (an allow-list mode,
 *   e.g. Work = "allow VS Code, Slack, Email; everything else blocked").
 */
export interface Mode {
  id: string;
  name: string;
  defaultPolicy: 'use-base' | 'allow' | 'block';
  /** Overrides keyed by target id. */
  overrides: Record<string, Rule>;
}

/** State of the global, shared break-token pool. */
export interface BreakState {
  /** Tokens granted each day. Spec default: 2. */
  tokensPerDay: number;
  /** Duration of one break in ms. Spec default: 30 minutes. */
  breakDurationMs: number;
  /** Tokens not yet spent today. */
  tokensRemaining: number;
  /**
   * The currently active break, if any. A break is *global*: while active it
   * unlocks every daily-break target (not just the one it was started from),
   * and only one break may be active at a time.
   */
  activeBreak: ActiveBreak | null;
  /**
   * The reset-day key (see {@link resetDayKey}) the tokens were last granted
   * for. Used to detect when a new day has begun and tokens should refill.
   */
  lastResetKey: string;
}

/**
 * An in-progress 30-minute break. While active it unlocks every daily-break
 * target; `targetId` records which target it was started from, for display.
 */
export interface ActiveBreak {
  targetId: string;
  startedAt: EpochMs;
  endsAt: EpochMs;
}

/**
 * The weekly pass: once per week the user may unlock a single target for a long
 * stretch (default 4 hours) — e.g. to watch a full movie. Separate from, and in
 * addition to, daily breaks.
 */
export interface WeeklyPassState {
  /** How long one pass lasts, in ms (default 4 hours). */
  durationMs: number;
  /** The reset-week key the pass was last spent in, or null if never. */
  lastUsedWeekKey: string | null;
  /** The in-progress pass, if any. */
  active: { targetId: string; startedAt: EpochMs; endsAt: EpochMs } | null;
}

/**
 * A Focus Session — separate from daily breaks. While active, everything the
 * session covers is unavailable. A `locked` session cannot be ended early.
 */
export interface FocusSession {
  id: string;
  name: string;
  startedAt: EpochMs;
  endsAt: EpochMs;
  locked: boolean;
  /** Target ids covered by the session. Empty means "cover everything". */
  targetIds: string[];
}

/** User-tunable engine settings. */
export interface Settings {
  /**
   * Local wall-clock time at which the day resets and break tokens refill,
   * as "HH:MM". Spec default: "05:00".
   */
  resetTime: string;
  /**
   * Minutes to add to a UTC timestamp to get the user's local wall-clock time.
   * e.g. UTC-5 (US Eastern) => -300. Kept explicit so the pure engine never
   * has to touch the ambient system timezone.
   */
  timezoneOffsetMinutes: number;
}

/** The complete state the engine needs to make any decision. */
export interface EngineState {
  settings: Settings;
  managedTargets: ManagedTarget[];
  breaks: BreakState;
  modes: Mode[];
  activeModeId: string | null;
  activeSession: FocusSession | null;
  /** The weekly long-pass pool (e.g. a 4-hour movie pass, once a week). */
  weeklyPass: WeeklyPassState;
  /**
   * Commitment-device removal cooldown. When the user asks to uninstall, this
   * is set to the request time; the uninstaller refuses until a fixed cooldown
   * (see REMOVAL_COOLDOWN_MS) has elapsed. `null` means no pending request.
   * Cancelling clears it (the safe direction: keep enforcing).
   */
  removalRequestedAt: EpochMs | null;
}

/** Why a target resolved the way it did. */
export type DecisionReason =
  | 'always-allowed'
  | 'allowed-by-schedule'
  | 'allowed-by-active-break'
  | 'allowed-by-weekly-pass'
  | 'allowed-by-mode'
  | 'allowed-no-rule'
  | 'permanent-block'
  | 'blocked-by-schedule'
  | 'blocked-no-break-remaining'
  | 'blocked-break-available'
  | 'blocked-break-on-other-target'
  | 'blocked-by-mode'
  | 'blocked-by-focus-session'
  | 'blocked-fail-closed';

/** The answer to "Can this load / run?" — the engine's whole purpose. */
export interface Decision {
  targetId: string | null;
  allowed: boolean;
  reason: DecisionReason;
  /** True if a daily break could be spent right now to unlock this target. */
  breakAvailable: boolean;
  /** True if the weekly long-pass could be spent right now to unlock this target. */
  weeklyPassAvailable?: boolean;
  /** If an active weekly pass covers this target, ms until it ends. */
  msUntilPassEnds?: EpochMs;
  /** Break tokens remaining today. */
  breaksRemaining: number;
  /** ms until the daily reset (when tokens refill). */
  msUntilReset: EpochMs;
  /** If an active break covers this target, ms until it ends. */
  msUntilBreakEnds?: EpochMs;
  /** If blocked by a schedule, ms until the next allowed window opens. */
  msUntilNextWindow?: EpochMs;
  /** If blocked by a focus session, ms until the session ends. */
  msUntilSessionEnds?: EpochMs;
  /** The effective rule that produced this decision. */
  effectiveRule: Rule;
}
