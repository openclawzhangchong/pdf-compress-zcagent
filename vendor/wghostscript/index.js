/**
 * wghostscript — Ghostscript compiled to WebAssembly.
 *
 * @example
 * ```typescript
 * import { initWGhostscript } from '@wasmedia/wghostscript';
 *
 * const gs = await initWGhostscript();
 *
 * // High-level functional API
 * const pages = await gs.ops.renderPdf(pdfBytes, { dpi: 200 });
 * const smaller = await gs.ops.compressPdf(pdfBytes, { preset: 'ebook' });
 * const text = await gs.ops.extractText(pdfBytes);
 *
 * // CLI-style
 * const result = await gs.execute(
 *   ["-sDEVICE=png16m", "-r150", "-o", "page-%d.png", "input.pdf"],
 *   new Map([["input.pdf", pdfBytes]]),
 * );
 *
 * // Low-level gsapi
 * const ptr = gs.module._malloc(4);
 * gs.module.setValue(ptr, 0, "i32"); // must be 0 on entry
 * gs.api.gsapi_new_instance(ptr, 0);
 * ```
 */
// Main entry point
export { initWGhostscript } from "./loader.js";
// CLI interface
export { execute, parseCommand } from "./cli.js";
// Functional high-level API (also exposed via instance.ops)
export { renderPdf, compressPdf, convertPdf, psToPdf, extractText, } from "./operations.js";
// Low-level API bindings
export { createBindings } from "./api.js";
// Filesystem helpers
export { createWorkDir, cleanWorkDir, writeToMemFS, readFromMemFS, existsInMemFS, removeFromMemFS, writeFilesToMemFS, readFilesFromMemFS, copyFromHeap, copyToHeap, toBlob, toDataURL, getMimeType, } from "./filesystem.js";
export { GsArgEncoding } from "./types.js";
//# sourceMappingURL=index.js.map