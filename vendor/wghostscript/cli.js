/**
 * CLI-style interface for Ghostscript invocations.
 *
 * Wraps `Module.callMain()` with MEMFS file management and stdout/stderr
 * capture. Ghostscript argv is passed through unchanged.
 *
 * Example:
 *   execute(module,
 *     ["-sDEVICE=png16m", "-r150", "-o", "page-%d.png", "input.pdf"],
 *     new Map([["input.pdf", pdfBytes]]),
 *   );
 */
import { createWorkDir, cleanWorkDir, readFilesFromMemFS, } from "./filesystem.js";
import { prepareInputs } from "./inputs.js";
/** Where execute() finds a module's byte-level stdout/stderr sinks. */
export const STDIO = Symbol.for("wghostscript.stdio");
/**
 * Parse a command string into an argv array, respecting quoted strings.
 * Arguments are separated by any whitespace; `''` and `""` give an empty
 * argument.
 *
 * Note: Ghostscript invocations are typically driven from argv arrays
 * directly. This helper exists for parity with wimagemagick and to
 * support `execute(module, "command string", ...)`.
 */
export function parseCommand(command) {
    const args = [];
    let current = "";
    let quoted = false; // the current argument had quotes, so keep it if empty
    let inSingle = false;
    let inDouble = false;
    for (const ch of command) {
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            quoted = true;
        }
        else if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            quoted = true;
        }
        else if (/\s/.test(ch) && !inSingle && !inDouble) {
            if (current.length > 0 || quoted) {
                args.push(current);
                current = "";
                quoted = false;
            }
        }
        else {
            current += ch;
        }
    }
    if (current.length > 0 || quoted) {
        args.push(current);
    }
    return args;
}
/**
 * Execute a Ghostscript command with file I/O.
 *
 * Input filenames in `inputFiles` become files inside a per-invocation
 * MEMFS work directory. Bytes and Blobs are copied in; host paths (Node)
 * and OPFS file handles (dedicated worker) are read in place through a
 * read-only wopfs mount (see `inputs.ts`). Ghostscript runs with the
 * work directory as its cwd, and `command` is passed to it unchanged,
 * so relative paths (inputs, `-o page-%d.png`, `-sFoo=file.icc`) resolve
 * there. The files a run leaves in the work directory are its outputs.
 */
export async function execute(module, command, inputFiles) {
    const args = typeof command === "string" ? parseCommand(command) : [...command];
    const workDir = createWorkDir(module);
    const inputNames = new Set(inputFiles?.keys());
    let prepared;
    try {
        prepared = await prepareInputs(module, workDir, inputFiles ?? new Map());
    }
    catch (err) {
        cleanWorkDir(module, workDir);
        throw err;
    }
    // Capture stdout and stderr: byte-wise when the module has sinks for
    // it, else through print/printErr, which only see complete lines.
    const out = [];
    const err = [];
    let printed = "";
    let printedErr = "";
    const sinks = module[STDIO];
    const origSinks = sinks && { ...sinks };
    const origPrint = module.print;
    const origPrintErr = module.printErr;
    if (sinks) {
        sinks.stdout = (byte) => { if (byte !== null)
            out.push(byte); };
        sinks.stderr = (byte) => { if (byte !== null)
            err.push(byte); };
    }
    else {
        module.print = (text) => { printed += text + "\n"; };
        module.printErr = (text) => { printedErr += text + "\n"; };
    }
    // Under Node the glue sets process.exitCode on every exit; keep the
    // host's own exit code.
    const proc = globalThis.process;
    const hostExitCode = proc?.exitCode;
    // callMain allocates argv on the C stack and never pops it; restore
    // the stack pointer so repeated runs don't exhaust the stack.
    const sp = module.stackSave?.();
    const origCwd = module.FS.cwd();
    let exitCode;
    let exception = "";
    try {
        module.FS.chdir(workDir);
        exitCode = module.callMain(args);
    }
    catch (e) {
        exitCode = 1;
        exception = `Exception: ${e}\n`;
    }
    finally {
        if (sp !== undefined)
            module.stackRestore?.(sp);
        if (proc)
            proc.exitCode = hostExitCode;
        module.FS.chdir(origCwd);
        if (sinks)
            Object.assign(sinks, origSinks);
        module.print = origPrint;
        module.printErr = origPrintErr;
    }
    let outputFiles;
    try {
        outputFiles = readFilesFromMemFS(module, workDir, inputNames, { remove: true });
    }
    finally {
        // Unmount before deleting the work directory, so cleanup can't reach
        // into the mount.
        await prepared.release();
        cleanWorkDir(module, workDir);
    }
    const decode = (bytes) => new TextDecoder().decode(new Uint8Array(bytes));
    const stdout = sinks ? decode(out) : printed;
    const stderr = (sinks ? decode(err) : printedErr) + exception;
    return {
        exitCode,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        outputFiles,
    };
}
//# sourceMappingURL=cli.js.map