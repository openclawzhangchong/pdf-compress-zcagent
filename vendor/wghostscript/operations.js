/**
 * High-level functional API for wghostscript.
 *
 * Each operation is a one-shot async function: it sets up a work
 * directory, invokes Ghostscript with appropriate argv, collects the
 * output, and tears down. Hides MEMFS and gsapi mechanics from callers.
 *
 * For lower-level control, use `execute()` from `./cli.js` or the
 * `gsapi_*` bindings from `./api.js`.
 */
import { execute } from "./cli.js";
import { asBytes, isArrayBuffer } from "./filesystem.js";
const COMMON_FLAGS = ["-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET"];
/**
 * Flags for ops that read a PDF. Without -dQUIET, the PDF interpreter
 * reports "Processing pages …", which is how checkResult knows the input
 * was opened as a PDF at all (anything else is run as PostScript, and an
 * empty program makes a blank page), and reports pages it had to skip.
 * Not -dPDFSTOPONERROR: that also fails files Ghostscript can repair,
 * such as a damaged xref table.
 */
const PDF_FLAGS = ["-dNOPAUSE", "-dBATCH", "-dSAFER"];
const PASSWORD_ERROR = /requires a password|Password did not work|Cannot decrypt/;
const UNREADABLE_INPUT = /Couldn't initialise file/;
const PDF_OPENED = /^Processing pages \d+ through \d+\./m;
/** A page Ghostscript couldn't process, which it leaves out (or blank) and exits 0. */
const PAGE_LOST = /Couldn't get page info|page not found|Page drawing error occurred|page will be missing/;
/** Lines of Ghostscript's banner and progress reports. */
const NOISE = /^(GPL Ghostscript [\d.]+ \(\d{4}-|Copyright \(C\)|This software is supplied|see the file COPYING|Processing pages |Page \d+$|Loading font )/;
/** What Ghostscript said, from stdout and stderr, without banner and progress lines. */
function messages(result) {
    return `${result.stdout}\n${result.stderr}`
        .split("\n")
        .filter((line) => line.trim() && !NOISE.test(line))
        .join("\n");
}
/**
 * Throw if Ghostscript failed. It exits 0 when it can't open the input
 * PDF (encrypted, wrong password, unreadable) and pdfwrite then emits a
 * blank page, so the exit code alone isn't enough. `pdfInput`: the op
 * ran with PDF_FLAGS and the input must have opened as a PDF.
 */
function checkResult(op, result, pdfInput = false) {
    const output = `${result.stderr}\n${result.stdout}`;
    if (PASSWORD_ERROR.test(output)) {
        throw new Error(`${op}: PDF is encrypted — password required or incorrect`);
    }
    if (result.exitCode !== 0 || UNREADABLE_INPUT.test(output)) {
        throw new Error(`${op} failed: ${messages(result) || `exit code ${result.exitCode}`}`);
    }
    if (pdfInput && !PDF_OPENED.test(result.stdout)) {
        throw new Error(`${op} failed: the input is not a PDF${messages(result) ? `: ${messages(result)}` : ""}`);
    }
    if (pdfInput && PAGE_LOST.test(output)) {
        throw new Error(`${op} failed: Ghostscript couldn't process every page: ${messages(result)}`);
    }
}
/** Throw on empty input bytes, which Ghostscript would run as an empty program. */
function checkNotEmpty(op, input) {
    const size = ArrayBuffer.isView(input) || isArrayBuffer(input)
        ? input.byteLength
        : typeof input === "object" && input !== null && "size" in input
            ? input.size
            : undefined;
    if (size === 0)
        throw new Error(`${op}: the input is empty`);
}
/** Arguments that open an encrypted input PDF. */
function passwordArgs(password) {
    return password === undefined ? [] : [`-sPDFPassword=${password}`];
}
/** Output file extension by device-name prefix. */
const DEVICE_EXTENSIONS = [
    ["png", "png"],
    ["jpeg", "jpg"],
    ["tiff", "tif"],
    ["bmp", "bmp"],
    ["pdfwrite", "pdf"],
    ["ps2write", "ps"],
    ["txtwrite", "txt"],
];
const VECTOR_DEVICES = new Set(["pdfwrite", "ps2write", "txtwrite"]);
/**
 * Rasterize PDF pages to images. Returns a map of output filenames to
 * file bytes, one file per page, named `page-<n>.<ext>` by PDF page
 * number (so `firstPage: 3` starts at `page-3`).
 */
export async function renderPdf(module, input, opts = {}) {
    const device = opts.device ?? "png16m";
    const dpi = opts.dpi ?? 150;
    const ext = DEVICE_EXTENSIONS.find(([prefix]) => device.startsWith(prefix))?.[1];
    if (!ext)
        throw new Error(`renderPdf: unsupported device "${device}"`);
    const args = [...PDF_FLAGS, `-sDEVICE=${device}`, `-r${dpi}`];
    // Antialiasing applies to raster devices only; vector devices reject it.
    if (!VECTOR_DEVICES.has(device)) {
        args.push(`-dTextAlphaBits=${opts.textAlphaBits ?? 4}`, `-dGraphicsAlphaBits=${opts.graphicsAlphaBits ?? 4}`);
    }
    if (opts.firstPage !== undefined)
        args.push(`-dFirstPage=${opts.firstPage}`);
    if (opts.lastPage !== undefined)
        args.push(`-dLastPage=${opts.lastPage}`);
    if (device.startsWith("jpeg") && opts.quality !== undefined) {
        args.push(`-dJPEGQ=${opts.quality}`);
    }
    args.push(...passwordArgs(opts.password));
    args.push("-o", `page-%d.${ext}`, "input.pdf");
    checkNotEmpty("renderPdf", input);
    const result = await execute(module, args, new Map([["input.pdf", input]]));
    checkResult("renderPdf", result, true);
    // An empty page range renders nothing, with exit code 0.
    if (result.outputFiles.size === 0) {
        throw new Error(`renderPdf produced no pages: ${messages(result)}`.trimEnd());
    }
    // Ghostscript's %d counts rendered pages from 1; name files by PDF page.
    const offset = (opts.firstPage ?? 1) - 1;
    const pages = new Map();
    for (const [name, bytes] of result.outputFiles) {
        const n = Number(/^page-(\d+)\./.exec(name)?.[1]);
        pages.set(Number.isInteger(n) ? `page-${n + offset}.${ext}` : name, bytes);
    }
    return pages;
}
/**
 * Re-encode a PDF, typically smaller than the input, using one of
 * Ghostscript's `-dPDFSETTINGS` presets.
 */
export async function compressPdf(module, input, opts = {}) {
    const preset = opts.preset ?? "ebook";
    // The preset picks the PDF version too: a -dCompatibilityLevel here
    // would override it (and 1.4 drops object streams and layers).
    const args = [...PDF_FLAGS, "-sDEVICE=pdfwrite", `-dPDFSETTINGS=/${preset}`];
    // A resolution only applies when downsampling is on, which the
    // "default" preset leaves off.
    for (const [kind, dpi] of [["Color", opts.colorDpi], ["Gray", opts.grayDpi], ["Mono", opts.monoDpi]]) {
        if (dpi !== undefined)
            args.push(`-dDownsample${kind}Images=true`, `-d${kind}ImageResolution=${dpi}`);
    }
    args.push(...passwordArgs(opts.password));
    args.push("-o", "out.pdf", "input.pdf");
    checkNotEmpty("compressPdf", input);
    const result = await execute(module, args, new Map([["input.pdf", input]]));
    checkResult("compressPdf", result, true);
    const out = result.outputFiles.get("out.pdf");
    if (!out)
        throw new Error("compressPdf produced no output");
    return out;
}
const TARGETS = {
    "PDF/A-1b": { standard: "PDF/A", part: 1 },
    "PDF/A-2b": { standard: "PDF/A", part: 2 },
    "PDF/A-3b": { standard: "PDF/A", part: 3 },
    "PDF/X-3": { standard: "PDF/X", part: 3 },
    "PDF/X-4": { standard: "PDF/X", part: 4 },
};
/** pdfwrite's warning that it kept something PDF/A doesn't allow. */
const NOT_CONFORMING = /may not conform to PDF\/A/;
/** ICC colour-space signature → component count and gs strategy. */
const ICC_SPACES = {
    "RGB ": { n: 3, strategy: "RGB" },
    "CMYK": { n: 4, strategy: "CMYK" },
    "GRAY": { n: 1, strategy: "Gray" },
};
/**
 * Check an ICC profile's header and read its colour space (bytes 16–19).
 * A profile starts with its size, and has the signature "acsp" at 36.
 */
function iccColorSpace(profile) {
    const ascii = (from) => String.fromCharCode(...profile.subarray(from, from + 4));
    const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
    if (profile.length < 132 || view.getUint32(0) > profile.length || view.getUint32(0) < 132 || ascii(36) !== "acsp") {
        throw new Error("convertPdf: iccProfile is not an ICC profile");
    }
    const sig = ascii(16);
    const space = ICC_SPACES[sig];
    if (!space) {
        throw new Error(`convertPdf: unsupported ICC profile colour space "${sig}"`);
    }
    return space;
}
/**
 * Convert PDF to a PDF/A or PDF/X variant.
 *
 * Both standards need an OutputIntent carrying an ICC profile.
 * Ghostscript normally gets one from lib/PDFA_def.ps or PDFX_def.ps,
 * which aren't in the WASM build's ROM, so the equivalent pdfmark
 * program is generated here and run ahead of the input.
 */
export async function convertPdf(module, input, opts) {
    const target = Object.hasOwn(TARGETS, opts?.target) ? TARGETS[opts.target] : undefined;
    if (!target) {
        throw new Error(`convertPdf: unknown target ${JSON.stringify(opts?.target)} (expected ${Object.keys(TARGETS).join(", ")})`);
    }
    const isPdfA = target.standard === "PDF/A";
    const inputs = new Map([
        ["input.pdf", input],
    ]);
    let iccPath;
    let space;
    if (opts.iccProfile) {
        const profile = asBytes(opts.iccProfile);
        space = iccColorSpace(profile);
        inputs.set("profile.icc", profile);
        iccPath = "profile.icc";
    }
    else if (isPdfA) {
        space = ICC_SPACES["RGB "];
        iccPath = "%rom%iccprofiles/srgb.icc";
    }
    else {
        space = ICC_SPACES["CMYK"];
        iccPath = "%rom%iccprofiles/default_cmyk.icc";
    }
    const args = [
        ...PDF_FLAGS,
        "-sDEVICE=pdfwrite",
        `-sColorConversionStrategy=${space.strategy}`,
        `--permit-file-read=${iccPath}`,
    ];
    // Convert colours to the caller's profile, not just declare it.
    if (opts.iccProfile)
        args.push(`-sOutputICCProfile=${iccPath}`);
    let defPs;
    if (isPdfA) {
        args.push(`-dPDFA=${target.part}`, "-dPDFACompatibilityPolicy=1");
        defPs = outputIntentPs("GTS_PDFA1", space.n, iccPath, "(Custom)");
    }
    else {
        const version = target.part;
        if (version === 3 && space.strategy === "RGB") {
            throw new Error("convertPdf: PDF/X-3 does not allow an RGB output profile");
        }
        args.push(`-dPDFX=${version}`);
        // PDF/X requires a Title. This one is only a fallback: the input's
        // own DocInfo is applied after def.ps, so a real title wins.
        defPs =
            `[ /GTS_PDFXVersion (${version === 4 ? "PDF/X-4" : "PDF/X-3:2002"}) /Trapped /False /Title (Untitled) /DOCINFO pdfmark\n` +
                outputIntentPs("GTS_PDFX", space.n, iccPath, "(Custom) /OutputCondition (Custom) /RegistryName (http://www.color.org)");
    }
    inputs.set("def.ps", new TextEncoder().encode(defPs));
    args.push(...passwordArgs(opts.password));
    args.push("-o", "out.pdf", "def.ps", "input.pdf");
    checkNotEmpty("convertPdf", input);
    const result = await execute(module, args, inputs);
    checkResult("convertPdf", result, true);
    if (isPdfA && NOT_CONFORMING.test(result.stdout + result.stderr)) {
        throw new Error(`convertPdf: can't make this file ${opts.target}: ${messages(result)}`);
    }
    const out = result.outputFiles.get("out.pdf");
    if (!out)
        throw new Error("convertPdf produced no output");
    return out;
}
/** pdfmark program that embeds an ICC profile as the document's OutputIntent. */
function outputIntentPs(subtype, components, iccPath, identifier) {
    return `[/_objdef {icc_OI} /type /stream /OBJ pdfmark
[{icc_OI} << /N ${components} >> /PUT pdfmark
[{icc_OI} (${iccPath}) (r) file /PUT pdfmark
[/_objdef {OutputIntent_OI} /type /dict /OBJ pdfmark
[{OutputIntent_OI} <<
  /Type /OutputIntent
  /S /${subtype}
  /DestOutputProfile {icc_OI}
  /OutputConditionIdentifier ${identifier}
>> /PUT pdfmark
[{Catalog} << /OutputIntents [ {OutputIntent_OI} ] >> /PUT pdfmark
`;
}
/** Convert PostScript input to PDF. */
export async function psToPdf(module, input, opts = {}) {
    const args = [...COMMON_FLAGS, "-sDEVICE=pdfwrite"];
    if (opts.preset)
        args.push(`-dPDFSETTINGS=/${opts.preset}`);
    args.push("-o", "out.pdf", "input.ps");
    checkNotEmpty("psToPdf", input);
    const result = await execute(module, args, new Map([["input.ps", input]]));
    checkResult("psToPdf", result);
    const out = result.outputFiles.get("out.pdf");
    if (!out)
        throw new Error("psToPdf produced no output");
    return out;
}
/** Extract text from a PDF using Ghostscript's txtwrite device. */
export async function extractText(module, input, opts = {}) {
    // Default to "page" (TextFormat=2) — plain readable text, which is
    // what most callers want. "table" (0) emits per-character XML with
    // bboxes; "bbox" (1) emits block/line/span XML with bboxes.
    const mode = opts.mode ?? "page";
    const args = [
        ...PDF_FLAGS,
        "-sDEVICE=txtwrite",
        `-dTextFormat=${mode === "table" ? 0 : mode === "page" ? 2 : 1}`,
    ];
    if (opts.firstPage !== undefined)
        args.push(`-dFirstPage=${opts.firstPage}`);
    if (opts.lastPage !== undefined)
        args.push(`-dLastPage=${opts.lastPage}`);
    args.push(...passwordArgs(opts.password));
    args.push("-o", "out.txt", "input.pdf");
    checkNotEmpty("extractText", input);
    const result = await execute(module, args, new Map([["input.pdf", input]]));
    checkResult("extractText", result, true);
    const out = result.outputFiles.get("out.txt");
    if (!out)
        throw new Error("extractText produced no output");
    // Ghostscript's txtwrite encoding depends on TextFormat:
    //   - mode "page" (TextFormat=2) emits UTF-16LE with BOM.
    //   - mode "table" / "bbox" (XML-shaped) emit UTF-8.
    const encoding = mode === "page" ? "utf-16le" : "utf-8";
    // TextDecoder drops only a leading BOM, but "page" mode writes one at
    // the start of every page.
    return new TextDecoder(encoding).decode(out).replace(/\uFEFF/g, "");
}
//# sourceMappingURL=operations.js.map