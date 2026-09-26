import { clamp } from '@/core/math.js';
import type { Vec2 } from '@/core/math.js';
import { vec2 } from '@/core/math.js';
import type { Body, Team } from './combat/types.js';

/**
 * Broad-phase spatial index. Cell size matches the PRD's 16-metre grid, not the tightest fit for
 * any one collider — a helicopter, a rocket and a rifle round all share the same hash so one
 * structure serves every query in the frame instead of three.
 *
 * Bodies are indexed by position only, one cell each. Query methods widen the scan to every cell
 * the query shape's bounding box touches, so a body sitting in a neighbouring cell is still found
 * — the single-cell insert stays correct as long as the query side accounts for the grid.
 */
export class SpatialHash {
  private readonly cells = new Map<number, Body[]>();
  private bodyCount = 0;

  constructor(readonly cellSize = 16) {}

  get size(): number {
    return this.bodyCount;
  }

  clear(): void {
    this.cells.clear();
    this.bodyCount = 0;
  }

  insert(body: Body): void {
    const key = this.cellKeyForPoint(body.position.x, body.position.y);
    let bucket = this.cells.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(body);
    this.bodyCount++;
  }

  queryCircle(center: Vec2, radius: number, out: Body[], team?: Team): Body[] {
    out.length = 0;
    const minCx = this.cellIndex(center.x - radius);
    const maxCx = this.cellIndex(center.x + radius);
    const minCy = this.cellIndex(center.y - radius);
    const maxCy = this.cellIndex(center.y + radius);
    const radiusSq = radius * radius;

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(this.cellKey(cx, cy));
        if (bucket === undefined) continue;
        for (const body of bucket) {
          if (team !== undefined && body.team !== team) continue;
          const dx = body.position.x - center.x;
          const dy = body.position.y - center.y;
          if (dx * dx + dy * dy <= radiusSq) out.push(body);
        }
      }
    }

    // Cell scan order depends only on grid coordinates, but bodies sharing a cell keep whatever
    // order they were inserted in — sort so replays and parallel queries never see a different
    // pairing order from the same world state.
    out.sort(compareById);
    return out;
  }

  queryAabb(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    out: Body[],
    team?: Team,
  ): Body[] {
    out.length = 0;
    const minCx = this.cellIndex(minX);
    const maxCx = this.cellIndex(maxX);
    const minCy = this.cellIndex(minY);
    const maxCy = this.cellIndex(maxY);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(this.cellKey(cx, cy));
        if (bucket === undefined) continue;
        for (const body of bucket) {
          if (team !== undefined && body.team !== team) continue;
          const { x, y } = body.position;
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(body);
        }
      }
    }

    out.sort(compareById);
    return out;
  }

  private cellIndex(coordinate: number): number {
    return Math.floor(coordinate / this.cellSize);
  }

  private cellKeyForPoint(x: number, y: number): number {
    return this.cellKey(this.cellIndex(x), this.cellIndex(y));
  }

  // Packs two signed cell coordinates into one integer key. The offset re-centres each axis into
  // 16 bits of unsigned range before packing, which covers a world roughly ±524km at 16m cells —
  // comfortably beyond anything this game's terrain spans — without allocating a string per cell
  // the way a template-literal key would on every insert and every query.
  private cellKey(cx: number, cy: number): number {
    const CELL_KEY_OFFSET = 1 << 15;
    return ((cx + CELL_KEY_OFFSET) << 16) | (cy + CELL_KEY_OFFSET);
  }
}

const compareById = (a: Body, b: Body): number => a.id - b.id;

// --- Narrow phase ------------------------------------------------------------------------------
//
// Every pair test below reads Body/Collider fields into scratch Vec2s rather than constructing
// fresh ones. Narrow phase runs once per broad-phase candidate pair, every tick — the allocations
// that the broad phase avoids by reusing caller-supplied arrays would otherwise reappear here.
const scratchSegA: Vec2 = vec2();
const scratchSegB: Vec2 = vec2();
const scratchSegA2: Vec2 = vec2();
const scratchSegB2: Vec2 = vec2();
const scratchLocalA: Vec2 = vec2();
const scratchLocalB: Vec2 = vec2();
const scratchPoint: Vec2 = vec2();
const scratchCorner0: Vec2 = vec2();
const scratchCorner1: Vec2 = vec2();
const scratchCorner2: Vec2 = vec2();
const scratchCorner3: Vec2 = vec2();

/** Closest point on segment `[a, b]` to `p`, written into `out`. Returns `out`. */
export const closestPointOnSegment = (out: Vec2, p: Vec2, a: Vec2, b: Vec2): Vec2 => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq <= 1e-12) {
    out.x = a.x;
    out.y = a.y;
    return out;
  }
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq, 0, 1);
  out.x = a.x + abx * t;
  out.y = a.y + aby * t;
  return out;
};

