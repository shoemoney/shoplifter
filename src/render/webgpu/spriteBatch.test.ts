import { describe, expect, it } from 'vitest';
import { FULL_UV, packCameraUniform, packSprite } from './spriteBatch.js';
import {
  CAMERA_UNIFORM_BYTES,
  QUAD_INDICES,
  QUAD_VERTICES,
  SPRITE_INSTANCE_BYTES,
  SPRITE_INSTANCE_FLOATS,
  SPRITE_VERTEX_LAYOUTS,
  PREMULTIPLIED_BLEND,
} from './pipelines.js';

const buffer = (instances = 4): Float32Array =>
  new Float32Array(instances * SPRITE_INSTANCE_FLOATS);

describe('sprite instance layout', () => {
  it('keeps instances 64-byte aligned', () => {
    expect(SPRITE_INSTANCE_BYTES).toBe(64);
    expect(SPRITE_INSTANCE_BYTES % 16).toBe(0);
  });

  it('declares attribute offsets that match the pack order', () => {
    const instance = SPRITE_VERTEX_LAYOUTS[1];
    expect(instance?.stepMode).toBe('instance');
    expect(instance?.arrayStride).toBe(SPRITE_INSTANCE_BYTES);
    const offsets = [...(instance?.attributes ?? [])].map((a) => a.offset);
    expect(offsets).toEqual([0, 8, 16, 24, 40]);
  });

  it('declares a per-vertex quad stream at location 0', () => {
    const quad = SPRITE_VERTEX_LAYOUTS[0];
    expect(quad?.stepMode).toBe('vertex');
    expect(quad?.arrayStride).toBe(8);
    expect([...(quad?.attributes ?? [])][0]?.shaderLocation).toBe(0);
  });

  it('describes a unit quad with two triangles', () => {
    expect(QUAD_VERTICES).toHaveLength(8);
    expect(Math.max(...QUAD_VERTICES)).toBe(0.5);
    expect(Math.min(...QUAD_VERTICES)).toBe(-0.5);
    expect(QUAD_INDICES).toHaveLength(6);
  });

  it('blends premultiplied alpha', () => {
    expect(PREMULTIPLIED_BLEND.color?.srcFactor).toBe('one');
    expect(PREMULTIPLIED_BLEND.color?.dstFactor).toBe('one-minus-src-alpha');
  });
});

describe('packSprite', () => {
  it('writes every field at the documented offset', () => {
    const target = buffer(1);
    packSprite(target, 0, {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      rotation: 0.5,
      depth: 0.25,
      uv: { u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4 },
      r: 0.5,
      g: 0.6,
      b: 0.7,
      a: 0.8,
    });
    expect(Array.from(target.subarray(0, 14)).map((v) => Number(v.toFixed(4)))).toEqual([
      1, 2, 3, 4, 0.5, 0.25, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
    ]);
  });

  it('defaults rotation, depth, uv and colour', () => {
    const target = buffer(1);
    packSprite(target, 0, { x: 0, y: 0, width: 1, height: 1 });
    expect(target[4]).toBe(0);
    expect(target[5]).toBe(0.5);
    expect(Array.from(target.subarray(6, 10))).toEqual([
      FULL_UV.u0,
      FULL_UV.v0,
      FULL_UV.u1,
      FULL_UV.v1,
    ]);
    expect(Array.from(target.subarray(10, 14))).toEqual([1, 1, 1, 1]);
  });

  it('writes the second instance at the next stride, leaving the first intact', () => {
    const target = buffer(2);
    packSprite(target, 0, { x: 7, y: 0, width: 1, height: 1 });
    packSprite(target, 1, { x: 9, y: 0, width: 1, height: 1 });
    expect(target[0]).toBe(7);
    expect(target[SPRITE_INSTANCE_FLOATS]).toBe(9);
  });

  it('throws instead of silently corrupting past the end of the buffer', () => {
    const target = buffer(1);
    expect(() => packSprite(target, 1, { x: 0, y: 0, width: 1, height: 1 })).toThrow(RangeError);
  });
});

describe('packCameraUniform', () => {
  it('fills the uniform in shader field order', () => {
    const target = new Float32Array(CAMERA_UNIFORM_BYTES / 4);
    packCameraUniform(target, {
      centerX: 10,
      centerY: 20,
      halfWidth: 30,
      halfHeight: 17,
      pixelWidth: 1920,
      pixelHeight: 1080,
      timeSeconds: 1.5,
    });
    expect(Array.from(target)).toEqual([10, 20, 30, 17, 1920, 1080, 1.5, 0]);
  });

  it('is 32 bytes, so it satisfies uniform alignment', () => {
    expect(CAMERA_UNIFORM_BYTES % 16).toBe(0);
  });
});
