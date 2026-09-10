import { uid } from '../core/model.js';
/** Tests the real browser APIs. Unavailable capabilities are skipped, never faked. */
export async function runDiagnostics(app) {
    const checks = [], check = (name, status, detail) => checks.push({ name, status, detail });
    check('Secure context', isSecureContext ? 'pass' : 'unavailable', isSecureContext ? 'HTTPS or loopback origin' : 'Open the hosted app on HTTPS or localhost for GPU and durable browser storage');
    check('Active renderer', 'info', app.renderer.mode + (app.renderer.reason ? ': ' + app.renderer.reason : ''));
    check('Document format', 'pass', app.doc.snapshot().format);
    if (app.storage.mode === 'IndexedDB') {
        const id = 'probe_' + uid(), data = { id, value: uid('durability'), at: Date.now() };
        try { await app.storage.put('settings', data); const value = await app.storage.get('settings', id); if (value?.value !== data.value) throw Error('Read did not match committed value'); await app.storage.delete('settings', id); check('IndexedDB write/read/delete', 'pass', 'Committed readwrite transaction and exact-value readback'); }
        catch (e) { check('IndexedDB write/read/delete', 'fail', e.message); }
        const checkpoint = await app.storage.get('settings', 'reload-validation');
        if (checkpoint && checkpoint.navigation !== performance.timeOrigin) { check('IndexedDB across navigation', 'pass', `Checkpoint from ${new Date(checkpoint.at).toISOString()} survived navigation`); }
        else check('IndexedDB across navigation', 'pending', 'A checkpoint has been saved. Reload this origin, then run diagnostics again.');
        await app.storage.put('settings', { id: 'reload-validation', navigation: performance.timeOrigin, at: Date.now(), nonce: uid() });
    } else check('IndexedDB durability', 'unavailable', app.storage.mode + '; this is not a persistence pass');
    if (navigator.storage?.estimate) { const quota = await navigator.storage.estimate().catch(() => ({})); check('Storage quota', 'info', `${Math.round((quota.usage || 0) / 1048576)} MiB used of ${Math.round((quota.quota || 0) / 1048576)} MiB`); }
    if (!navigator.gpu || !isSecureContext) check('WebGPU compute/readback', 'unavailable', 'No secure-context WebGPU API');
    else {
        let device, input, output;
        try {
            const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw Object.assign(Error('No usable WebGPU adapter returned'), { unavailable: true }); device = await adapter.requestDevice(); device.pushErrorScope('validation');
            input = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }); output = device.createBuffer({ size: 1024, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            const module = device.createShaderModule({ code: '@group(0) @binding(0) var<storage,read_write> values: array<u32>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { if (id.x < 256u) { values[id.x] = id.x * id.x + 7u; } }' });
            const info = await module.getCompilationInfo(); if (info.messages.some(m => m.type === 'error')) throw Error(info.messages.map(m => m.message).join('; '));
            const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } }), bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }] });
            const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(4); pass.end(); encoder.copyBufferToBuffer(input, 0, output, 0, 1024); device.queue.submit([encoder.finish()]); await output.mapAsync(GPUMapMode.READ);
            const values = new Uint32Array(output.getMappedRange()); if (!values.every((v, i) => v === i * i + 7)) throw Error('GPU readback mismatch'); output.unmap(); const error = await device.popErrorScope(); if (error) throw Error(error.message);
            check('WebGPU compute/readback', 'pass', '256 independently checked shader outputs; no validation error. Adapter: ' + (adapter.info?.description || adapter.info?.device || 'details unavailable'));
        } catch (e) { check('WebGPU compute/readback', e.unavailable ? 'unavailable' : 'fail', e.message); } finally { input?.destroy(); output?.destroy(); device?.destroy(); }
    }
    if (app.renderer.gpu) {
        try { const result = await app.renderer.gpu.selfTest(); check('Orivane GPU raster/readback', 'pass', result); }
        catch (e) { check('Orivane GPU raster/readback', 'fail', e.message); }
    } else check('Orivane GPU raster/readback', 'unavailable', 'Canvas fallback is active; a GPU render pass has not been verified');
    check('Touch/stylus hardware', 'pending', 'Use the pointer test pad with a physical device. Synthetic events do not certify hardware.');
    return { version: '0.2.0', at: new Date().toISOString(), origin: location.origin, userAgent: navigator.userAgent, checks };
}