/** World-space endpoints of a capsule's core segment, written into `outA`/`outB`. */
const capsuleSegment = (body: Body, outA: Vec2, outB: Vec2): void => {
  const { position, collider } = body;
  const dx = Math.cos(collider.angle) * collider.halfWidth;
  const dy = Math.sin(collider.angle) * collider.halfWidth;
  outA.x = position.x - dx;
  outA.y = position.y - dy;
  outB.x = position.x + dx;
  outB.y = position.y + dy;
};

/** Transforms a world point into a box's local (unrotated, origin-centred) frame. */
const worldToBoxLocal = (worldPoint: Vec2, boxBody: Body, out: Vec2): void => {
  const { position, collider } = boxBody;
  const dx = worldPoint.x - position.x;
  const dy = worldPoint.y - position.y;
  const cos = Math.cos(-collider.angle);
  const sin = Math.sin(-collider.angle);
  out.x = dx * cos - dy * sin;
  out.y = dx * sin + dy * cos;
};

const pointInAabb = (p: Vec2, halfWidth: number, halfHeight: number): boolean =>
  Math.abs(p.x) <= halfWidth && Math.abs(p.y) <= halfHeight;

/**
 * Squared distance between two segments (Ericson, *Real-Time Collision Detection*,
 * `ClosestPtSegmentSegment`, distance-only). Handles degenerate (zero-length) segments as points
 * rather than dividing by zero.
 */
const segmentSegmentDistSq = (p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2): number => {
  const EPS = 1e-12;
  const d1x = q1.x - p1.x;
  const d1y = q1.y - p1.y;
  const d2x = q2.x - p2.x;
  const d2y = q2.y - p2.y;
  const rx = p1.x - p2.x;
  const ry = p1.y - p2.y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;

  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  const c1x = p1.x + d1x * s;
  const c1y = p1.y + d1y * s;
  const c2x = p2.x + d2x * t;
  const c2y = p2.y + d2y * t;
  const dx = c1x - c2x;
  const dy = c1y - c2y;
  return dx * dx + dy * dy;
};

const circleOverlapsCircle = (a: Body, b: Body): boolean => {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  const rr = a.collider.radius + b.collider.radius;
  return dx * dx + dy * dy <= rr * rr;
};

const circleOverlapsCapsule = (circleBody: Body, capsuleBody: Body): boolean => {
  capsuleSegment(capsuleBody, scratchSegA, scratchSegB);
  closestPointOnSegment(scratchPoint, circleBody.position, scratchSegA, scratchSegB);
  const dx = circleBody.position.x - scratchPoint.x;
  const dy = circleBody.position.y - scratchPoint.y;
  const rr = circleBody.collider.radius + capsuleBody.collider.radius;
  return dx * dx + dy * dy <= rr * rr;
};

const circleOverlapsBox = (circleBody: Body, boxBody: Body): boolean => {
  worldToBoxLocal(circleBody.position, boxBody, scratchPoint);
  const { halfWidth, halfHeight } = boxBody.collider;
  const closestX = clamp(scratchPoint.x, -halfWidth, halfWidth);
  const closestY = clamp(scratchPoint.y, -halfHeight, halfHeight);
  const dx = scratchPoint.x - closestX;
  const dy = scratchPoint.y - closestY;
  const r = circleBody.collider.radius;
  return dx * dx + dy * dy <= r * r;
};

const capsuleOverlapsCapsule = (a: Body, b: Body): boolean => {
  capsuleSegment(a, scratchSegA, scratchSegB);
  capsuleSegment(b, scratchSegA2, scratchSegB2);
  const rr = a.collider.radius + b.collider.radius;
  return segmentSegmentDistSq(scratchSegA, scratchSegB, scratchSegA2, scratchSegB2) <= rr * rr;
};

