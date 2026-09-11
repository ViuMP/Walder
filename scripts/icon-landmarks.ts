/** The lowest quarter of a standing dog's silhouette contains legs and paws. */
const LOWER_LEG_START_FRACTION = 0.75;
const IRIS_COLOR = '#2D1A0D';

/**
 * The coat quantizer can use iris ink for a lone dark pixel between the paws.
 * Treating that pixel as an eye made a valid head crop fail after the idle art
 * changed. Exclude only that narrow case, using the full silhouette's bounds
 * rather than the proposed crop: a clipped facial landmark must still fail the
 * crop guard. Upper-body singletons, white highlights and larger clusters all
 * remain landmarks, even when they fall outside the crop.
 */
export function isLowerLegShade(
  cluster: { readonly count: number; readonly y: number },
  ink: { readonly y: number; readonly height: number },
  color: string | undefined
): boolean {
  return cluster.count === 1 && color?.toUpperCase() === IRIS_COLOR &&
    cluster.y >= ink.y + ink.height * LOWER_LEG_START_FRACTION;
}
