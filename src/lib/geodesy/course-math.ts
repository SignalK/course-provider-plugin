/**
 * Single-pass per-tick course geometry.
 *
 * Inputs are pre-converted radian scalars (caller does six
 * `Math.PI / 180` multiplications once per tick instead of paying for
 * the `LatLonSpherical` class allocation, the `Dms.wrap360` round-trip,
 * and the `Number.prototype.toRadians` monkey-patch on every call).
 *
 * Outputs share sub-expressions: sin/cos of each latitude, the Mercator
 * latitudes ψ for rhumb calculations, and the Δφ / Δλ pairs are computed
 * once and reused across all twelve quantities below.
 *
 * Formulas verified against the Chris Veness `LatLonSpherical` library
 * vendored at `src/lib/geodesy/latlon-spherical.js` (still used for
 * route / resource code that is not on the hot path).
 */

const EARTH_RADIUS_M = 6371_000
const TWO_PI = Math.PI * 2

export interface CourseGeometry {
  /** Great-circle distance from vessel to destination (m). */
  distanceGc: number
  /** Rhumb-line distance from vessel to destination (m). */
  distanceRl: number
  /** Great-circle distance from vessel to startPoint (m). */
  prevDistanceGc: number
  /** Rhumb-line distance from vessel to startPoint (m). */
  prevDistanceRl: number
  /** Initial great-circle bearing from vessel to destination (radians, 0..2π). */
  bearingGcRad: number
  /** Rhumb-line bearing from vessel to destination (radians, 0..2π). */
  bearingRlRad: number
  /** Initial great-circle bearing along the planned track (radians, 0..2π). */
  trackBearingGcRad: number
  /** Rhumb-line bearing along the planned track (radians, 0..2π). */
  trackBearingRlRad: number
  /** Cross-track distance from the great-circle path (m). Sign indicates side. */
  xte: number
  /** True once the vessel crosses the perpendicular through the destination. */
  passedPerpendicular: boolean
}

/**
 * Normalise an angle (radians) to [0, 2π). Cheaper than a generic mod
 * because per-tick angles only ever drift by ±2π from the canonical
 * range.
 */
function wrap2Pi(a: number): number {
  return a < 0 ? a + TWO_PI : a >= TWO_PI ? a - TWO_PI : a
}

/**
 * Normalise Δλ (radians) to (-π, π] so rhumb calculations take the
 * shorter way across the anti-meridian.
 */
function wrapDLon(dLon: number): number {
  if (dLon > Math.PI) return dLon - TWO_PI
  if (dLon < -Math.PI) return dLon + TWO_PI
  return dLon
}

/**
 * Compute every per-tick quantity calcs() needs in a single pass.
 *
 * All inputs are in radians; outputs are in radians (bearings) and
 * meters (distances).
 *
 * Ill-defined corner cases (e.g., coincident vessel/destination)
 * produce NaN in the bearing fields, mirroring the underlying library;
 * downstream code already tolerates non-finite values via `?? null`.
 */
