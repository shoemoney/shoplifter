import type { GpuContext } from './context.js';
import spriteShaderSource from './shaders/sprite.wgsl?raw';

/** Bytes per sprite instance. 16 floats keeps every instance 64-byte aligned. */
export const SPRITE_INSTANCE_FLOATS = 16;
export const SPRITE_INSTANCE_BYTES = SPRITE_INSTANCE_FLOATS * 4;

export const CAMERA_UNIFORM_BYTES = 32;

/** Unit quad, -0.5..0.5, two triangles via an index buffer. */
export const QUAD_VERTICES = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
export const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

export interface SpritePipelineBundle {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  shaderModule: GPUShaderModule;
}

const quadLayout: GPUVertexBufferLayout = {
  arrayStride: 8,
  stepMode: 'vertex',
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
};

const instanceLayout: GPUVertexBufferLayout = {
  arrayStride: SPRITE_INSTANCE_BYTES,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 1, offset: 0, format: 'float32x2' }, // position
    { shaderLocation: 2, offset: 8, format: 'float32x2' }, // size
    { shaderLocation: 3, offset: 16, format: 'float32x2' }, // rotation, depth
    { shaderLocation: 4, offset: 24, format: 'float32x4' }, // uv rect
    { shaderLocation: 5, offset: 40, format: 'float32x4' }, // colour
  ],
};

export const SPRITE_VERTEX_LAYOUTS: readonly GPUVertexBufferLayout[] = [quadLayout, instanceLayout];

/**
 * Premultiplied-alpha blending. The atlas is authored premultiplied so additive effects and
 * normal sprites can share one pipeline instead of forcing a state change mid-frame.
 */
export const PREMULTIPLIED_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export const createSpriteBindGroupLayout = (device: GPUDevice): GPUBindGroupLayout =>
  device.createBindGroupLayout({
    label: 'sprite-bind-group-layout',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });

export const createSpritePipeline = (context: GpuContext): SpritePipelineBundle => {
  const { device, format } = context;
  const shaderModule = device.createShaderModule({
    label: 'sprite-shader',
    code: spriteShaderSource,
  });
  const bindGroupLayout = createSpriteBindGroupLayout(device);

  const pipeline = device.createRenderPipeline({
    label: 'sprite-pipeline',
    layout: device.createPipelineLayout({
      label: 'sprite-pipeline-layout',
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: 'vertexMain',
      buffers: SPRITE_VERTEX_LAYOUTS as GPUVertexBufferLayout[],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragmentMain',
      targets: [{ format, blend: PREMULTIPLIED_BLEND }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });

  return { pipeline, bindGroupLayout, shaderModule };
};
