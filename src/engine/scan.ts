/**
 * Scan clean-up: estimating how far a scanned page is rotated off straight.
 *
 * Lines of text make dark horizontal bands. Projecting the dark pixels onto the vertical axis at
 * the right angle gives the sharpest bands, so the angle whose projection has the largest sum of
 * squares is the page's skew.
 */

/** Skew in degrees of a grayscale image: positive when lines fall to the right (y grows). */
export function skewAngle(gray: Uint8Array | Uint8ClampedArray, width: number, height: number, maxAngle = 12): number {
  // Dark pixels, sampled by column so large pages stay fast. Every row is kept: skipping rows
  // would make angles near zero, where sampled rows line up with the bins, score too well.
  const xs: number[] = []
  const ys: number[] = []
  const step = Math.max(1, Math.round((width * height) / 500_000))
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x += step)
      if (gray[y * width + x] < 128) {
        xs.push(x)
        ys.push(y)
      }
  // Too little ink (a blank page) or too much (a photo) has no meaningful skew.
  const sampled = Math.ceil(width / step) * height
  if (xs.length < 200 || xs.length > sampled * 0.5) return 0

  const bins = new Float64Array(height + width + 2)
  const score = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180)
    bins.fill(0)
    const offset = width
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] - xs[i] * t + offset * Math.abs(t))]++
    let s = 0
    for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i]
    return s
  }
  const search = (from: number, to: number, by: number) => {
    let best = 0
    let bestScore = -1
    for (let a = from; a <= to + 1e-9; a += by) {
      const s = score(a)
      if (s > bestScore) {
        bestScore = s
        best = a
      }
    }
    return best
  }
  const coarse = search(-maxAngle, maxAngle, 0.5)
  const fine = search(coarse - 0.5, coarse + 0.5, 0.05)
  return Math.round(fine * 100) / 100 || 0
}

/** A content-stream matrix rotating by `deg` degrees (counterclockwise in PDF space) about (cx, cy). */
export function rotationAbout(deg: number, cx: number, cy: number): [number, number, number, number, number, number] {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, cx - (c * cx - s * cy), cy - (s * cx + c * cy)]
}