export function computeCourseGeometry(
  vLat: number,
  vLon: number,
  dLat: number,
  dLon: number,
  sLat: number,
  sLon: number
): CourseGeometry {
  // sin/cos of each latitude — reused across distance, bearing, and
  // cross-track formulas.
  const sV = Math.sin(vLat)
  const cV = Math.cos(vLat)
  const sD = Math.sin(dLat)
  const cD = Math.cos(dLat)
  const sS = Math.sin(sLat)
  const cS = Math.cos(sLat)

  // Mercator latitudes ψ for rhumb-line. Computed once per latitude.
  const ψV = Math.log(Math.tan(Math.PI / 4 + vLat / 2))
  const ψD = Math.log(Math.tan(Math.PI / 4 + dLat / 2))
  const ψS = Math.log(Math.tan(Math.PI / 4 + sLat / 2))

  // Pairwise deltas. Δλ values are antimeridian-normalised to (-π, π].
  const dPhi_VD = dLat - vLat
  const dPhi_VS = sLat - vLat
  const dLon_VD = wrapDLon(dLon - vLon)
  const dLon_VS = wrapDLon(sLon - vLon)
  const dLon_SD = wrapDLon(dLon - sLon)

  // Rhumb Δψ — sign matters for bearing, doesn't matter for distance
  // (Δλ is squared anyway).
  const dPsi_VD = ψD - ψV
  const dPsi_VS = ψS - ψV
  const dPsi_SD = ψD - ψS

  // Pre-compute sin/cos of each Δλ once. The bearings between point
  // pairs reuse these via sin(-x) = -sin(x), cos(-x) = cos(x).
  const sinDLonVD = Math.sin(dLon_VD)
  const cosDLonVD = Math.cos(dLon_VD)
  const sinDLonVS = Math.sin(dLon_VS)
  const cosDLonVS = Math.cos(dLon_VS)
  const sinDLonSD = Math.sin(dLon_SD)
  const cosDLonSD = Math.cos(dLon_SD)

  // ---------- vessel → destination ----------

  const sinHalfDPhiVD = Math.sin(dPhi_VD / 2)
  const sinHalfDLonVD = Math.sin(dLon_VD / 2)
  const aVD =
    sinHalfDPhiVD * sinHalfDPhiVD + cV * cD * sinHalfDLonVD * sinHalfDLonVD
  const distanceGc = 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(aVD))

  const bearingGcRad = wrap2Pi(
    Math.atan2(sinDLonVD * cD, cV * sD - sV * cD * cosDLonVD)
  )

  const qVD = Math.abs(dPsi_VD) > 1e-12 ? dPhi_VD / dPsi_VD : cV
  const distanceRl =
    EARTH_RADIUS_M *
    Math.sqrt(dPhi_VD * dPhi_VD + qVD * qVD * dLon_VD * dLon_VD)

  const bearingRlRad = wrap2Pi(Math.atan2(dLon_VD, dPsi_VD))

  // ---------- start → destination (planned track) ----------

  // θ12 keeps the signed atan2 result for use in the cross-track formula
  // below; trackBearingGcRad wraps it to [0, 2π).
  const θ12 = Math.atan2(sinDLonSD * cD, cS * sD - sS * cD * cosDLonSD)
  const trackBearingGcRad = wrap2Pi(θ12)
  const trackBearingRlRad = wrap2Pi(Math.atan2(dLon_SD, dPsi_SD))

  // ---------- vessel → start (previousPoint distance + xte) ----------

  const sinHalfDPhiVS = Math.sin(dPhi_VS / 2)
  const sinHalfDLonVS = Math.sin(dLon_VS / 2)
  const aVS =
    sinHalfDPhiVS * sinHalfDPhiVS + cV * cS * sinHalfDLonVS * sinHalfDLonVS
  // angularVS = δ13 / R; reused as the angular distance in the xte formula.
  const angularVS = 2 * Math.asin(Math.sqrt(aVS))
  const prevDistanceGc = EARTH_RADIUS_M * angularVS

  const qVS = Math.abs(dPsi_VS) > 1e-12 ? dPhi_VS / dPsi_VS : cV
  const prevDistanceRl =
    EARTH_RADIUS_M *
    Math.sqrt(dPhi_VS * dPhi_VS + qVS * qVS * dLon_VS * dLon_VS)

  // ---------- cross-track distance ----------

  // θ13 = signed great-circle bearing from start → vessel. Δλ_SV =
  // -Δλ_VS, so sin flips and cos is unchanged.
  const θ13 = Math.atan2(-sinDLonVS * cV, cS * sV - sS * cV * cosDLonVS)
  const xte =
    Math.asin(Math.sin(angularVS) * Math.sin(θ13 - θ12)) * EARTH_RADIUS_M

  // ---------- passed perpendicular ----------

  // Bearings destination → vessel and destination → start. We need both
  // signed (pre-wrap) so the angular subtraction below stays well-defined.
  // Δλ_DV = -Δλ_VD and Δλ_DS = -Δλ_SD; sin flips, cos is unchanged.
  const θDV = Math.atan2(-sinDLonVD * cV, cD * sV - sD * cV * cosDLonVD)
  const θDS = Math.atan2(-sinDLonSD * cS, cD * sS - sD * cS * cosDLonSD)

  let diff = θDV - θDS
  if (diff > Math.PI) diff -= TWO_PI
  if (diff < -Math.PI) diff += TWO_PI
  const passedPerpendicular = Math.abs(diff) > Math.PI / 2

  return {
    distanceGc,
    distanceRl,
    prevDistanceGc,
    prevDistanceRl,
    bearingGcRad,
    bearingRlRad,
    trackBearingGcRad,
    trackBearingRlRad,
    xte,
    passedPerpendicular
  }
}

export const __testing = {
  EARTH_RADIUS_M,
  wrap2Pi,
  wrapDLon
}
