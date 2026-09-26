import { describe, expect, it } from 'vitest';
import { Camera, defaultCameraTuning } from './camera.js';

const target = (overrides: Partial<Parameters<Camera['update']>[0]> = {}) => ({
  x: 0,
  y: 20,
  velocityX: 0,
  velocityY: 0,
  ...overrides,
});

describe('Camera framing', () => {
  it('shows 56-64 m of world width at rest, per the PRD', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.snapTo(target());
    expect(camera.halfWidth * 2).toBeGreaterThanOrEqual(56);
    expect(camera.halfWidth * 2).toBeLessThanOrEqual(64);
  });

  it('derives vertical extent from the aspect ratio', () => {
    const camera = new Camera();
    camera.setAspect(2);
    camera.snapTo(target());
    expect(camera.halfHeight).toBeCloseTo(camera.halfWidth / 2, 6);
  });

  it('places the aircraft above centre so the ground stays visible', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.snapTo(target({ y: 20 }));
    // verticalBias 0.6 puts the target at 60% screen height, i.e. above the camera centre.
    expect(camera.view().centerY).toBeLessThan(20);
  });

  it('leads the aircraft in the direction of travel', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.snapTo(target({ velocityX: 42 }));
    expect(camera.view().centerX).toBeGreaterThan(0);

    camera.snapTo(target({ velocityX: -42 }));
    expect(camera.view().centerX).toBeLessThan(0);
  });

  it('caps look-ahead at the configured fraction of the viewport', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.snapTo(target({ velocityX: 10000 }));
    const maxLead = defaultCameraTuning().lookAheadFraction * camera.halfWidth * 2;
    expect(camera.view().centerX).toBeLessThanOrEqual(maxLead + 1e-6);
  });

  it('zooms out for speed and for threat, but no more than 12%', () => {
    const base = new Camera();
    base.setAspect(16 / 9);
    base.snapTo(target());
    const restWidth = base.halfWidth * 2;

    const fast = new Camera();
    fast.setAspect(16 / 9);
    fast.snapTo(target({ velocityX: 42 }));
    expect(fast.halfWidth * 2).toBeGreaterThan(restWidth);

    const threatened = new Camera();
    threatened.setAspect(16 / 9);
    threatened.snapTo(target({ threat: 1 }));
    expect(threatened.halfWidth * 2).toBeCloseTo(restWidth * 1.12, 4);
  });

  it('approaches the target smoothly rather than snapping', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.snapTo(target({ x: 0 }));
    camera.update(target({ x: 100 }), 1 / 120);
    const after = camera.view().centerX;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(100);
  });

  it('clamps to world bounds so the camera never shows past the map edge', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.bounds = { minX: 0, maxX: 6000, minY: 0, maxY: 400 };
    camera.snapTo(target({ x: -50, y: 5 }));
    const view = camera.view();
    expect(view.centerX).toBeGreaterThanOrEqual(view.halfWidth - 1e-6);
    expect(view.centerY).toBeGreaterThanOrEqual(view.halfHeight - 1e-6);
  });

  it('centres a map narrower than the viewport instead of jittering', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.bounds = { minX: 0, maxX: 10, minY: 0, maxY: 8 };
    camera.snapTo(target({ x: 500, y: 500 }));
    expect(camera.view().centerX).toBeCloseTo(5, 6);
    expect(camera.view().centerY).toBeCloseTo(4, 6);
  });

  it('culls what is off screen and keeps what is on', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.snapTo(target({ x: 0, y: 20 }));
    const view = camera.view();
    expect(camera.isVisible(view.centerX, view.centerY, 1)).toBe(true);
    expect(camera.isVisible(view.centerX + view.halfWidth + 50, view.centerY, 1)).toBe(false);
  });

  it('caps and decays shake', () => {
    const camera = new Camera();
    camera.addShake(0.8);
    camera.addShake(0.8);
    expect(camera.shakeAmount).toBe(1);
    camera.decayShake(0.5);
    expect(camera.shakeAmount).toBeLessThan(1);
  });
});
