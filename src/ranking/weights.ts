export interface RankerWeights {
  fit: number;
  license: number;
  security: number;
  health: number;
  effort: number;
  adoption: number;
}

/**
 * Default ranking weights prioritize safety (license + security + health = 0.68)
 * over fit, effort, and bounded adoption (0.32). Adoption measures viability,
 * never safety; rank.ts applies all safety caps after this blend.
 */
export const DEFAULT_WEIGHTS: RankerWeights = {
  security: 0.28,
  license: 0.23,
  health: 0.17,
  fit: 0.14,
  effort: 0.10,
  adoption: 0.08,
};
