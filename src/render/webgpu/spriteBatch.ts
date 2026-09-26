import type { GpuContext } from './context.js';
import {
  CAMERA_UNIFORM_BYTES,
  QUAD_INDICES,
  QUAD_VERTICES,
  SPRITE_INSTANCE_FLOATS,
  SPRITE_INSTANCE_BYTES,
  createSpritePipeline,
  type SpritePipelineBundle,
} from './pipelines.js';

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface Sprite {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  /** 0 = nearest the camera, 1 = furthest. Matches the parallax layer order. */
  depth?: number;
  uv?: UvRect;
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

export const FULL_UV: UvRect = { u0: 0, v0: 0, u1: 1, v1: 1 };

/**
 * Writes one sprite into the instance array. Pure and allocation-free so the packing rules
 * can be unit-tested without a GPU, which is the only practical way to test them at all.
 */
export const packSprite = (target: Float32Array, instanceIndex: number, sprite: Sprite): void => {
  const offset = instanceIndex * SPRITE_INSTANCE_FLOATS;
  if (offset + SPRITE_INSTANCE_FLOATS > target.length) {
    throw new RangeError(`packSprite: instance ${instanceIndex} exceeds buffer capacity`);
  }
  const uv = sprite.uv ?? FULL_UV;
  target[offset + 0] = sprite.x;
  target[offset + 1] = sprite.y;
  target[offset + 2] = sprite.width;
  target[offset + 3] = sprite.height;
  target[offset + 4] = sprite.rotation ?? 0;
  target[offset + 5] = sprite.depth ?? 0.5;
  target[offset + 6] = uv.u0;
  target[offset + 7] = uv.v0;
  target[offset + 8] = uv.u1;
  target[offset + 9] = uv.v1;
  target[offset + 10] = sprite.r ?? 1;
  target[offset + 11] = sprite.g ?? 1;
  target[offset + 12] = sprite.b ?? 1;
  target[offset + 13] = sprite.a ?? 1;
  target[offset + 14] = 0;
  target[offset + 15] = 0;
};

export interface CameraUniform {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  timeSeconds: number;
}

export const packCameraUniform = (target: Float32Array, camera: CameraUniform): void => {
  target[0] = camera.centerX;
  target[1] = camera.centerY;
  target[2] = camera.halfWidth;
  target[3] = camera.halfHeight;
  target[4] = camera.pixelWidth;
  target[5] = camera.pixelHeight;
  target[6] = camera.timeSeconds;
  target[7] = 0;
};

export interface SpriteBatchOptions {
  /** Maximum sprites per flush. Preallocated once; the batch never grows mid-frame. */
  capacity?: number;
  texture: GPUTexture;
  sampler?: GPUSampler;
  label?: string;
}

export interface BatchStats {
  sprites: number;
  draws: number;
  /** Sprites rejected because the batch was full. Non-zero means capacity is undersized. */
  dropped: number;
}

/**
 * One draw call per flush. Sprites are accumulated into a CPU-side Float32Array and uploaded
 * once, because 2,000 particles as 2,000 draw calls misses the PRD's sub-60-draw-call budget
 * by two orders of magnitude.
 */
export class SpriteBatch {
  readonly capacity: number;

  private readonly device: GPUDevice;
  private readonly bundle: SpritePipelineBundle;
  private readonly instanceData: Float32Array;
  private readonly cameraData = new Float32Array(CAMERA_UNIFORM_BYTES / 4);
  private readonly quadBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly instanceBuffer: GPUBuffer;
  private readonly cameraBuffer: GPUBuffer;
  private readonly sampler: GPUSampler;
  private bindGroup: GPUBindGroup;
  private count = 0;
  private stats: BatchStats = { sprites: 0, draws: 0, dropped: 0 };

  constructor(context: GpuContext, options: SpriteBatchOptions) {
    this.device = context.device;
    this.capacity = options.capacity ?? 8192;
    this.bundle = createSpritePipeline(context);
    this.instanceData = new Float32Array(this.capacity * SPRITE_INSTANCE_FLOATS);

    const label = options.label ?? 'sprite-batch';
    this.quadBuffer = this.device.createBuffer({
      label: `${label}-quad`,
      size: QUAD_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.quadBuffer, 0, QUAD_VERTICES);

    this.indexBuffer = this.device.createBuffer({
      label: `${label}-index`,
      size: QUAD_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, QUAD_INDICES);

    this.instanceBuffer = this.device.createBuffer({
      label: `${label}-instances`,
      size: this.capacity * SPRITE_INSTANCE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.cameraBuffer = this.device.createBuffer({
      label: `${label}-camera`,
      size: CAMERA_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler =
      options.sampler ??
      this.device.createSampler({
        label: `${label}-sampler`,
        magFilter: 'nearest',
        minFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });

    this.bindGroup = this.createBindGroup(options.texture);
  }

  private createBindGroup(texture: GPUTexture): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'sprite-bind-group',
      layout: this.bundle.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: texture.createView() },
      ],
    });
  }

  setTexture(texture: GPUTexture): void {
    this.bindGroup = this.createBindGroup(texture);
  }

  begin(): void {
    this.count = 0;
    this.stats = { sprites: 0, draws: 0, dropped: 0 };
  }

  /** Returns false when the batch is full rather than reallocating mid-frame. */
  draw(sprite: Sprite): boolean {
    if (this.count >= this.capacity) {
      this.stats.dropped++;
      return false;
    }
    packSprite(this.instanceData, this.count, sprite);
    this.count++;
    return true;
  }

  get pending(): number {
    return this.count;
  }

  lastStats(): BatchStats {
    return this.stats;
  }

  flush(pass: GPURenderPassEncoder, camera: CameraUniform): void {
    if (this.count === 0) return;

    packCameraUniform(this.cameraData, camera);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, this.cameraData);
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      0,
      this.instanceData.buffer,
      this.instanceData.byteOffset,
      this.count * SPRITE_INSTANCE_BYTES,
    );

    pass.setPipeline(this.bundle.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.quadBuffer);
    pass.setVertexBuffer(1, this.instanceBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.drawIndexed(QUAD_INDICES.length, this.count);

    this.stats.sprites += this.count;
    this.stats.draws += 1;
    this.count = 0;
  }

  destroy(): void {
    this.quadBuffer.destroy();
    this.indexBuffer.destroy();
    this.instanceBuffer.destroy();
    this.cameraBuffer.destroy();
  }
}
