// Instanced textured sprite. One unit quad, one instance per sprite, one draw call per atlas.
// Rotation is per-instance so rotor blades and debris do not each need their own pipeline.

struct Camera {
  center: vec2f,      // world-space camera centre, metres
  halfExtent: vec2f,  // half viewport size, metres
  pixelSize: vec2f,   // backbuffer size, pixels
  timeSeconds: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var atlasTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) corner: vec2f,        // unit quad, -0.5 .. 0.5
  @location(1) position: vec2f,      // instance: world centre
  @location(2) size: vec2f,          // instance: world size, metres
  @location(3) rotationDepth: vec2f, // instance: radians, depth 0..1
  @location(4) uvRect: vec4f,        // instance: u0 v0 u1 v1
  @location(5) color: vec4f,         // instance: rgba tint
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let rotation = input.rotationDepth.x;
  let depth = clamp(input.rotationDepth.y, 0.0, 1.0);

  let scaled = input.corner * input.size;
  let c = cos(rotation);
  let s = sin(rotation);
  let rotated = vec2f(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
  let world = input.position + rotated;

  // Orthographic: world metres straight to clip space, y up.
  let clipXY = (world - camera.center) / camera.halfExtent;

  var out: VertexOutput;
  out.clipPosition = vec4f(clipXY, depth, 1.0);
  // Texture v runs DOWN the atlas while clip-space y runs UP, so the corner has to be flipped
  // vertically before it indexes the uv rect. Without this every sprite renders upside down —
  // invisible on symmetric placeholder art, obvious the moment a sprite has a top and a bottom.
  let uvCoord = vec2f(input.corner.x + 0.5, 0.5 - input.corner.y);
  out.uv = mix(input.uvRect.xy, input.uvRect.zw, uvCoord);
  out.color = input.color;
  return out;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(atlasTexture, atlasSampler, input.uv);
  let result = sampled * input.color;
  // Fully transparent fragments must not write depth or blend cost.
  if (result.a < 0.004) {
    discard;
  }
  return result;
}
