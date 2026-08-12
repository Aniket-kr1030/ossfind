export interface RankerWeights {
  fit: number;
  license: number;
  security: number;
  health: number;
  effort: number;
}

/**
 * Default ranking weights prioritizing safety (license + security + health = 0.75)
 * over raw fit (0.15) and integration effort (0.10).
 */
export const DEFAULT_WEIGHTS: RankerWeights = {
  security: 0.30,
  license: 0.25,
  health: 0.20,
  fit: 0.15,
  effort: 0.10,
};
