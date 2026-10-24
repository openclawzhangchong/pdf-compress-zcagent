/**
 * app.js — PDF 智能压缩 · zcagent(智策张翀)
 * 纯前端批量压缩:多选文件 / 拖拽 / 整个文件夹递归读取 → Ghostscript-WASM 压缩 → ZIP 打包下载
 */

(function () {
  'use strict';

  /* ---------- 常量与状态 ---------- */

  var PRESETS = {
    low: { gs: 'screen', label: '低 · 极限', hint: '100dpi/q60,适合上传系统、微信传阅(照片型 PDF 可省 60-75%)' },
    mid: { gs: 'ebook', label: '中 · 均衡', hint: '150dpi/q72,日常推荐,画质体积兼顾(照片型 PDF 可省 50-70%)' },
    high: { gs: 'printer', label: '高 · 高质量', hint: '200dpi/q82,接近原稿,适合打印存档' },
  };

  // 业务脚本版本号:静态托管有 CDN 缓存,改代码必须改这里才能让线上生效
  var ASSET_VER = '1024i';

  var state = {
    files: [],        // { id, file, name, relPath, size, status, outBytes, outName, error, savedPct }
    preset: 'mid',
    running: false,
    worker: null,
    seq: 0,
  };

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ---------- 调试日志(渲染到 DOM,线上可直接看到) ---------- */

  var DEBUG = /[?&]debug=1/.test(location.search) || location.hash === '#debug';
  var logLines = [];

  function dlog(msg) {
    var d = new Date();
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    var ts = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    logLines.push(ts + ' ' + msg);
    if (logLines.length > 300) logLines.shift();
    var el = document.getElementById('debugLog');
    if (el) { el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight; }
    try { console.log('[pdf-compress]', msg); } catch (e) {}
  }

  function showDebug(on) {
    var p = document.getElementById('debugPanel');
    if (!p) return;
    p.hidden = !on;
    document.getElementById('btnDebug').classList.toggle('active', on);
  }

  /* ---------- 工具函数 ---------- */

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isPdf(name) {
    return /\.pdf$/i.test(name || '');
  }

  /* ---------- 文件收集 ---------- */

  function addFiles(list, relBase) {
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!isPdf(f.name)) continue;
      var rel = relBase ? (relBase + '/' + f.name) : (f.webkitRelativePath || f.name);
      state.files.push({
        id: 'f' + (++state.seq),
        file: f,
        name: f.name,
        relPath: rel,
        size: f.size,
        status: 'pending',
        outBytes: null,
        outName: null,
        error: null,
        savedPct: null,
      });
      added++;
    }
    if (added) dlog('添加 ' + added + ' 个 PDF' + (relBase ? '(目录 ' + relBase + ')' : '') + ',共 ' + state.files.length + ' 个');
    return added;
  }

  /** 拖拽场景:递归展开目录(DataTransferItem.webkitGetAsEntry) */
  function readDropEntries(items, cb) {
    var pdfs = [];
    var pending = 0;

    function walkEntry(entry, prefix) {
      pending++;
      if (entry.isFile) {
        entry.file(function (file) {
          if (isPdf(file.name)) pdfs.push({ file: file, prefix: prefix });
          pending--;
          if (pending === 0) cb(pdfs);
        }, function () { pending--; if (pending === 0) cb(pdfs); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var prefix2 = prefix ? prefix + '/' + entry.name : entry.name;
        var readBatch = function () {
          reader.readEntries(function (entries) {
            if (entries.length === 0) { pending--; if (pending === 0) cb(pdfs); return; }
            pending += entries.length;
            entries.forEach(function (en) { walkEntry(en, prefix2); });
            pending--; if (pending === 0) cb(pdfs);
            readBatch();
          }, function () { pending--; if (pending === 0) cb(pdfs); });
        };
        readBatch();
      } else {
        pending--;
      }
    }

    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) walkEntry(entry, '');
    }
    if (items.length === 0) cb(pdfs);
  }

  /* ---------- 渲染 ---------- */

  function renderList() {
    var wrap = $('#fileList');
    var empty = $('#emptyTip');
    var n = state.files.length;
    empty.style.display = n ? 'none' : 'block';
    $('#fileCount').textContent = n;

    var html = '';
    state.files.forEach(function (it, idx) {
      var badge, extra = '';
      if (it.status === 'pending') badge = '<span class="badge b-wait">等待中</span>';
      else if (it.status === 'running') badge = '<span class="badge b-run"><i class="spin"></i>压缩中</span>';
      else if (it.status === 'done') {
        badge = '<span class="badge b-ok">完成</span>';
        var routeTag = it.route === 'photo' ? '📷 照片型·重采样' : (it.route === 'text' ? '📝 文字型·重编码' : '');
        if (it.savedPct === null) {
          extra = '<span class="sub">已优化,无压缩空间,保留原文件' + (routeTag ? ' · ' + routeTag : '') + '</span>';
        } else {
          extra = ' <span class="sub ok">→ ' + fmtSize(it.outBytes.length) +
            ' <b>省 ' + it.savedPct + '%</b>' + (routeTag ? ' · ' + routeTag : '') + '</span>';
        }
      } else if (it.status === 'error') {
        badge = '<span class="badge b-err">失败</span>';
        extra = '<span class="sub err">' + esc(it.error) + '</span>';
      }
      html += '<div class="row" data-id="' + it.id + '">' +
        '<div class="idx">' + (idx + 1) + '</div>' +
        '<div class="meta"><div class="fname" title="' + esc(it.relPath) + '">' + esc(it.relPath) + '</div>' +
        '<div class="size">' + fmtSize(it.size) + extra + '</div></div>' +
        badge +
        '<div class="act">' +
        (it.status === 'done' ? '<button class="dl" data-id="' + it.id + '">下载</button>' : '') +
        '<button class="rm" data-id="' + it.id + '" title="移除">×</button>' +
        '</div></div>';
    });
    wrap.innerHTML = html;

    var doneCount = state.files.filter(function (f) { return f.status === 'done'; }).length;
    var total = state.files.length;
    $('#progressWrap').style.display = (state.running && total) ? 'block' : 'none';
    $('#progressText').textContent = '已处理 ' + doneCount + ' / ' + total;
    $('#progressBar').style.width = total ? (doneCount / total * 100) + '%' : '0%';

    var anyDone = doneCount > 0;
    $('#btnZip').disabled = !anyDone || state.running;
    $('#btnStart').disabled = state.running || total === 0;
    $('#btnClear').disabled = state.running || total === 0;
    $('#presetBar').classList.toggle('locked', state.running);
  }

  function updateRow(it) {
    var row = document.querySelector('.row[data-id="' + it.id + '"]');
    if (!row) { renderList(); return; }
    renderList();
  }

  /* ---------- 压缩调度 ---------- */

  function ensureWorker() {
    if (state.worker) return state.worker;
    // 带 sharecode:线上分享链接的资源校验依赖 query/cookie,worker 请求不可丢
    var w;
    try {
      w = new Worker('js/compress.worker.js?v=' + ASSET_VER + '&' + location.search.replace(/^\?/, ''), { type: 'module' });
    } catch (e) {
      dlog('❌ 创建 Worker 失败: ' + e.message);
      throw e;
    }
    dlog('Worker 已创建(module),等待脚本加载…');
    w.onmessage = function (e) {
      var d = e.data;
      if (d.type === 'log') { dlog(d.msg); return; }
      if (d.type === 'progress') { dlog('页进度 ' + d.page + '/' + d.total); return; }
      if (d.type === 'status' || d.type === 'stage') { dlog('状态:' + (d.stage || '')); return; }
      var it = state.files.find(function (f) { return f.id === d.id; });
      if (d.type === 'done') {
        if (!it) return;
        var out = new Uint8Array(d.bytes);
        it.outBytes = out;
        it.route = d.route; // photo=照片型(渲染重采样) / text=文字型(gs 重编码)
        // size 可靠(>0)时按 98% 阈值判断;size 不可信(如某些环境构造的 File)时信任压缩输出
        if (it.size === 0 || out.length < it.size * 0.98) {
          var base = it.name.replace(/\.pdf$/i, '');
          it.outName = base + '_compressed.pdf';
          it.savedPct = Math.round((1 - out.length / it.size) * 100);
        } else {
          it.outName = it.name;
          it.outBytes = null; // 无收益,保留原文件
          it.savedPct = null;
        }
        it.status = 'done';
        dlog('✅ 完成 ' + it.name + ': ' + fmtSize(it.size) + ' → ' +
             (it.outBytes ? fmtSize(it.outBytes.length) : '无收益保留原文件') +
             (it.savedPct !== null ? ' 省 ' + it.savedPct + '%' : '') + ' route=' + it.route);
        updateRow(it);
        pump();
      } else if (d.type === 'error') {
        if (!it) return;
        it.status = 'error';
        it.error = friendlyError(d.message);
        dlog('❌ 失败 ' + (it ? it.name : '') + ': ' + d.message);
        updateRow(it);
        pump();
      }
    };
    w.onerror = function (e) {
      var detail = 'message=' + (e.message || '(空)') +
        ' file=' + (e.filename || '(空)') +
        ' line=' + (e.lineno || '0') + ':' + (e.colno || '0') +
        (e.error ? ' err=' + (e.error.message || String(e.error)) : ' err=(无)');
      dlog('❌ Worker 异常: ' + detail);
      state.files.forEach(function (f) {
        if (f.status === 'pending' || f.status === 'running') { f.status = 'error'; f.error = 'Worker 异常: ' + (e.message || '未知'); }
      });
      state.running = false;
      renderList();
    };
    state.worker = w;
    return w;
  }

  function friendlyError(msg) {
    if (/password|encrypt/i.test(msg)) return '加密 PDF,请先去除密码再压缩';
    if (/Invalid|damaged|repair/i.test(msg)) return '文件损坏或不是有效 PDF';
    return msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
  }

  function pump() {
    if (!state.running) return;
    var next = state.files.find(function (f) { return f.status === 'pending'; });
    if (!next) {
      state.running = false;
      renderList();
      toast('全部处理完成,共 ' + state.files.length + ' 个文件');
      return;
    }
    next.status = 'running';
    updateRow(next);
    dlog('▶ 开始压缩 ' + next.name + ' (' + fmtSize(next.size) + ', 档位=' + state.preset + ')');
    var reader = new FileReader();
    reader.onload = function () {
      ensureWorker().postMessage({ type: 'compress', id: next.id, bytes: reader.result, preset: state.preset });
    };
    reader.onerror = function () {
      next.status = 'error';
      next.error = '读取文件失败';
      updateRow(next);
      pump();
    };
    reader.readAsArrayBuffer(next.file);
  }

  /* ---------- 示例文件(客户端生成,便于首次体验与快速自测) ---------- */

  function makeSamplePdf() {
    if (!window.PDFLib) { toast('示例库未加载'); return Promise.resolve(null); }
    var W = 2400, H = 3400; // 手机拍照典型像素(约 800 万),模拟真实拍照作业

    // 每页内容不同(真实多页文档不会页页相同)
    var PAGES = [
      {
        title: '期中作业 · 第一部分',
        lines: [
          '姓名:张同学    班级:计算机 2 班    学号:2026001',
          '一、单选题(每题 2 分,共 20 分)',
          '1. 计算机存储容量的基本单位是(  )。',
          '2. 下列属于输入设备的是(  )。',
          '3. 局域网的英文缩写是(  )。',
          '4. 一个字节等于(  )个二进制位。',
          '二、判断题(每题 1 分,共 10 分)',
          '1. CPU 是计算机的核心部件。(  )',
          '2. RAM 断电后数据不会丢失。(  )',
        ],
      },
      {
        title: '期中作业 · 第二部分',
        lines: [
          '三、填空题(每空 1 分,共 10 分)',
          '1. 计算机硬件系统由______、______、______、______、______组成。',
          '2. 常见的操作系统有______、______、______。',
          '四、简答题(每题 5 分,共 20 分)',
          '1. 简述计算机的工作原理。',
          '2. 说明计算机病毒的主要特征及防范措施。',
          '3. 列举三种常见的网络拓扑结构并说明优缺点。',
          '4. 简述信息技术的五个基本环节。',
        ],
      },
    ];

    function drawPage(spec) {
      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      var ctx = c.getContext('2d');
      // 纸张底色 + 不均匀光照(拍照件的关键特征,也是体积大头)
      var g = ctx.createLinearGradient(0, 0, W * 0.9, H * 0.7);
      g.addColorStop(0, '#fdfcf9');
      g.addColorStop(0.45, '#f6f3ec');
      g.addColorStop(1, '#e8e2d5');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // 纸张纤维纹理 + 拍摄噪点(真实照片有,纯色文档没有)
      for (var n = 0; n < 26000; n++) {
        var a = 0.03 + Math.random() * 0.10;
        ctx.fillStyle = 'rgba(' + (110 + Math.random() * 60 | 0) + ',' + (105 + Math.random() * 55 | 0) + ',95,' + a + ')';
        var sz = Math.random() < 0.85 ? 2 : 4;
        ctx.fillRect(Math.random() * W, Math.random() * H, sz, sz);
      }
      // 四周暗角(手机拍摄常见)
      var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.62);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(70,60,45,0.16)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
      // 文字
      ctx.fillStyle = '#151515';
      ctx.font = 'bold 116px "Microsoft YaHei", sans-serif';
      ctx.fillText(spec.title, 170, 330);
      ctx.font = '64px "Microsoft YaHei", sans-serif';
      for (var r = 0; r < spec.lines.length; r++) ctx.fillText(spec.lines[r], 170, 520 + r * 100);
      // 手写答题痕迹
      ctx.strokeStyle = 'rgba(30,40,90,.8)';
      ctx.lineWidth = 4;
      for (var k = 0; k < 22; k++) {
        ctx.beginPath();
        ctx.moveTo(200 + Math.random() * 100, 1500 + k * 80);
        ctx.lineTo(900 + Math.random() * 1100, 1500 + k * 80 + (Math.random() - .5) * 14);
        ctx.stroke();
      }
      // 高质量 JPEG(接近手机直出的 0.95)
      return dataUrlToBytes(c.toDataURL('image/jpeg', 0.95));
    }

    return window.PDFLib.PDFDocument.create().then(function (doc) {
      var chain = Promise.resolve();
      PAGES.forEach(function (spec) {
        chain = chain.then(function () {
          return doc.embedJpg(drawPage(spec)).then(function (img) {
            var page = doc.addPage([595.28, 841.89]);
            page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
          });
        });
      });
      return chain.then(function () {
        return doc.save().then(function (bytes) {
          return new File([bytes], '示例文件_zcagent.pdf', { type: 'application/pdf' });
        });
      });
    });
  }

  function dataUrlToBytes(dataUrl) {
    var b64 = dataUrl.split(',')[1];
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }


  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  function downloadOne(id) {
    var it = state.files.find(function (f) { return f.id === id; });
    if (!it || it.status !== 'done') return;
    var src = it.outBytes ? new Blob([it.outBytes], { type: 'application/pdf' }) : it.file;
    downloadBlob(src, it.outName);
  }

  function downloadZip() {
    var dones = state.files.filter(function (f) { return f.status === 'done'; });
    if (!dones.length) return;
    var btn = $('#btnZip');
    btn.disabled = true;
    btn.textContent = '打包中…';
    dlog('开始打包 ZIP,共 ' + dones.length + ' 个文件');
    var zip = new JSZip();
    var used = {};
    dones.forEach(function (it) {
      var path = it.relPath.replace(/\.pdf$/i, '') + '_compressed.pdf';
      var data = it.outBytes || null;
      if (data) {
        // zip 内路径去重
        var p = path, i = 1;
        while (used[p]) { p = path.replace(/(_compressed\.pdf)$/, '_' + (++i) + '$1'); }
        used[p] = true;
        zip.file(p, data, { binary: true });
      } else {
        // 无压缩收益,放原文件
        var p2 = it.relPath, j = 1;
        while (used[p2]) { p2 = it.relPath.replace(/(\.pdf)$/, '_' + (++j) + '$1'); }
        used[p2] = true;
        zip.file(p2, it.file, { binary: true });
      }
    });
    zip.generateAsync({ type: 'blob', compression: 'STORE' }).then(function (blob) {
      var ts = new Date();
      var pad = function (x) { return (x < 10 ? '0' : '') + x; };
      var stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '_' +
        pad(ts.getHours()) + pad(ts.getMinutes());
      downloadBlob(blob, 'compressed_' + stamp + '.zip');
      btn.textContent = '下载全部 (ZIP)';
      btn.disabled = false;
      dlog('ZIP 打包完成 ' + (blob.size / 1048576).toFixed(2) + 'MB,文件名 compressed_' + stamp + '.zip');
      toast('ZIP 打包完成');
    }, function (err) {
      btn.textContent = '下载全部 (ZIP)';
      btn.disabled = false;
      dlog('❌ ZIP 打包失败: ' + err);
      toast('打包失败:' + err);
    });
  }

  /* ---------- toast ---------- */

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    // 文件选择
    $('#filePicker').addEventListener('change', function () {
      addFiles(this.files, '');
      renderList();
      this.value = '';
    });
    // 文件夹选择
    $('#dirPicker').addEventListener('change', function () {
      var n = addFiles(this.files, '');
      if (n === 0) toast('该文件夹下没有 PDF 文件');
      renderList();
      this.value = '';
    });
    // 拖拽
    var dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) {
      var items = e.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        readDropEntries(items, function (pdfs) {
          var list = pdfs.map(function (p) { return p.file; });
          // 拖拽的文件带回前缀信息:重新构造 relPath
          pdfs.forEach(function (p) {
            state.files.push({
              id: 'f' + (++state.seq),
              file: p.file,
              name: p.file.name,
              relPath: p.prefix ? p.prefix + '/' + p.file.name : p.file.name,
              size: p.file.size,
              status: 'pending', outBytes: null, outName: null, error: null, savedPct: null,
            });
          });
          if (!pdfs.length) toast('没有拖入 PDF 文件');
          renderList();
        });
      } else {
        var n = addFiles(e.dataTransfer.files, '');
        if (!n) toast('没有拖入 PDF 文件');
        renderList();
      }
    });

    // 档位
    $$('#presetBar .pill').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (state.running) return;
        state.preset = btn.dataset.preset;
        $$('#presetBar .pill').forEach(function (b) { b.classList.toggle('on', b === btn); });
        $('#presetHint').textContent = PRESETS[state.preset].hint;
      });
    });

    // 开始压缩
    $('#btnStart').addEventListener('click', function () {
      if (state.running) return;
      var pend = state.files.some(function (f) { return f.status === 'pending'; });
      if (!pend) { toast('没有待压缩的文件'); return; }
      state.running = true;
      renderList();
      pump();
    });

    // ZIP
    $('#btnZip').addEventListener('click', downloadZip);

    // 清空
    $('#btnClear').addEventListener('click', function () {
      if (state.running) return;
      state.files = [];
      renderList();
    });

    // 列表按钮(事件委托)
    $('#fileList').addEventListener('click', function (e) {
      var dl = e.target.closest('.dl');
      var rm = e.target.closest('.rm');
      if (dl) downloadOne(dl.dataset.id);
      if (rm) {
        if (state.running) return;
        state.files = state.files.filter(function (f) { return f.id !== rm.dataset.id; });
        renderList();
      }
    });
    // 试用示例
    var btnSample = $('#btnSample');
    if (btnSample) {
      btnSample.addEventListener('click', function () {
        if (state.running) return;
        dlog('生成示例 PDF...');
        makeSamplePdf().then(function (f) {
          if (!f) return;
          addFiles([f], '');
          renderList();
          dlog('示例 PDF 已生成 ' + fmtSize(f.size) + ',点击「开始压缩」体验');
          toast('示例已生成,点击开始压缩');
        }).catch(function (e) { dlog('示例生成失败: ' + e.message); });
      });
    }

    // 调试面板
    var btnDbg = $('#btnDebug');
    if (btnDbg) {
      btnDbg.addEventListener('click', function () {
        var p = document.getElementById('debugPanel');
        showDebug(p.hidden);
      });
    }
    var btnCopy = $('#btnCopyLog');
    if (btnCopy) {
      btnCopy.addEventListener('click', function () {
        try {
          navigator.clipboard.writeText(logLines.join('\n'));
          toast('日志已复制');
        } catch (e) { toast('复制失败,请手动选择'); }
      });
    }
    var btnClose = $('#btnCloseDebug');
    if (btnClose) btnClose.addEventListener('click', function () { showDebug(false); });
  }

  /* ---------- 启动 ---------- */

  bind();
  renderList();
  if (DEBUG) showDebug(true);
  dlog('页面就绪 · debug=' + DEBUG + ' · ' + navigator.userAgent.slice(0, 70));
})();
