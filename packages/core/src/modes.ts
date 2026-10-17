/**
 * Mode resolution.
 *
 * A Mode instantly reshapes the active rule set. Resolving a target's
 * "effective rule" means: start from its base rule, then apply the active
 * mode's per-target override, and finally apply the mode's default policy for
 * targets it doesn't mention.
 */

import type { Mode, Rule } from './types.js';

const PERMANENT_BLOCK: Rule = { type: 'permanent-block' };
const ALWAYS_ALLOWED: Rule = { type: 'always-allowed' };

/**
 * Compute the effective rule for a target under the active mode.
 * @param baseRule   The target's own rule.
 * @param targetId   The target's id (to look up overrides).
 * @param mode       The active mode, or null for "no mode" (use base rules).
 */
export function resolveEffectiveRule(
  baseRule: Rule,
  targetId: string,
  mode: Mode | null,
): Rule {
  if (!mode) return baseRule;

  const override = mode.overrides[targetId];
  if (override) return override;

  switch (mode.defaultPolicy) {
    case 'use-base':
      return baseRule;
    case 'allow':
      return ALWAYS_ALLOWED;
    case 'block':
      // Allow-list mode: anything the mode didn't explicitly permit is blocked.
      return PERMANENT_BLOCK;
  }
}
