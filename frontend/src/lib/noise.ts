/**
 * Tiny value-noise utility — used by the Orb's organic edge wobble.
 *
 * Why value noise instead of Perlin / simplex: those are 2-3× more
 * code and we only need a smooth, deterministic 1D function for
 * "wavy radius around a circle". Value noise — hashing a 1D lattice
 * and lerping with smoothstep — is ~20 lines, fully sufficient, and
 * looks smooth enough that nobody can tell the difference at the
 * frequencies we use here.
 *
 * Hash: classic `sin * large_prime fract` trick. Not statistically
 * great, but the orb edge isn't a random number generator stress test
 * — visually, it's indistinguishable from a real PRNG hash.
 *
 * Layered noise: callers usually want fractal noise (sum of multiple
 * frequencies) for richer texture. `fractalNoise1D` does that with
 * 3 octaves at amplitude/2 and frequency*2 each step.
 */

function hash(n: number): number {
  // Add a constant so noise(0) ≠ 0; keeps the orb from having a
  // visually-weird seam at the angle-zero direction.
  const v = (Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1;
  return v < 0 ? v + 1 : v;
}

export function noise1D(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash(i);
  const b = hash(i + 1);
  // Smoothstep — the easing curve that turns a jagged lattice into a
  // smooth function.
  const u = f * f * (3 - 2 * f);
  return a * (1 - u) + b * u;
}

/**
 * Sum of N octaves of value noise. Each octave doubles frequency and
 * halves amplitude — gives a fractal feel without much extra cost.
 *
 * Output is roughly in [0, 1]; the exact range is amplitude-dependent
 * but for octaves=3 the upper bound is 1 + 1/2 + 1/4 = 1.75 / 1.75 ≈ 1
 * (we divide by the sum-of-amplitudes for normalisation).
 */
export function fractalNoise1D(x: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise1D(x * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ---------------------------------------------------------------------------
 * 2D value noise.
 *
 * The orb wants topology that *evolves over time* — not a 1D pattern
 * sliding along itself. With 2D noise the (angle, time) pair maps to a
 * surface and we walk a path through it; every angular position's value
 * becomes independent of every other one.
 *
 * Same hash trick, just two-dimensional. Bilinear interp + smoothstep
 * gives the smooth surface.
 * --------------------------------------------------------------------------*/

function hash2(x: number, y: number): number {
  const v = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  return v < 0 ? v + 1 : v;
}

export function noise2D(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return (
    a * (1 - u) * (1 - v) +
    b * u * (1 - v) +
    c * (1 - u) * v +
    d * u * v
  );
}

export function fractalNoise2D(x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2D(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Polar noise — designed for radius modulation around a circle.
 *
 * Naïvely passing `theta` to noise breaks at θ = 2π (seam where the
 * noise value at angle ≈0 differs from angle ≈2π). We avoid that by
 * sampling on a circle in noise space: nx = cos(θ)·R, ny = sin(θ)·R.
 * Now every closed loop of θ traces a closed loop in noise space, so
 * the radius function is automatically seamless.
 *
 * The `tx, ty` offset is a slow drift through the noise field so the
 * pattern doesn't just rotate — it ACTUALLY changes shape over time.
 *
 * `freqRadius` controls how dense the bumps are around the circle
 * (higher = more lobes); typical 1.5–4.
 */
export function polarNoise(
  theta: number,
  freqRadius: number,
  tx: number,
  ty: number,
  octaves = 3,
): number {
  const nx = Math.cos(theta) * freqRadius + tx;
  const ny = Math.sin(theta) * freqRadius + ty;
  return fractalNoise2D(nx, ny, octaves);
}

/* ---------------------------------------------------------------------------
 * 3D value noise.
 *
 * Why bother with a third dimension when the orb membrane is 1D
 * (radius vs. angle)? Because 2D noise + linear time drift produces
 * patterns that *slide* — bumps appear at fixed angular positions and
 * the whole pattern translates over time. With 3D noise we put time
 * on its own orthogonal axis, so each angular slot's radius value is
 * independent of every other angular slot at every moment. Bumps
 * fade in and out at random positions, which is what real organic
 * membranes do.
 *
 * Cost: 8 hashes + a trilinear interp per call vs. 4 + bilinear in
 * 2D. ~2× more work but at our sample rates (≤50k calls/sec) it's
 * still under 1ms per frame.
 * --------------------------------------------------------------------------*/

function hash3(x: number, y: number, z: number): number {
  const v =
    (Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1;
  return v < 0 ? v + 1 : v;
}

export function noise3D(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  // 8 lattice-corner samples — the canonical 3D value-noise stencil.
  const a000 = hash3(xi, yi, zi);
  const a100 = hash3(xi + 1, yi, zi);
  const a010 = hash3(xi, yi + 1, zi);
  const a110 = hash3(xi + 1, yi + 1, zi);
  const a001 = hash3(xi, yi, zi + 1);
  const a101 = hash3(xi + 1, yi, zi + 1);
  const a011 = hash3(xi, yi + 1, zi + 1);
  const a111 = hash3(xi + 1, yi + 1, zi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  // Trilinear interp via 4 lerps along x, then 2 along y, then 1 along z.
  const x00 = a000 * (1 - u) + a100 * u;
  const x10 = a010 * (1 - u) + a110 * u;
  const x01 = a001 * (1 - u) + a101 * u;
  const x11 = a011 * (1 - u) + a111 * u;
  const y0 = x00 * (1 - v) + x10 * v;
  const y1 = x01 * (1 - v) + x11 * v;
  return y0 * (1 - w) + y1 * w;
}

export function fractalNoise3D(
  x: number,
  y: number,
  z: number,
  octaves = 3,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3D(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Polar noise with TIME on a third, orthogonal axis.
 *
 * Sampling: nx = cos(θ)·R, ny = sin(θ)·R, nz = t·timeFreq.
 *
 * - Every closed loop in θ stays on a closed loop in (nx, ny), so the
 *   wrap-around at θ = 2π is automatically seamless (same trick as
 *   2D polarNoise).
 * - Time advances along nz, which is orthogonal to the (nx, ny) plane.
 *   This means at any fixed θ, the value over time is an independent
 *   1D sample of the noise field — uncorrelated to other angles.
 * - Net effect: bumps appear, evolve, and disappear at *random*
 *   angular positions, instead of the same lobes pulsing in place.
 *
 * `timeFreq` is the speed at which bumps fade in/out. 0.3 = slow
 * evolution (3-second bubble lifetime), 1.0 = fast (~1s).
 */
export function polarNoise3D(
  theta: number,
  freqRadius: number,
  time: number,
  timeFreq: number,
  octaves = 3,
): number {
  const nx = Math.cos(theta) * freqRadius;
  const ny = Math.sin(theta) * freqRadius;
  const nz = time * timeFreq;
  return fractalNoise3D(nx, ny, nz, octaves);
}
