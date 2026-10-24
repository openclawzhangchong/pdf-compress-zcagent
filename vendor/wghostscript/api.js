/**
 * Ghostscript C API bindings via Emscripten cwrap.
 *
 * Provides typed wrappers around the `gsapi_*` functions exported from
 * the WASM module. For direct, low-level access to Ghostscript's C API
 * from JavaScript.
 *
 * See <https://ghostscript.readthedocs.io/en/latest/API.html> for the
 * canonical API documentation.
 */
/** Create typed bindings for all exported gsapi C functions. */
export function createBindings(module) {
    const w = (name, ret, args) => module.cwrap(name, ret, args);
    return {
        // Version / lifecycle
        gsapi_revision: w("gsapi_revision", "number", ["number", "number"]),
        gsapi_new_instance: w("gsapi_new_instance", "number", ["number", "number"]),
        gsapi_delete_instance: w("gsapi_delete_instance", null, [
            "number",
        ]),
        // Stdio
        gsapi_set_stdio: w("gsapi_set_stdio", "number", [
            "number",
            "number",
            "number",
            "number",
        ]),
        // Argument encoding
        gsapi_set_arg_encoding: w("gsapi_set_arg_encoding", "number", [
            "number",
            "number",
        ]),
        // Initialization / execution
        gsapi_init_with_args: w("gsapi_init_with_args", "number", [
            "number",
            "number",
            "number",
        ]),
        gsapi_run_string_begin: w("gsapi_run_string_begin", "number", [
            "number",
            "number",
            "number",
        ]),
        gsapi_run_string_continue: w("gsapi_run_string_continue", "number", [
            "number",
            "number",
            "number",
            "number",
            "number",
        ]),
        gsapi_run_string_end: w("gsapi_run_string_end", "number", [
            "number",
            "number",
            "number",
        ]),
        gsapi_run_string: w("gsapi_run_string", "number", [
            "number",
            "number",
            "number",
            "number",
        ]),
        // Shutdown
        gsapi_exit: w("gsapi_exit", "number", ["number"]),
    };
}
//# sourceMappingURL=api.js.map