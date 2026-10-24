/**
 * WASM module loader for wghostscript.
 */
import { createBindings } from "./api.js";
import { execute, STDIO } from "./cli.js";
import { renderPdf, compressPdf, convertPdf, psToPdf, extractText, } from "./operations.js";
/**
 * Load the Emscripten glue. By default it's imported by a fixed relative
 * path, and the .wasm is located with `new URL(..., import.meta.url)` in
 * this file: bundlers (Vite, webpack 5, Rollup-based tools) recognise
 * both, so they bundle the glue and emit the .wasm as an asset. The
 * glue's own wasm lookup isn't relied on, since bundlers leave it
 * unrewritten (wasmedia/wghostscript#1).
 *
 * `wasmPath` overrides this: the glue is imported from that URL and finds
 * its .wasm next to itself.
 */
async function loadFactory(wasmPath) {
    if (wasmPath !== undefined) {
        const glue = await import(/* @vite-ignore */ /* webpackIgnore: true */ wasmPath);
        return { factory: glue.default ?? glue };
    }
    const glue = await import("./wghostscript.js");
    const wasmUrl = new URL("./wghostscript.wasm", import.meta.url).href;
    return {
        factory: glue.default,
        locateFile: (path) => (path.endsWith(".wasm") ? wasmUrl : path),
    };
}
/** A byte sink that hands complete lines to `emit`. */
function lineSink(emit) {
    let line = [];
    return (byte) => {
        if (byte !== null && byte !== 10) {
            line.push(byte);
            return;
        }
        if (byte === null && line.length === 0)
            return;
        emit()(new TextDecoder().decode(new Uint8Array(line)));
        line = [];
    };
}
async function loadModule(wasmPath) {
    const { factory: init, locateFile } = await loadFactory(wasmPath);
    // Emscripten copies its stdio handlers into private state at startup,
    // so reassigning them later is ignored. Install byte-level trampolines
    // that forward to mutable sinks (execute() swaps in its own to capture
    // output), and expose the line printers as module.print/printErr.
    const sink = {
        print: (text) => console.log(text),
        printErr: (text) => console.error(text),
    };
    const stdio = {
        stdout: lineSink(() => sink.print),
        stderr: lineSink(() => sink.printErr),
    };
    const module = await init({
        stdout: (byte) => stdio.stdout(byte),
        stderr: (byte) => stdio.stderr(byte),
        // Ghostscript's %stdin and interactive prompt see end of file, not
        // the host's stdin (Node) or window.prompt() (browsers).
        stdin: () => null,
        ...(locateFile && { locateFile }),
    });
    Object.defineProperty(module, STDIO, { value: stdio });
    Object.defineProperty(module, "print", {
        get: () => sink.print,
        set: (fn) => { sink.print = fn; },
    });
    Object.defineProperty(module, "printErr", {
        get: () => sink.printErr,
        set: (fn) => { sink.printErr = fn; },
    });
    return module;
}
/**
 * Initialize wghostscript.
 *
 * Loads the WASM module and returns an instance with the three API
 * layers exposed: low-level `gsapi_*` bindings, CLI-style `execute()`,
 * and high-level functional `ops`.
 *
 * @example
 * ```typescript
 * const gs = await initWGhostscript();
 *
 * // High-level
 * const png = await gs.ops.renderPdf(pdfBytes, { dpi: 200 });
 *
 * // CLI-style
 * const result = await gs.execute(
 *   ["-sDEVICE=pdfwrite", "-o", "out.pdf", "input.pdf"],
 *   new Map([["input.pdf", pdfBytes]]),
 * );
 *
 * // Low-level
 * const instancePtr = gs.module._malloc(4);
 * gs.module.setValue(instancePtr, 0, "i32"); // must be 0 on entry
 * gs.api.gsapi_new_instance(instancePtr, 0);
 * ```
 */
export async function initWGhostscript(options) {
    options?.onProgress?.("loading");
    const module = await loadModule(options?.wasmPath);
    options?.onProgress?.("initializing");
    const api = createBindings(module);
    const version = readVersion(module, api);
    options?.onProgress?.("ready");
    const boundExecute = (command, inputFiles) => execute(module, command, inputFiles);
    const ops = {
        renderPdf: (input, o) => renderPdf(module, input, o),
        compressPdf: (input, o) => compressPdf(module, input, o),
        convertPdf: (input, o) => convertPdf(module, input, o),
        psToPdf: (input, o) => psToPdf(module, input, o),
        extractText: (input, o) => extractText(module, input, o),
    };
    return {
        execute: boundExecute,
        api,
        ops,
        module,
        version,
    };
}
/**
 * Read the version info exposed by `gsapi_revision`.
 *
 * The struct layout matches Ghostscript's `gsapi_revision_t`:
 *   const char *product;     // 4 bytes (pointer)
 *   const char *copyright;   // 4 bytes (pointer)
 *   long revision;           // 4 bytes
 *   long revision_date;      // 4 bytes
 */
function readVersion(module, api) {
    const STRUCT_SIZE = 16;
    const ptr = module._malloc(STRUCT_SIZE);
    try {
        const rc = api.gsapi_revision(ptr, STRUCT_SIZE);
        if (rc !== 0) {
            return { product: "", copyright: "", revision: 0, revisionDate: 0 };
        }
        const productPtr = module.getValue(ptr, "i32");
        const copyrightPtr = module.getValue(ptr + 4, "i32");
        return {
            product: productPtr ? module.UTF8ToString(productPtr) : "",
            copyright: copyrightPtr ? module.UTF8ToString(copyrightPtr) : "",
            revision: module.getValue(ptr + 8, "i32"),
            revisionDate: module.getValue(ptr + 12, "i32"),
        };
    }
    finally {
        module._free(ptr);
    }
}
//# sourceMappingURL=loader.js.map