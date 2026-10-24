/**
 * Web Worker entry point for wghostscript.
 *
 * Spawn this worker from the main thread, then post messages of the
 * form `{ id, type, payload }` matching `WorkerRequest` below. The
 * worker responds with `{ id, ok, result | error }`.
 *
 * Operations available: `init`, `execute`, `renderPdf`, `compressPdf`,
 * `convertPdf`, `psToPdf`, `extractText`.
 */
import { initWGhostscript } from "./loader.js";
// The instance's promise, set when the first request arrives: requests
// that come in while it loads share it instead of each loading the wasm.
let instance = null;
function ensureInstance(wasmPath) {
    if (!instance) {
        instance = initWGhostscript({ wasmPath });
        // A failed load isn't cached; the next request tries again.
        instance.catch(() => {
            instance = null;
        });
    }
    return instance;
}
/**
 * The ArrayBuffers behind a result's output bytes, to transfer rather
 * than copy: outputs are fresh copies out of MEMFS that the worker
 * doesn't keep.
 */
function transferables(result) {
    const views = result instanceof Uint8Array ? [result]
        : result instanceof Map ? [...result.values()]
            : result?.outputFiles instanceof Map ? [...result.outputFiles.values()]
                : [];
    return [...new Set(views.map((view) => view.buffer))];
}
self.addEventListener("message", async (event) => {
    const req = event.data;
    try {
        let result;
        switch (req.type) {
            case "init":
                await ensureInstance(req.payload?.wasmPath);
                result = { ready: true };
                break;
            case "execute": {
                const gs = await ensureInstance();
                const r = await gs.execute(req.payload.command, req.payload.inputFiles);
                result = r;
                break;
            }
            case "renderPdf": {
                const gs = await ensureInstance();
                result = await gs.ops.renderPdf(req.payload.input, req.payload.opts);
                break;
            }
            case "compressPdf": {
                const gs = await ensureInstance();
                result = await gs.ops.compressPdf(req.payload.input, req.payload.opts);
                break;
            }
            case "convertPdf": {
                const gs = await ensureInstance();
                result = await gs.ops.convertPdf(req.payload.input, req.payload.opts);
                break;
            }
            case "psToPdf": {
                const gs = await ensureInstance();
                result = await gs.ops.psToPdf(req.payload.input, req.payload.opts);
                break;
            }
            case "extractText": {
                const gs = await ensureInstance();
                result = await gs.ops.extractText(req.payload.input, req.payload.opts);
                break;
            }
            default:
                throw new Error(`unknown request type: ${JSON.stringify(req.type)}`);
        }
        const response = { id: req.id, ok: true, result };
        self.postMessage(response, transferables(result));
    }
    catch (err) {
        const response = {
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
        self.postMessage(response);
    }
});
//# sourceMappingURL=worker.js.map