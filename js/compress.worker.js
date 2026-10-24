/**
 * compress.worker.js — PDF 压缩 Web Worker(ESM)· zcagent(智策张翀)
 *
 * 双管线路由:
 *  1. 照片型 PDF(每页文本 < 200 字符,拍照扫描件)
 *     → pdf.js 渲染 + OffscreenCanvas 重采样 + JPEG 重建
 *  2. 文字型 PDF(课件/文档)
 *     → Ghostscript-WASM pdfwrite 强制 JPEG 重编码 + 保留文本层
 *
 * 注意:依赖全部用动态 import。静态 import 在 worker 里失败是静默的
 * (主线程只收到 "Worker 异常:未知"),动态 import 才能把真实错误上报。
 * Ghostscript(17MB)按需加载 —— 照片型不需要它。
 */

var PHOTO_TIERS = {
  low:  { dpi: 100, quality: 0.48, ptPxScale: 0.80 },  // 极限:适合上传系统/微信传阅
  mid:  { dpi: 150, quality: 0.55, ptPxScale: 0.90 },  // 均衡:默认,清晰度与体积兼顾
  high: { dpi: 200, quality: 0.72, ptPxScale: 1.00 },  // 高质量:接近原稿
};

var jobId = null;
function log(msg) {
  try { self.postMessage({ type: 'log', id: jobId, msg: String(msg) }); } catch (e) {}
}

/* ---------- 依赖懒加载 ---------- */

var DEP = { pdfjs: null, PDFDocument: null };

async function loadPdfLibs() {
  if (DEP.pdfjs) return DEP;
  log('加载 pdf.js(1.7MB)...');
  var t0 = Date.now();
  var pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  log('pdf.js OK v' + pdfjs.version + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  log('pdf.workerSrc = ' + pdfjs.GlobalWorkerOptions.workerSrc);

  var t1 = Date.now();
  var pl = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
  DEP.pdfjs = pdfjs;
  DEP.PDFDocument = pl.PDFDocument;
  log('pdf-lib OK ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');
  return DEP;
}

var gsMod = null;
async function ensureGs() {
  if (gsMod) return gsMod;
  log('加载 Ghostscript WASM(17MB,仅文字型 PDF 需要)...');
  var t0 = Date.now();
  var m = await import('../vendor/wghostscript/index.js');
  log('wghostscript 模块 OK ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, 开始初始化引擎');
  var t1 = Date.now();
  gsMod = await m.initWGhostscript();
  log('Ghostscript 就绪 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');
  return gsMod;
}

/* ---------- 文字型:Ghostscript 重编码 ---------- */

async function gsCompress(input) {
  var gs = await ensureGs();
  var t0 = Date.now();
  var r = await gs.execute(
    ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite',
     '-dPassThroughJPEGImages=false', '-dCompatibilityLevel=1.5',
     '-o', 'out.pdf', 'input.pdf'],
    new Map([['input.pdf', input]])
  );
  var out = r.outputFiles.get('out.pdf');
  if (!out) throw new Error('Ghostscript 未产生输出: ' + String(r.stderr || '').slice(0, 200));
  log('gs 重编码完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, 输出 ' + (out.length / 1048576).toFixed(2) + 'MB');
  return out;
}

/* ---------- 照片型:渲染重采样 ---------- */

function calcScale(vp1, tier) {
  if (vp1.width > 2200 || vp1.height > 2200) return tier.ptPxScale; // 像素当 pt 用的扫描件
  return tier.dpi / 72;
}