const capsuleOverlapsBox = (capsuleBody: Body, boxBody: Body): boolean => {
  capsuleSegment(capsuleBody, scratchSegA, scratchSegB);
  worldToBoxLocal(scratchSegA, boxBody, scratchLocalA);
  worldToBoxLocal(scratchSegB, boxBody, scratchLocalB);
  const { halfWidth, halfHeight } = boxBody.collider;

  // A capsule endpoint resting inside the box crosses no edge, so the edge-distance loop below
  // would miss it entirely — check containment first.
  if (pointInAabb(scratchLocalA, halfWidth, halfHeight)) return true;
  if (pointInAabb(scratchLocalB, halfWidth, halfHeight)) return true;

  scratchCorner0.x = -halfWidth;
  scratchCorner0.y = -halfHeight;
  scratchCorner1.x = halfWidth;
  scratchCorner1.y = -halfHeight;
  scratchCorner2.x = halfWidth;
  scratchCorner2.y = halfHeight;
  scratchCorner3.x = -halfWidth;
  scratchCorner3.y = halfHeight;

  const rr = capsuleBody.collider.radius * capsuleBody.collider.radius;
  if (segmentSegmentDistSq(scratchLocalA, scratchLocalB, scratchCorner0, scratchCorner1) <= rr)
    return true;
  if (segmentSegmentDistSq(scratchLocalA, scratchLocalB, scratchCorner1, scratchCorner2) <= rr)
    return true;
  if (segmentSegmentDistSq(scratchLocalA, scratchLocalB, scratchCorner2, scratchCorner3) <= rr)
    return true;
  if (segmentSegmentDistSq(scratchLocalA, scratchLocalB, scratchCorner3, scratchCorner0) <= rr)
    return true;
  return false;
};

/** Projected half-extent of an oriented box onto axis `(lx, ly)` (assumed unit length). */
const boxAxisProjection = (
  lx: number,
  ly: number,
  angle: number,
  halfWidth: number,
  halfHeight: number,
): number => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return Math.abs(cos * lx + sin * ly) * halfWidth + Math.abs(-sin * lx + cos * ly) * halfHeight;
};

/**
 * Oriented box vs oriented box via separating axis theorem. Two rectangles only ever need each
 * box's own two (perpendicular) axes — unlike 3D SAT there is no edge-cross-product case, because
 * a 2D rectangle's face normals already are its only two candidate axes.
 */
const boxOverlapsBox = (a: Body, b: Body): boolean => {
  const ca = a.collider;
  const cb = b.collider;
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;

  const axes: ReadonlyArray<readonly [number, number]> = [
    [Math.cos(ca.angle), Math.sin(ca.angle)],
    [-Math.sin(ca.angle), Math.cos(ca.angle)],
    [Math.cos(cb.angle), Math.sin(cb.angle)],
    [-Math.sin(cb.angle), Math.cos(cb.angle)],
  ];

  for (const axis of axes) {
    const [lx, ly] = axis;
    const dist = Math.abs(dx * lx + dy * ly);
    const rA = boxAxisProjection(lx, ly, ca.angle, ca.halfWidth, ca.halfHeight);
    const rB = boxAxisProjection(lx, ly, cb.angle, cb.halfWidth, cb.halfHeight);
    if (dist > rA + rB) return false;
  }
  return true;
};

export const overlaps = (a: Body, b: Body): boolean => {
  const ka = a.collider.kind;
  const kb = b.collider.kind;
  if (ka === 'circle' && kb === 'circle') return circleOverlapsCircle(a, b);
  if (ka === 'circle' && kb === 'capsule') return circleOverlapsCapsule(a, b);
  if (ka === 'capsule' && kb === 'circle') return circleOverlapsCapsule(b, a);
  if (ka === 'circle' && kb === 'box') return circleOverlapsBox(a, b);
  if (ka === 'box' && kb === 'circle') return circleOverlapsBox(b, a);
  if (ka === 'capsule' && kb === 'capsule') return capsuleOverlapsCapsule(a, b);
  if (ka === 'capsule' && kb === 'box') return capsuleOverlapsBox(a, b);
  if (ka === 'box' && kb === 'capsule') return capsuleOverlapsBox(b, a);
  return boxOverlapsBox(a, b); // only box/box is left
};

// --- Raycasts ------------------------------------------------------------------------------

const RAY_EPS = 1e-9;

/**
 * A ray whose start point is already inside a shape reports contact at `t = 0` rather than `null`
 * or a negative root — callers (line-of-sight, tunnelling checks) always want "blocked from here"
 * to read as an immediate hit, not as "no intersection found".
 */
const raycastCircleAt = (
  from: Vec2,
  to: Vec2,
  cx: number,
  cy: number,
  radius: number,
): number | null => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const fx = from.x - cx;
  const fy = from.y - cy;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a <= RAY_EPS) return null;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return null;
  return t;
};

const raycastCircle = (from: Vec2, to: Vec2, body: Body): number | null =>
  raycastCircleAt(from, to, body.position.x, body.position.y, body.collider.radius);

/** Ray `[from, to]` (t in [0,1]) against finite segment `[a, b]` (u in [0,1]). */
const raySegmentIntersection = (from: Vec2, to: Vec2, a: Vec2, b: Vec2): number | null => {
  const rx = to.x - from.x;
  const ry = to.y - from.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < RAY_EPS) return null;
  const qpx = a.x - from.x;
  const qpy = a.y - from.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
};

