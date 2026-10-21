export type PhotometricFormat = 'ies' | 'ldt';

/**
 * How the stored C-planes relate to the full 0..360° distribution.
 *  - none:        all planes are stored
 *  - rotational:  a single plane describes every azimuth
 *  - c0-c180:     mirror symmetric about the C0-C180 plane
 *  - c90-c270:    mirror symmetric about the C90-C270 plane
 *  - quadrant:    mirror symmetric about both planes (C0..C90 stored)
 */
export type Symmetry = 'none' | 'rotational' | 'c0-c180' | 'c90-c270' | 'quadrant';

export interface PhotometricMeta {
  fileName: string;
  manufacturer?: string;
  luminaire?: string;
  catalog?: string;
  lamp?: string;
  date?: string;
  testLab?: string;
}

export interface PhotometricData {
  format: PhotometricFormat;
  meta: PhotometricMeta;
  symmetry: Symmetry;
  /**
   * Stored C-plane angles in degrees, ascending. For `c90-c270` symmetry the
   * range is either [90, 270] or [-90, 90] depending on which half the file stores.
   */
  cAngles: number[];
  /** Gamma angles in degrees, ascending, 0 = nadir, 180 = zenith. */
  gAngles: number[];
  /** Absolute luminous intensity in candela, indexed [cIndex][gIndex]. */
  intensity: number[][];
  /** Declared total lamp flux in lumens (undefined for absolute photometry). */
  lampFlux?: number;
  inputWatts?: number;
  cct?: number;
  cri?: number;
  /** Declared light output ratio in percent. */
  declaredLor?: number;
  /** Luminaire / luminous opening dimensions in meters. */
  luminousLength: number;
  luminousWidth: number;
  round: boolean;
  warnings: string[];
}

export interface PhotometricStats {
  /** Luminous flux integrated from the intensity distribution (lm). */
  flux: number;
  downwardFlux: number;
  upwardFlux: number;
  /** Upward light output ratio in percent of luminaire flux. */
  upwardRatio: number;
  maxIntensity: number;
  maxIntensityAt: { c: number; g: number };
  /** Light output ratio in percent, if the lamp flux is known. */
  lor?: number;
  /** Luminaire efficacy in lm/W, if input power is known. */
  efficacy?: number;
  beamAngleC0?: number;
  beamAngleC90?: number;
  fieldAngleC0?: number;
  fieldAngleC90?: number;
  /** C angle (degrees) of the flux-weighted horizontal throw of the downward light. */
  throwAngle: number;
  /** 0 = symmetric, 1 = all downward light thrown to one side. */
  asymmetry: number;
}