async function renderCompress(bytes, tierKey) {
  var t = PHOTO_TIERS[tierKey] || PHOTO_TIERS.mid;
  var d = await loadPdfLibs();
  log('档位 ' + tierKey + ': dpi=' + t.dpi + ' quality=' + t.quality + ' ptPxScale=' + t.ptPxScale);

  var tOpen = Date.now();
  var doc = await d.pdfjs.getDocument({
    data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false,
  }).promise;
  log('pdf.js 打开成功 pages=' + doc.numPages + ' ' + ((Date.now() - tOpen) / 1000).toFixed(1) + 's');

  var out = await d.PDFDocument.create();
  for (var i = 1; i <= doc.numPages; i++) {
    var tPage = Date.now();
    var page = await doc.getPage(i);
    var vp1 = page.getViewport({ scale: 1 });
    var scale = calcScale(vp1, t);
    var vp = page.getViewport({ scale: scale });
    var canvas = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    var blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: t.quality });
    var jpgBuf = new Uint8Array(await blob.arrayBuffer());
    var img = await out.embedJpg(jpgBuf);
    var pg = out.addPage([vp1.width, vp1.height]);
    pg.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    log('页 ' + i + '/' + doc.numPages + ' ' + canvas.width + 'x' + canvas.height +
        ' → JPEG ' + (jpgBuf.length / 1024).toFixed(0) + 'KB  ' + ((Date.now() - tPage) / 1000).toFixed(1) + 's');
    page.cleanup();
    canvas = null;
  }
  try { doc.cleanup(); } catch (e) { log('cleanup 忽略: ' + e.message); }

  var tSave = Date.now();
  var outBytes = await out.save({ useObjectStreams: true });
  log('PDF 重建完成 ' + (outBytes.length / 1048576).toFixed(2) + 'MB ' + ((Date.now() - tSave) / 1000).toFixed(1) + 's');
  return new Uint8Array(outBytes);
}

/* ---------- 文本探测(路由) ---------- */

async function probe(bytes) {
  var d = await loadPdfLibs();
  var doc = await d.pdfjs.getDocument({
    data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false,
  }).promise;
  var n = doc.numPages;
  var check = Math.min(n, 5);
  var textLen = 0;
  for (var i = 1; i <= check; i++) {
    try {
      var pg = await doc.getPage(i);           // 必须先 await,getPage 返回 Promise
      var tc = await pg.getTextContent();
      textLen += tc.items.map(function (it) { return it.str || ''; }).join('').replace(/\s/g, '').length;
    } catch (e) { log('页 ' + i + ' 文本读取失败: ' + e.message); }
  }
  var p1 = await doc.getPage(1);
  var vp = p1.getViewport({ scale: 1 });
  var size = vp.width.toFixed(0) + 'x' + vp.height.toFixed(0) + 'pt';
  try { doc.cleanup(); } catch (e) {}
  var avg = textLen / check;
  return { pages: n, avgText: avg, isPhoto: avg < 200, page1: size };
}

/* ---------- 调度 ---------- */

self.onmessage = async function (e) {
  var d = e.data;
  if (!d || d.type !== 'compress') return;
  jobId = d.id;
  var t0 = Date.now();
  try {
    var bytes = new Uint8Array(d.bytes);
    log('收到文件 ' + (bytes.length / 1048576).toFixed(2) + 'MB,分析中');
    var info = await probe(bytes);
    log('分析: ' + info.pages + ' 页, 页1=' + info.page1 + ', 平均文本 ' + info.avgText.toFixed(0) +
        ' 字 → ' + (info.isPhoto ? '照片型(渲染重采样)' : '文字型(Ghostscript)'));

    var out = info.isPhoto
      ? await renderCompress(bytes, d.preset)
      : await gsCompress(bytes);

    log('全部完成 总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    self.postMessage({ type: 'done', id: d.id, bytes: out, route: info.isPhoto ? 'photo' : 'text' }, [out.buffer]);
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    var stack = String((err && err.stack) || '').split('\n').slice(0, 3).join(' ← ');
    log('❌ 错误: ' + msg + ' | ' + stack);
    self.postMessage({ type: 'error', id: d.id, message: msg });
  }
};

// 加载完成探针:主线程据此判断 worker 脚本是否成功执行
self.postMessage({ type: 'log', id: null, msg: 'worker 脚本已加载(模块解析成功)' });
