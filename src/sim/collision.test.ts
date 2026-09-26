import { describe, expect, it } from 'vitest';
import { box, capsule, circle, type Body } from './combat/types.js';
import {
  SpatialHash,
  closestPointOnSegment,
  overlaps,
  raycast,
  segmentBlocked,
} from './collision.js';

let nextId = 1;
const makeBody = (x: number, y: number, collider: Body['collider']): Body => ({
  id: nextId++,
  team: 'hostile',
  position: { x, y },
  collider,
});

describe('closestPointOnSegment', () => {
  it('clamps to the near endpoint when the point projects past the segment', () => {
    const out = { x: 0, y: 0 };
    closestPointOnSegment(out, { x: -5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it('projects perpendicularly onto the segment interior', () => {
    const out = { x: 0, y: 0 };
    closestPointOnSegment(out, { x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(out).toEqual({ x: 5, y: 0 });
  });

  it('returns the shared point for a degenerate zero-length segment', () => {
    const out = { x: 0, y: 0 };
    closestPointOnSegment(out, { x: 9, y: 9 }, { x: 2, y: 2 }, { x: 2, y: 2 });
    expect(out).toEqual({ x: 2, y: 2 });
  });
});

describe('overlaps: circle vs circle', () => {
  it('overlaps when centres are closer than the summed radii', () => {
    const a = makeBody(0, 0, circle(2));
    const b = makeBody(3, 0, circle(2));
    expect(overlaps(a, b)).toBe(true);
  });

  it('does not overlap when centres are farther than the summed radii', () => {
    const a = makeBody(0, 0, circle(2));
    const b = makeBody(10, 0, circle(2));
    expect(overlaps(a, b)).toBe(false);
  });

  it('counts exact edge contact as overlapping', () => {
    const a = makeBody(0, 0, circle(2));
    const b = makeBody(5, 0, circle(3));
    expect(overlaps(a, b)).toBe(true);
  });
});

describe('overlaps: circle vs capsule', () => {
  it('overlaps a capsule lying along its length', () => {
    const c = makeBody(5, 1, circle(1));
    const cap = makeBody(0, 0, capsule(1, 10, 0));
    expect(overlaps(c, cap)).toBe(true);
    expect(overlaps(cap, c)).toBe(true);
  });

  it('overlaps a rotated capsule near its end cap', () => {
    const cap = makeBody(0, 0, capsule(1, 5, Math.PI / 2)); // vertical, spans y in [-5, 5]
    const c = makeBody(0, 5.5, circle(1));
    expect(overlaps(c, cap)).toBe(true);
  });

  it('does not overlap when well clear of the capsule', () => {
    const c = makeBody(0, 10, circle(1));
    const cap = makeBody(0, 0, capsule(1, 5, 0));
    expect(overlaps(c, cap)).toBe(false);
  });

  it('counts exact contact at the rounded cap as overlapping', () => {
    const cap = makeBody(0, 0, capsule(2, 4, 0)); // core segment x in [-4, 4], radius 2
    const c = makeBody(7, 0, circle(1)); // touches at x = 6
    expect(overlaps(c, cap)).toBe(true);
  });
});

describe('overlaps: circle vs box', () => {
  it('overlaps an axis-aligned box when inside its extent', () => {
    const c = makeBody(1, 1, circle(1));
    const b = makeBody(0, 0, box(3, 3, 0));
    expect(overlaps(c, b)).toBe(true);
  });

  it('does not overlap when the AABB would falsely suggest a hit but the box is rotated away', () => {
    // Box rotated 45deg has an axis-aligned bounding box of about ±2.83 on both axes. (2.8, 2.8)
    // sits inside that naive AABB, but is well clear of the actual rotated rectangle — only the
    // exact oriented test rejects it correctly.
    const b = makeBody(0, 0, box(3, 1, Math.PI / 4));
    const c = makeBody(2.8, 2.8, circle(0.3));
    expect(overlaps(c, b)).toBe(false);
  });

  it('overlaps a rotated box along its actual long axis', () => {
    const b = makeBody(0, 0, box(3, 1, Math.PI / 4));
    // Point along the rotated long axis, just inside the far end.
    const along = { x: 2.9 * Math.SQRT1_2, y: 2.9 * Math.SQRT1_2 };
    const c = makeBody(along.x, along.y, circle(0.2));
    expect(overlaps(c, b)).toBe(true);
  });

  it('does not overlap when far from the box', () => {
    const c = makeBody(100, 100, circle(1));
    const b = makeBody(0, 0, box(3, 3, 0));
    expect(overlaps(c, b)).toBe(false);
  });

  it('counts exact edge contact as overlapping', () => {
    const b = makeBody(0, 0, box(2, 2, 0));
    const c = makeBody(3, 0, circle(1)); // touches box edge at x = 2
    expect(overlaps(c, b)).toBe(true);
  });
});

describe('overlaps: capsule vs capsule', () => {
  it('overlaps when the core segments cross', () => {
    const a = makeBody(0, 0, capsule(0.5, 5, 0)); // horizontal
    const b = makeBody(0, 0, capsule(0.5, 5, Math.PI / 2)); // vertical, same centre
    expect(overlaps(a, b)).toBe(true);
  });

  it('does not overlap two parallel, well-separated capsules', () => {
    const a = makeBody(0, 0, capsule(1, 5, 0));
    const b = makeBody(0, 10, capsule(1, 5, 0));
    expect(overlaps(a, b)).toBe(false);
  });

  it('counts exact side-by-side contact as overlapping', () => {
    const a = makeBody(0, 0, capsule(1, 5, 0));
    const b = makeBody(0, 2, capsule(1, 5, 0)); // radii sum to 2, centres 2 apart
    expect(overlaps(a, b)).toBe(true);
  });
});

describe('overlaps: capsule vs box', () => {
  it('overlaps when a capsule endpoint rests inside the box', () => {
    const cap = makeBody(-5, 0, capsule(0.5, 3, 0)); // spans x in [-8, -2]
    const b = makeBody(0, 0, box(3, 3, 0)); // spans x in [-3, 3]
    expect(overlaps(cap, b)).toBe(true);
  });

  it('overlaps when a capsule crosses through a rotated box', () => {
    const b = makeBody(0, 0, box(3, 1, Math.PI / 4));
    const cap = makeBody(0, 0, capsule(0.3, 5, 0));
    expect(overlaps(cap, b)).toBe(true);
  });

  it('does not overlap when the capsule misses the box entirely', () => {
    const cap = makeBody(0, 20, capsule(1, 3, 0));
    const b = makeBody(0, 0, box(3, 3, 0));
    expect(overlaps(cap, b)).toBe(false);
  });

  it('counts exact edge contact as overlapping', () => {
    const b = makeBody(0, 0, box(2, 2, 0)); // spans x in [-2, 2]
    // Core segment spans x in [3, 5]; its nearest point (3, 0) sits exactly `radius` away
    // from the box's right edge (x = 2).
    const cap = makeBody(4, 0, capsule(1, 1, 0));
    expect(overlaps(cap, b)).toBe(true);
  });
});

describe('overlaps: box vs box', () => {
  it('overlaps two axis-aligned boxes with intersecting extents', () => {
    const a = makeBody(0, 0, box(2, 2, 0));
    const b = makeBody(3, 0, box(2, 2, 0));
    expect(overlaps(a, b)).toBe(true);
  });

  it('does not overlap two well-separated axis-aligned boxes', () => {
    const a = makeBody(0, 0, box(2, 2, 0));
    const b = makeBody(20, 0, box(2, 2, 0));
    expect(overlaps(a, b)).toBe(false);
  });

  it('overlaps two long thin rotated boxes crossing like an X', () => {
    const a = makeBody(0, 0, box(4, 0.2, Math.PI / 4));
    const b = makeBody(0, 0, box(4, 0.2, -Math.PI / 4));
    expect(overlaps(a, b)).toBe(true);
  });

  it('separates two parallel rotated boxes whose axis-aligned bounding boxes overlap but the shapes do not', () => {
    // Two parallel diagonal strips offset sideways by 2m, well past their combined 0.6m of
    // half-height — but each strip's own AABB is a ~2.33m-radius square around a 45deg
    // rectangle, so the AABBs still overlap. Only the oriented test can tell them apart.
    const angle = Math.PI / 4;
    const perpX = -Math.sin(angle);
    const perpY = Math.cos(angle);
    const a = makeBody(0, 0, box(3, 0.3, angle));
    const b = makeBody(perpX * 2, perpY * 2, box(3, 0.3, angle));
    expect(overlaps(a, b)).toBe(false);
  });

  it('counts exact edge contact as overlapping', () => {
    const a = makeBody(0, 0, box(2, 2, 0));
    const b = makeBody(4, 0, box(2, 2, 0)); // edges touch at x = 2
    expect(overlaps(a, b)).toBe(true);
  });
});

describe('raycast: circle', () => {
  it('hits a circle straight ahead', () => {
    const c = makeBody(10, 0, circle(1));
    const t = raycast({ x: 0, y: 0 }, { x: 20, y: 0 }, c);
    expect(t).not.toBeNull();
    expect(t as number).toBeCloseTo(0.45, 5);
  });

  it('misses a circle off to the side', () => {
    const c = makeBody(10, 5, circle(1));
    const t = raycast({ x: 0, y: 0 }, { x: 20, y: 0 }, c);
    expect(t).toBeNull();
  });

  it('reports t = 0 when the ray starts inside the circle', () => {
    const c = makeBody(0, 0, circle(2));
    const t = raycast({ x: 0.5, y: 0 }, { x: 20, y: 0 }, c);
    expect(t).toBe(0);
  });
});

describe('raycast: capsule', () => {
  it('hits the flat side of a horizontal capsule', () => {
    const cap = makeBody(5, 0, capsule(1, 3, 0)); // spans x in [2, 8], radius 1
    const t = raycast({ x: 5, y: -10 }, { x: 5, y: 10 }, cap);
    expect(t).not.toBeNull();
    expect(t as number).toBeCloseTo(0.45, 5);
  });

  it('hits the rounded end cap of a capsule', () => {
    const cap = makeBody(0, 0, capsule(1, 3, 0)); // spans x in [-3, 3], radius 1
    const t = raycast({ x: 10, y: 0 }, { x: -10, y: 0 }, cap);
    expect(t).not.toBeNull();
    // End cap circle spans x in [2, 4]; the ray travels from x = 10 toward x = -10.
    expect(t as number).toBeCloseTo(0.3, 5);
  });

  it('misses a capsule entirely off its line', () => {
    const cap = makeBody(0, 0, capsule(1, 3, 0));
    const t = raycast({ x: -10, y: 10 }, { x: 10, y: 10 }, cap);
    expect(t).toBeNull();
  });

  it('reports t = 0 when the ray starts inside the capsule', () => {
    const cap = makeBody(0, 0, capsule(1, 3, 0));
    const t = raycast({ x: 0, y: 0 }, { x: 10, y: 0 }, cap);
    expect(t).toBe(0);
  });
});

describe('raycast: box', () => {
  it('hits an axis-aligned box straight on', () => {
    const b = makeBody(10, 0, box(2, 2, 0));
    const t = raycast({ x: 0, y: 0 }, { x: 20, y: 0 }, b);
    expect(t).not.toBeNull();
    expect(t as number).toBeCloseTo(0.4, 5);
  });

  it('hits a rotated box at the angle-adjusted contact point', () => {
    const b = makeBody(10, 0, box(4, 1, Math.PI / 4));
    const t = raycast({ x: 0, y: 0 }, { x: 20, y: 0 }, b);
    expect(t).not.toBeNull();
  });

  it('misses a box entirely off the ray', () => {
    const b = makeBody(10, 20, box(2, 2, 0));
    const t = raycast({ x: 0, y: 0 }, { x: 20, y: 0 }, b);
    expect(t).toBeNull();
  });

  it('reports t = 0 when the ray starts inside the box', () => {
    const b = makeBody(0, 0, box(5, 5, 0));
    const t = raycast({ x: 0, y: 0 }, { x: 20, y: 0 }, b);
    expect(t).toBe(0);
  });

  it('misses a box when the ray runs parallel to its edge outside its extent', () => {
    const b = makeBody(0, 0, box(2, 2, 0));
    const t = raycast({ x: -10, y: 5 }, { x: 10, y: 5 }, b);
    expect(t).toBeNull();
  });
});

describe('segmentBlocked', () => {
  it('is blocked when any body sits on the segment', () => {
    const bodies = [makeBody(5, 0, circle(1)), makeBody(-5, 0, circle(1))];
    expect(segmentBlocked({ x: 0, y: 0 }, { x: 10, y: 0 }, bodies)).toBe(true);
  });

  it('is clear when no body sits on the segment', () => {
    const bodies = [makeBody(5, 50, circle(1))];
    expect(segmentBlocked({ x: 0, y: 0 }, { x: 10, y: 0 }, bodies)).toBe(false);
  });

  it('ignores the excluded body id', () => {
    const shooter = makeBody(5, 0, circle(1));
    expect(segmentBlocked({ x: 0, y: 0 }, { x: 10, y: 0 }, [shooter], shooter.id)).toBe(false);
  });
});

describe('SpatialHash', () => {
  it('finds a body inserted into the same cell as the query', () => {
    const hash = new SpatialHash(16);
    const body = makeBody(2, 2, circle(1));
    hash.insert(body);
    const out: Body[] = [];
    hash.queryCircle({ x: 0, y: 0 }, 5, out);
    expect(out).toContain(body);
  });

  it('finds a body sitting in a neighbouring cell when the query radius reaches it', () => {
    const hash = new SpatialHash(16);
    const body = makeBody(17, 0, circle(1)); // cell (1, 0)
    hash.insert(body);
    const out: Body[] = [];
    // Query centred in cell (0, 0), radius reaches across the boundary into cell (1, 0).
    hash.queryCircle({ x: 15, y: 0 }, 5, out);
    expect(out).toContain(body);
  });

  it('excludes a body that lies outside the query radius', () => {
    const hash = new SpatialHash(16);
    const body = makeBody(500, 500, circle(1));
    hash.insert(body);
    const out: Body[] = [];
    hash.queryCircle({ x: 0, y: 0 }, 10, out);
    expect(out).toHaveLength(0);
  });

  it('includes a body sitting exactly on a cell boundary', () => {
    const hash = new SpatialHash(16);
    const body = makeBody(16, 0, circle(0.5)); // exactly on the boundary between cells 0 and 1
    hash.insert(body);
    const out: Body[] = [];
    hash.queryAabb(0, -1, 16, 1, out);
    expect(out).toContain(body);
  });

  it('queryAabb only returns bodies within the box', () => {
    const hash = new SpatialHash(16);
    const inside = makeBody(1, 1, circle(0.5));
    const outside = makeBody(50, 50, circle(0.5));
    hash.insert(inside);
    hash.insert(outside);
    const out: Body[] = [];
    hash.queryAabb(-5, -5, 5, 5, out);
    expect(out).toContain(inside);
    expect(out).not.toContain(outside);
  });

  it('filters query results by team when a team is given', () => {
    const hash = new SpatialHash(16);
    const player: Body = { ...makeBody(0, 0, circle(1)), team: 'player' };
    const hostile: Body = { ...makeBody(0, 0, circle(1)), team: 'hostile' };
    hash.insert(player);
    hash.insert(hostile);
    const out: Body[] = [];
    hash.queryCircle({ x: 0, y: 0 }, 5, out, 'player');
    expect(out).toContain(player);
    expect(out).not.toContain(hostile);
  });

  it('empties completely after clear()', () => {
    const hash = new SpatialHash(16);
    hash.insert(makeBody(0, 0, circle(1)));
    hash.clear();
    expect(hash.size).toBe(0);
    const out: Body[] = [];
    hash.queryCircle({ x: 0, y: 0 }, 1000, out);
    expect(out).toHaveLength(0);
  });

  it('tracks size as bodies are inserted', () => {
    const hash = new SpatialHash(16);
    expect(hash.size).toBe(0);
    hash.insert(makeBody(0, 0, circle(1)));
    hash.insert(makeBody(1, 1, circle(1)));
    expect(hash.size).toBe(2);
  });

  it('returns query results in a deterministic order regardless of insertion order', () => {
    const bodyA = makeBody(1, 1, circle(1));
    const bodyB = makeBody(2, 2, circle(1));
    const bodyC = makeBody(3, 3, circle(1));

    const hashOne = new SpatialHash(16);
    hashOne.insert(bodyC);
    hashOne.insert(bodyA);
    hashOne.insert(bodyB);

    const hashTwo = new SpatialHash(16);
    hashTwo.insert(bodyB);
    hashTwo.insert(bodyC);
    hashTwo.insert(bodyA);

    const outOne: Body[] = [];
    const outTwo: Body[] = [];
    hashOne.queryCircle({ x: 0, y: 0 }, 100, outOne);
    hashTwo.queryCircle({ x: 0, y: 0 }, 100, outTwo);

    expect(outOne.map((b) => b.id)).toEqual(outTwo.map((b) => b.id));
    expect(outOne.map((b) => b.id)).toEqual([...outOne.map((b) => b.id)].sort((x, y) => x - y));
  });
});