const takeEarliest = (best: number | null, candidate: number | null): number | null => {
  if (candidate === null) return best;
  if (best === null || candidate < best) return candidate;
  return best;
};

/**
 * A capsule is a stadium shape: two end-cap circles plus two straight sides offset from the core
 * segment by `radius`. Raycasting it means testing all four pieces and keeping the earliest hit —
 * there is no single closed-form test the way there is for a circle or an axis-aligned box.
 */
const raycastCapsule = (from: Vec2, to: Vec2, body: Body): number | null => {
  capsuleSegment(body, scratchSegA, scratchSegB);
  const radius = body.collider.radius;

  closestPointOnSegment(scratchPoint, from, scratchSegA, scratchSegB);
  const sdx = from.x - scratchPoint.x;
  const sdy = from.y - scratchPoint.y;
  if (sdx * sdx + sdy * sdy <= radius * radius) return 0;

  const dirX = scratchSegB.x - scratchSegA.x;
  const dirY = scratchSegB.y - scratchSegA.y;
  const len = Math.sqrt(dirX * dirX + dirY * dirY);
  if (len <= RAY_EPS) return raycastCircleAt(from, to, scratchSegA.x, scratchSegA.y, radius);

  const nx = (-dirY / len) * radius;
  const ny = (dirX / len) * radius;

  let best: number | null = null;
  best = takeEarliest(
    best,
    raySegmentIntersection(
      from,
      to,
      { x: scratchSegA.x + nx, y: scratchSegA.y + ny },
      { x: scratchSegB.x + nx, y: scratchSegB.y + ny },
    ),
  );
  best = takeEarliest(
    best,
    raySegmentIntersection(
      from,
      to,
      { x: scratchSegA.x - nx, y: scratchSegA.y - ny },
      { x: scratchSegB.x - nx, y: scratchSegB.y - ny },
    ),
  );
  best = takeEarliest(best, raycastCircleAt(from, to, scratchSegA.x, scratchSegA.y, radius));
  best = takeEarliest(best, raycastCircleAt(from, to, scratchSegB.x, scratchSegB.y, radius));
  return best;
};

/** Slab test against an axis-aligned box centred on the origin, in the box's own local frame. */
const raycastAabbLocal = (
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  halfWidth: number,
  halfHeight: number,
): number | null => {
  const dx = tx - fx;
  const dy = ty - fy;
  // Starting the interval at [0, 1] (rather than [-Infinity, Infinity]) folds the segment clamp
  // into the slab intersection directly, and makes a start-inside ray naturally settle on t = 0.
  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < RAY_EPS) {
    if (fx < -halfWidth || fx > halfWidth) return null;
  } else {
    let t1 = (-halfWidth - fx) / dx;
    let t2 = (halfWidth - fx) / dx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  if (Math.abs(dy) < RAY_EPS) {
    if (fy < -halfHeight || fy > halfHeight) return null;
  } else {
    let t1 = (-halfHeight - fy) / dy;
    let t2 = (halfHeight - fy) / dy;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin;
};

const raycastBox = (from: Vec2, to: Vec2, body: Body): number | null => {
  const { position, collider } = body;
  const cos = Math.cos(-collider.angle);
  const sin = Math.sin(-collider.angle);
  const relFromX = from.x - position.x;
  const relFromY = from.y - position.y;
  const relToX = to.x - position.x;
  const relToY = to.y - position.y;
  const localFromX = relFromX * cos - relFromY * sin;
  const localFromY = relFromX * sin + relFromY * cos;
  const localToX = relToX * cos - relToY * sin;
  const localToY = relToX * sin + relToY * cos;
  return raycastAabbLocal(
    localFromX,
    localFromY,
    localToX,
    localToY,
    collider.halfWidth,
    collider.halfHeight,
  );
};

/** Parametric `t` in `[0, 1]` of the first contact between segment `[from, to]` and `body`, or `null`. */
export const raycast = (from: Vec2, to: Vec2, body: Body): number | null => {
  switch (body.collider.kind) {
    case 'circle':
      return raycastCircle(from, to, body);
    case 'capsule':
      return raycastCapsule(from, to, body);
    case 'box':
      return raycastBox(from, to, body);
  }
};

/** True if any body blocks the straight line `[from, to]`. `excludeId` skips the ray's own source. */
export const segmentBlocked = (
  from: Vec2,
  to: Vec2,
  bodies: readonly Body[],
  excludeId?: Body['id'],
): boolean => {
  for (const body of bodies) {
    if (excludeId !== undefined && body.id === excludeId) continue;
    if (raycast(from, to, body) !== null) return true;
  }
  return false;
};
