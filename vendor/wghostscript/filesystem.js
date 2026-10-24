/**
 * MEMFS + ArrayBuffer/Blob helpers for wghostscript.
 *
 * Ghostscript reads and writes files via Emscripten's MEMFS. These
 * helpers manage per-invocation work directories, copy data into and out
 * of MEMFS, and translate between MEMFS files and JS-native types.
 */
let workDirCounter = 0;
/**
 * `data` as a Uint8Array of this realm. `instanceof` is false for arrays
 * and buffers from another realm (an iframe, a `vm` context, jsdom), so
 * check by internal type instead.
 */
export function asBytes(data) {
    if (ArrayBuffer.isView(data)) {
        return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data);
}
/** Whether `data` is an ArrayBuffer, from any realm. */
export function isArrayBuffer(data) {
    return Object.prototype.toString.call(data) === "[object ArrayBuffer]";
}
/** Create a unique scratch directory under /work and return its path. */
export function createWorkDir(module) {
    const path = `/work-${Date.now()}-${workDirCounter++}`;
    try {
        module.FS.mkdir(path);
    }
    catch {
        // Directory may already exist on retry — ignore.
    }
    return path;
}
/** Recursively remove a work directory from MEMFS. */
export function cleanWorkDir(module, dir) {
    let entries;
    try {
        entries = module.FS.readdir(dir);
    }
    catch {
        return;
    }
    for (const name of entries) {
        if (name === "." || name === "..")
            continue;
        const full = `${dir}/${name}`;
        try {
            // lstat: remove symlinks (mounted inputs) rather than follow them.
            const s = module.FS.lstat(full);
            if (module.FS.isDir(s.mode)) {
                cleanWorkDir(module, full);
            }
            else {
                module.FS.unlink(full);
            }
        }
        catch {
            // Best effort — ignore.
        }
    }
    try {
        module.FS.rmdir(dir);
    }
    catch {
        // Best effort — ignore.
    }
}
export function writeToMemFS(module, path, data) {
    module.FS.writeFile(path, data);
}
export function readFromMemFS(module, path) {
    return module.FS.readFile(path);
}
export function existsInMemFS(module, path) {
    try {
        module.FS.stat(path);
        return true;
    }
    catch {
        return false;
    }
}
export function removeFromMemFS(module, path) {
    try {
        module.FS.unlink(path);
    }
    catch {
        // ignore
    }
}
export function writeFilesToMemFS(module, dir, files) {
    for (const [name, data] of files) {
        const bytes = asBytes(data);
        writeToMemFS(module, `${dir}/${name}`, bytes);
    }
}
/**
 * Read all files in a directory, excluding any whose names appear in
 * `exclude` (typically the input filenames). With `remove`, each file is
 * deleted from MEMFS once read, so a file's MEMFS copy and its returned
 * copy are only both in memory one file at a time.
 */
export function readFilesFromMemFS(module, dir, exclude, { remove = false } = {}) {
    const out = new Map();
    let entries;
    try {
        entries = module.FS.readdir(dir);
    }
    catch {
        return out;
    }
    for (const name of entries) {
        if (name === "." || name === ".." || exclude.has(name))
            continue;
        try {
            const s = module.FS.stat(`${dir}/${name}`);
            if (module.FS.isFile(s.mode)) {
                out.set(name, module.FS.readFile(`${dir}/${name}`));
                if (remove)
                    module.FS.unlink(`${dir}/${name}`);
            }
        }
        catch {
            // ignore
        }
    }
    return out;
}
/** Copy `length` bytes from a heap pointer into a fresh Uint8Array. */
export function copyFromHeap(module, ptr, length) {
    return module.HEAPU8.slice(ptr, ptr + length);
}
/** Copy a Uint8Array into the WASM heap; returns the pointer. */
export function copyToHeap(module, data) {
    const bytes = asBytes(data);
    const ptr = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, ptr);
    return ptr;
}
/** Convert MEMFS-style output to a Blob. */
export function toBlob(data, mimeType) {
    return new Blob([data], { type: mimeType });
}
/** Convert MEMFS-style output to a data URL. */
export function toDataURL(data, mimeType) {
    // Build the binary string in chunks: one fromCharCode call per byte is
    // slow, and one call for everything overflows the argument limit.
    const chunks = [];
    for (let i = 0; i < data.length; i += 0x8000) {
        chunks.push(String.fromCharCode(...data.subarray(i, i + 0x8000)));
    }
    return `data:${mimeType};base64,${btoa(chunks.join(""))}`;
}
const MIME_BY_EXT = {
    pdf: "application/pdf",
    ps: "application/postscript",
    eps: "application/postscript",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
};
export function getMimeType(filename) {
    const dot = filename.lastIndexOf(".");
    if (dot < 0)
        return "application/octet-stream";
    return MIME_BY_EXT[filename.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
//# sourceMappingURL=filesystem.js.map