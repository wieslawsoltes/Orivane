/** Instanced, antialiased SDF geometry + atlas sprites, in painter order.
 * One draw call for the visible scene. Text is rasterized only when its cache
 * key changes; camera movement is a uniform update, not text rerasterization.
 */
const shader = `
struct Globals { camera: vec4f, viewport: vec4f };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct In {
 @location(0) rect: vec4f, @location(1) fill: vec4f,
 @location(2) stroke: vec4f, @location(3) opts: vec4f, @location(4) uv: vec4f
};
struct Out {
 @builtin(position) position: vec4f, @location(0) local: vec2f,
 @location(1) size: vec2f, @location(2) fill: vec4f,
 @location(3) stroke: vec4f, @location(4) opts: vec4f,
 @location(5) uv: vec2f
};
@vertex fn vs(i:In, @builtin(vertex_index) vi:u32)->Out {
 let coords=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 let p=coords[vi]; let local=(p-0.5)*i.rect.zw;
 let c=cos(i.opts.z);let s=sin(i.opts.z);
 let world=i.rect.xy+i.rect.zw*0.5+vec2f(local.x*c-local.y*s,local.x*s+local.y*c);
 let screen=world*globals.camera.z+globals.camera.xy;
 var o:Out;o.position=vec4f(screen.x/globals.viewport.x*2-1,1-screen.y/globals.viewport.y*2,0,1);
 o.local=local;o.size=i.rect.zw;o.fill=i.fill;o.stroke=i.stroke;o.opts=i.opts;o.uv=i.uv.xy+p*i.uv.zw;return o;
}
@fragment fn fs(i:Out)->@location(0) vec4f {
 if(i.opts.w>3.5){let tex=textureSampleLevel(atlas,samp,i.uv,0.0);return vec4f(tex.rgb,tex.a*i.fill.a);}
 let p=i.local;let halfSize=i.size*0.5;var d:f32;
 if(i.opts.w<0.5){let r=min(i.opts.x,min(halfSize.x,halfSize.y));let q=abs(p)-halfSize+vec2f(r);d=length(max(q,vec2f(0)))+min(max(q.x,q.y),0)-r;}
 else if(i.opts.w<1.5){d=(length(p/max(halfSize,vec2f(0.001)))-1)*min(halfSize.x,halfSize.y);}
 else if(i.opts.w<2.5){d=(abs(p.x)/max(halfSize.x,0.001)+abs(p.y)/max(halfSize.y,0.001)-1)*min(halfSize.x,halfSize.y)*0.7;}
 else {let a=vec2f(0,-halfSize.y);let b=vec2f(halfSize.x,halfSize.y);let c=vec2f(-halfSize.x,halfSize.y);let e0=b-a;let e1=c-b;let e2=a-c;let v0=p-a;let v1=p-b;let v2=p-c;let pq0=v0-e0*clamp(dot(v0,e0)/dot(e0,e0),0,1);let pq1=v1-e1*clamp(dot(v1,e1)/dot(e1,e1),0,1);let pq2=v2-e2*clamp(dot(v2,e2)/dot(e2,e2),0,1);let dd=min(dot(pq0,pq0),min(dot(pq1,pq1),dot(pq2,pq2)));let inside=min(e0.x*v0.y-e0.y*v0.x,min(e1.x*v1.y-e1.y*v1.x,e2.x*v2.y-e2.y*v2.x));d=sqrt(dd)*select(1.0,-1.0,inside>=0);}
 let aa=0.9/globals.camera.z;let cover=1-smoothstep(-aa,0,d);
 let inner=1-smoothstep(-i.opts.y-aa,-i.opts.y+aa,d);
 let color=select(i.fill,mix(i.stroke,i.fill,inner),i.opts.y>0 && i.stroke.a>0);
 return vec4f(color.rgb,color.a*cover);
}`;
export function rgba(hex, alpha = 1) { if (hex === 'transparent' || !hex)
    return [0, 0, 0, 0]; const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, alpha]; }
