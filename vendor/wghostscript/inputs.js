/**
 * Input handling: bytes are staged into MEMFS; file references are read
 * in place through a read-only @wasmedia/wopfs mount when the
 * environment allows it, and copied otherwise.
 *
 *   - `string` (Node only): a host path, mounted with wopfs's `node`
 *     backend. The file is read from disk as Ghostscript needs it.
 *   - `FileSystemFileHandle` in a dedicated worker, for a file in OPFS:
 *     mounted with the `opfs` backend through a sync access handle.
 *   - Anything else (bytes, `Blob`/`File`, picker or main-thread
 *     handles): copied into MEMFS, as before wopfs.
 *
 * Mounted inputs live under `<workDir>/.inputs` and appear in the work
 * directory as symlinks with their usual names, so relative paths
 * behave the same whichever way an input arrived.
 */
import { asBytes, isArrayBuffer } from "./filesystem.js";
/** Directory, inside a work directory, where mounted inputs live. */
export const MOUNT_DIR = ".inputs";
function isNode() {
    const proc = globalThis.process;
    return !!proc?.versions?.node;
}
/** `node:path`'s resolve, imported only under Node (and hidden from bundlers). */
async function resolveHostPath(path) {
    const specifier = "node:path";
    const { resolve } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier));
    return resolve(path);
}
function isDedicatedWorker() {
    const scope = globalThis
        .DedicatedWorkerGlobalScope;
    return typeof scope === "function" && globalThis instanceof scope;
}
function isFileHandle(input) {
    return typeof input === "object" && input !== null && input.kind === "file" &&
        typeof input.getFile === "function";
}
/**
 * Whether a handle is an OPFS file this worker can mount. Only OPFS
 * files support sync access handles; picker handles reject. Opening and
 * closing one is the probe, rather than `FileSystemDirectoryHandle.
 * resolve()`, which crashes WebKit 26 for handles posted to a worker.
 */
async function canMountHandle(handle) {
    if (!isDedicatedWorker() || typeof handle.createSyncAccessHandle !== "function")
        return false;
    try {
        const access = await handle.createSyncAccessHandle();
        access.close();
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Bytes for an input that is being copied, and whether they're a fresh
 * copy MEMFS can keep (rather than the caller's own array).
 */
async function toBytes(input) {
    if (ArrayBuffer.isView(input) || isArrayBuffer(input))
        return { bytes: asBytes(input), owned: false };
    if (typeof input === "string") {
        throw new Error(`"${input}": file paths are only supported under Node`);
    }
    const blob = isFileHandle(input) ? await input.getFile() : input;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), owned: true };
}
/**
 * Check an input name: a relative, normalized path, so the input stays
 * inside the work directory (the rule wopfs applies to mounted inputs).
 */
function checkInputName(name) {
    if (name.split("/").some((p) => p === "" || p === "." || p === "..")) {
        throw new Error(`input name must be a relative, normalized path: ${JSON.stringify(name)}`);
    }
}
/** Create the directories `name` needs inside `workDir`. */
function makeParents(module, workDir, name) {
    const slash = name.lastIndexOf("/");
    if (slash > 0)
        module.FS.mkdirTree(`${workDir}/${name.slice(0, slash)}`);
}
/**
 * Put `inputs` into `workDir`: copy what must be copied, mount what can
 * be mounted. Call `release()` (in a `finally`) after the run.
 */
export async function prepareInputs(module, workDir, inputs) {
    const mounted = {};
    let backend;
    for (const name of inputs.keys())
        checkInputName(name);
    for (const [name, input] of inputs) {
        if (typeof input === "string" && isNode()) {
            mounted[name] = await resolveHostPath(input);
            backend = "node";
        }
        else if (isFileHandle(input) && (await canMountHandle(input))) {
            mounted[name] = input;
            backend = "opfs";
        }
        else {
            makeParents(module, workDir, name);
            const { bytes, owned } = await toBytes(input);
            // canOwn: MEMFS keeps a Blob's fresh bytes instead of copying them.
            module.FS.writeFile(`${workDir}/${name}`, bytes, { canOwn: owned });
        }
    }
    if (backend === undefined)
        return { release: async () => { } };
    // Vendored (scripts/vendor-wopfs.mjs) so it resolves without a bundler.
    const { mountFiles } = await import("./vendor/wopfs/index.js");
    const mountPoint = `${workDir}/${MOUNT_DIR}`;
    // Input-only mount: no outputDir, so nothing is written outside MEMFS.
    // Ghostscript's outputs land in the work directory as usual.
    const mount = await mountFiles(module, mountPoint, { inputs: mounted, backend });
    try {
        for (const name of Object.keys(mounted)) {
            makeParents(module, workDir, name);
            module.FS.symlink(`${mountPoint}/${name}`, `${workDir}/${name}`);
        }
    }
    catch (err) {
        await mount.release();
        throw err;
    }
    return { release: () => mount.release() };
}
//# sourceMappingURL=inputs.js.map