export class GPURenderer {
    static async create(canvas) { if (!navigator.gpu)
        throw Error('WebGPU unavailable'); const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!adapter)
        throw Error('No WebGPU adapter'); const device = await adapter.requestDevice(); const r = new GPURenderer(canvas, device); try { await r.init(); return r; } catch (e) { r.destroy(); throw e; } }
    constructor(canvas, device) { this.canvas = canvas; this.device = device; this.context = canvas.getContext('webgpu'); this.capacity = 0; this.atlasSize = Math.min(4096, device.limits.maxTextureDimension2D); this.lost = false; device.lost.then(info => { this.lost = true; this.onLost?.(info.message); }); }
    async init() {
        const d = this.device;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device: d, format: this.format, alphaMode: 'premultiplied' });
        this.uniform = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.atlas = d.createTexture({ size: [this.atlasSize, this.atlasSize], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        const module = d.createShaderModule({ code: shader });
        const info = await module.getCompilationInfo();
        if (info.messages.some(m => m.type === 'error'))
            throw Error(info.messages.map(m => m.message).join('\n'));
        this.pipeline = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 80, stepMode: 'instance', attributes: [0, 1, 2, 3, 4].map(i => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })) }] }, fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] }, primitive: { topology: 'triangle-list' } });
        this.bindGroup = d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.atlas.createView() }, { binding: 2, resource: d.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }] });
    }
    upload(tile, x, y) { this.device.queue.copyExternalImageToTexture({ source: tile }, { texture: this.atlas, origin: [x, y] }, [tile.width, tile.height]); }
    render(commands, camera, width, height, bg) {
        const d = this.device;
        if (this.lost)
            return;
        const n = commands.length, bytes = Math.max(80, n * 80);
        if (bytes > this.capacity) {
            this.buffer?.destroy();
            this.capacity = Math.max(bytes, this.capacity * 2, 80 * 1024);
            this.buffer = d.createBuffer({ size: this.capacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
            this.data = new Float32Array(this.capacity / 4);
        }
        let off = 0;
        for (const c of commands) {
            this.data.set([c.x, c.y, c.w, c.h, ...rgba(c.fill, c.opacity ?? 1), ...rgba(c.stroke, c.opacity ?? 1), c.radius || 0, c.sw || 0, (c.rotation || 0) * Math.PI / 180, c.kind || 0, ...(c.uv || [0, 0, 0, 0])], off);
            off += 20;
        }
        d.queue.writeBuffer(this.uniform, 0, new Float32Array([camera.x, camera.y, camera.zoom, 0, width, height, 1, 0]));
        if (n)
            d.queue.writeBuffer(this.buffer, 0, this.data, 0, n * 20);
        const encoder = d.createCommandEncoder();
        const col = rgba(bg);
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: col[0], g: col[1], b: col[2], a: bg ? 1 : 0 }, loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        if (n) {
            pass.setVertexBuffer(0, this.buffer);
            pass.draw(6, n);
        }
        pass.end();
        d.queue.submit([encoder.finish()]);
    }
    async selfTest() {
        const d = this.device, resources = []; let scoped = true; d.pushErrorScope('validation');
        try {
            const target = d.createTexture({ size: [160, 32], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); resources.push(target);
            const atlas = d.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); resources.push(atlas);
            d.queue.writeTexture({ texture: atlas }, new Uint8Array([34,170,85,255,34,170,85,255,34,170,85,255,34,170,85,255]), { bytesPerRow: 8 }, [2,2]);
            const uniform = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), vertices = d.createBuffer({ size: 400, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }), readback = d.createBuffer({ size: 768 * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); resources.push(uniform,vertices,readback);
            d.queue.writeBuffer(uniform, 0, new Float32Array([0,0,1,0,160,32,1,0]));
            const data = []; for (let i = 0; i < 5; i++) data.push(i*32,0,32,32,...rgba('#dc4f7f'),0,0,0,0,0,0,0,i,0,0,1,1);
            d.queue.writeBuffer(vertices, 0, new Float32Array(data));
            const bind = d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding:0,resource:{buffer:uniform} },{binding:1,resource:atlas.createView()},{binding:2,resource:d.createSampler()}] });
            const encoder = d.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{view:target.createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}] });
            pass.setPipeline(this.pipeline);pass.setBindGroup(0,bind);pass.setVertexBuffer(0,vertices);pass.draw(6,5);pass.end();encoder.copyTextureToBuffer({texture:target},{buffer:readback,bytesPerRow:768,rowsPerImage:32},[160,32]);d.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
            const pixels = new Uint8Array(readback.getMappedRange()), blueFirst = this.format.startsWith('bgra');
            for(let i=0;i<5;i++){const at=16*768+(i*32+16)*4,expected=i===4?[34,170,85]:[220,79,127],rgb=blueFirst?[pixels[at+2],pixels[at+1],pixels[at]]:[pixels[at],pixels[at+1],pixels[at+2]];if(rgb.some((v,k)=>Math.abs(v-expected[k])>3))throw Error('Raster readback mismatch for primitive '+i+': '+rgb.join(','));}
            readback.unmap(); const error=await d.popErrorScope(); scoped = false; if(error)throw Error(error.message);
            return 'Rectangle, ellipse, diamond, triangle and atlas sprite rendered through the application pipeline; center pixels read back correctly.';
        } finally { if (scoped) await d.popErrorScope().catch(() => {}); for (const r of resources) r.destroy(); }
    }
    destroy() { this.buffer?.destroy(); this.uniform?.destroy(); this.atlas?.destroy(); this.device.destroy(); }
}
