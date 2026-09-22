(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), overlay: $('overlay'), analysisCanvas: $('analysisCanvas'), cameraFrame: $('cameraFrame'),
    cameraPlaceholder: $('cameraPlaceholder'), calibrationHint: $('calibrationHint'), secureBadge: $('secureBadge'),
    startCameraBtn: $('startCameraBtn'), stopCameraBtn: $('stopCameraBtn'), currentPoint: $('currentPoint'), dockPoint: $('dockPoint'),
    laserStatus: $('laserStatus'), trackingStatus: $('trackingStatus'), rowsInput: $('rowsInput'), colsInput: $('colsInput'),
    rectShapeBtn: $('rectShapeBtn'), ellipseShapeBtn: $('ellipseShapeBtn'), calibrationMode: $('calibrationMode'),
    manualCalibrateBtn: $('manualCalibrateBtn'), arucoBtn: $('arucoBtn'), contourBtn: $('contourBtn'), resetCalibrationBtn: $('resetCalibrationBtn'),
    calibrationHelp: $('calibrationHelp'), laserMode: $('laserMode'), laserThreshold: $('laserThreshold'), thresholdValue: $('thresholdValue'),
    confirmPointBtn: $('confirmPointBtn'), gridCount: $('gridCount'), progressText: $('progressText'), progressBar: $('progressBar'),
    doneCount: $('doneCount'), pendingCount: $('pendingCount'), doneCountDuplicate: $('doneCountDuplicate'), pendingCountDuplicate: $('pendingCountDuplicate'),
    doneList: $('doneList'), pendingList: $('pendingList'), jobName: $('jobName'), exportCsvBtn: $('exportCsvBtn'), clearJournalBtn: $('clearJournalBtn'),
    showLinesInput: $('showLinesInput'), showLabelsInput: $('showLabelsInput'), toast: $('toast')
  };

  const ctx = els.overlay.getContext('2d');
  const aCtx = els.analysisCanvas.getContext('2d', { willReadFrequently: true });

  const state = {
    stream: null,
    running: false,
    shape: localStorage.getItem('tn_shape') || 'rect',
    showLines: loadJSON('tn_show_lines', true),
    showLabels: loadJSON('tn_show_labels', true),
    mode: 'manual',
    calibration: [],
    calibrating: false,
    arucoEnabled: false,
    calibrated: false,
    anchors: [],
    anchorTemplates: [],
    grid: [],
    active: null,
    laser: null,
    journal: loadJSON('tn_journal', []),
    done: new Set(loadJSON('tn_done', [])),
    lastAnalysisAt: 0,
    lastTrackAt: 0,
    toastTimer: null,
    detector: null
  };

  function loadJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function saveState() {
    localStorage.setItem('tn_journal', JSON.stringify(state.journal));
    localStorage.setItem('tn_done', JSON.stringify([...state.done]));
    localStorage.setItem('tn_shape', state.shape);
    localStorage.setItem('tn_show_lines', JSON.stringify(state.showLines));
    localStorage.setItem('tn_show_labels', JSON.stringify(state.showLabels));
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2300);
  }

  function setShape(shape) {
    state.shape = shape;
    els.rectShapeBtn.classList.toggle('active', shape === 'rect');
    els.ellipseShapeBtn.classList.toggle('active', shape === 'ellipse');
    els.calibrationHelp.textContent = shape === 'rect'
      ? 'Для прямокутної антени: лівий верхній → правий верхній → правий нижній → лівий нижній.'
      : 'Для круглої антени: верхня крайня точка → права → нижня → ліва. Усередині будується сітка з горизонтальних і вертикальних ліній, а точки — це перетини в межах кола / еліпса.';
    resetCalibration(false);
    saveState();
  }

  function setSecureBadge() {
    const secure = window.isSecureContext || location.hostname === 'localhost';
    els.secureBadge.textContent = secure ? 'Камера доступна' : 'Потрібен HTTPS';
    els.secureBadge.className = 'badge ' + (secure ? 'ok' : 'error');
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Цей браузер не підтримує доступ до камери.');
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      els.video.srcObject = state.stream;
      await els.video.play();
      await new Promise(resolve => {
        if (els.video.videoWidth) return resolve();
        els.video.onloadedmetadata = () => resolve();
      });
      const vw = els.video.videoWidth || 1280;
      const vh = els.video.videoHeight || 720;
      els.cameraFrame.classList.add('live');
      els.cameraFrame.style.aspectRatio = `${vw} / ${vh}`;
      els.overlay.width = vw;
      els.overlay.height = vh;
      els.analysisCanvas.width = 360;
      els.analysisCanvas.height = Math.max(180, Math.round(360 * vh / vw));
      els.cameraPlaceholder.classList.add('hidden');
      els.startCameraBtn.disabled = true;
      els.stopCameraBtn.disabled = false;
      state.running = true;
      requestAnimationFrame(loop);
    } catch (err) {
      console.error(err);
      toast('Не вдалося відкрити камеру. Перевірте дозвіл і HTTPS.');
    }
  }

  function stopCamera() {
    state.running = false;
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    els.video.srcObject = null;
    els.startCameraBtn.disabled = false;
    els.stopCameraBtn.disabled = true;
    els.cameraPlaceholder.classList.remove('hidden');
    els.cameraFrame.classList.remove('live');
    state.laser = null;
    state.active = null;
    updateStatus();
    draw();
  }

  function canvasPointFromEvent(ev) {
    const r = els.overlay.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * els.overlay.width / r.width,
      y: (ev.clientY - r.top) * els.overlay.height / r.height
    };
  }

  function beginManualCalibration() {
    if (!state.running) return toast('Спочатку увімкніть камеру.');
    state.mode = 'manual';
    state.arucoEnabled = false;
    state.calibration = [];
    state.anchors = [];
    state.anchorTemplates = [];
    state.calibrating = true;
    state.calibrated = false;
    state.grid = [];
    updateCalibrationHint();
    updateUI();
  }

  function updateCalibrationHint() {
    if (!state.calibrating) {
      els.calibrationHint.classList.add('hidden');
      return;
    }
    const n = state.calibration.length;
    const rectNames = ['лівий верхній кут', 'правий верхній кут', 'правий нижній кут', 'лівий нижній кут'];
    const ellipseNames = ['верхню крайню точку', 'праву крайню точку', 'нижню крайню точку', 'ліву крайню точку'];
    const names = state.shape === 'rect' ? rectNames : ellipseNames;
    els.calibrationHint.textContent = `Калібрування ${n + 1}/4: натисніть ${names[n]}.`;
    els.calibrationHint.classList.remove('hidden');
  }

  function finishCalibration(points, source = 'manual') {
    if (!points || points.length !== 4) return;
    state.anchors = points.map(p => ({ x: p.x, y: p.y }));
    state.calibration = state.anchors.map(p => ({ ...p }));
    state.calibrating = false;
    state.calibrated = true;
    state.mode = source;
    els.calibrationHint.classList.add('hidden');
    captureAnchorTemplates();
    rebuildGrid();
    updateUI();
  }

  function resetCalibration(showToast = true) {
    state.calibration = [];
    state.anchors = [];
    state.anchorTemplates = [];
    state.calibrating = false;
    state.calibrated = false;
    state.arucoEnabled = false;
    state.grid = [];
    state.active = null;
    els.calibrationHint.classList.add('hidden');
    if (showToast) toast('Калібрування скинуто.');
    updateUI();
  }

  function getGridSize() {
    return {
      rows: clamp(parseInt(els.rowsInput.value, 10) || 8, 2, 50),
      cols: clamp(parseInt(els.colsInput.value, 10) || 8, 2, 50)
    };
  }

  function rebuildGrid() {
    if (!state.calibrated || state.anchors.length !== 4) {
      state.grid = [];
      updateUI();
      return;
    }

    const { rows, cols } = getGridSize();
    const pts = [];
    let number = 1;

    if (state.shape === 'rect') {
      const [tl, tr, br, bl] = state.anchors;
      for (let r = 0; r < rows; r++) {
        const v = rows === 1 ? 0 : r / (rows - 1);
        for (let c = 0; c < cols; c++) {
          const u = cols === 1 ? 0 : c / (cols - 1);
          const x = bilerp(tl, tr, br, bl, u, v).x;
          const y = bilerp(tl, tr, br, bl, u, v).y;
          pts.push({ id: `P${number++}`, row: r + 1, col: c + 1, x, y, u, v });
        }
      }
    } else {
      const basis = ellipseBasis();
      if (!basis) {
        state.grid = [];
        updateUI();
        return;
      }
      for (let r = 0; r < rows; r++) {
        const ny = rows === 1 ? 0 : -1 + 2 * r / (rows - 1);
        for (let c = 0; c < cols; c++) {
          const nx = cols === 1 ? 0 : -1 + 2 * c / (cols - 1);
          if (nx * nx + ny * ny > 1.0001) continue;
          const p = ellipsePointFromNormalized(nx, ny, basis);
          pts.push({ id: `P${number++}`, row: r + 1, col: c + 1, x: p.x, y: p.y, nx, ny });
        }
      }
    }

    state.grid = pts;
    if (state.active && !state.grid.some(p => p.id === state.active.id)) state.active = null;
    updateUI();
  }

  function bilerp(tl, tr, br, bl, u, v) {
    return {
      x: (1-u)*(1-v)*tl.x + u*(1-v)*tr.x + u*v*br.x + (1-u)*v*bl.x,
      y: (1-u)*(1-v)*tl.y + u*(1-v)*tr.y + u*v*br.y + (1-u)*v*bl.y
    };
  }

  function ellipseBasis() {
    if (state.anchors.length !== 4) return null;
    const [top, right, bottom, left] = state.anchors;
    const center = {
      x: (top.x + right.x + bottom.x + left.x) / 4,
      y: (top.y + right.y + bottom.y + left.y) / 4
    };
    const ax = { x: (right.x - left.x) / 2, y: (right.y - left.y) / 2 };
    const ay = { x: (bottom.x - top.x) / 2, y: (bottom.y - top.y) / 2 };
    return { center, ax, ay };
  }

  function ellipsePointFromNormalized(nx, ny, basis = ellipseBasis()) {
    return {
      x: basis.center.x + nx * basis.ax.x + ny * basis.ay.x,
      y: basis.center.y + nx * basis.ax.y + ny * basis.ay.y
    };
  }

  function captureAnalysisFrame() {
    if (!state.running || !els.video.videoWidth) return null;
    const w = els.analysisCanvas.width;
    const h = els.analysisCanvas.height;
    aCtx.drawImage(els.video, 0, 0, w, h);
    try { return aCtx.getImageData(0, 0, w, h); } catch { return null; }
  }

  function captureAnchorTemplates() {
    const img = captureAnalysisFrame();
    if (!img || !state.anchors.length) return;
    state.anchorTemplates = state.anchors.map(a => makeTemplate(img, videoToAnalysis(a), 4));
  }

  function makeTemplate(img, p, radius) {
    const out = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = clamp(Math.round(p.x + dx), 0, img.width - 1);
        const y = clamp(Math.round(p.y + dy), 0, img.height - 1);
        const i = (y * img.width + x) * 4;
        out.push((img.data[i] * 0.299 + img.data[i+1] * 0.587 + img.data[i+2] * 0.114) | 0);
      }
    }
    return { radius, data: out };
  }

  function videoToAnalysis(p) {
    return { x: p.x * els.analysisCanvas.width / els.overlay.width, y: p.y * els.analysisCanvas.height / els.overlay.height };
  }
  function analysisToVideo(p) {
    return { x: p.x * els.overlay.width / els.analysisCanvas.width, y: p.y * els.overlay.height / els.analysisCanvas.height };
  }

  function trackAnchors(img) {
    if (!state.calibrated || state.mode !== 'manual' || state.anchorTemplates.length !== 4) return;
    const updated = [];
    for (let k = 0; k < 4; k++) {
      const tpl = state.anchorTemplates[k];
      const prev = videoToAnalysis(state.anchors[k]);
      let best = { score: Infinity, x: prev.x, y: prev.y };
      const search = 10;
      for (let sy = -search; sy <= search; sy += 2) {
        for (let sx = -search; sx <= search; sx += 2) {
          const cx = Math.round(prev.x + sx), cy = Math.round(prev.y + sy);
          if (cx < tpl.radius || cy < tpl.radius || cx >= img.width - tpl.radius || cy >= img.height - tpl.radius) continue;
          let score = 0, n = 0;
          for (let dy = -tpl.radius; dy <= tpl.radius; dy++) {
            for (let dx = -tpl.radius; dx <= tpl.radius; dx++) {
              const i = ((cy + dy) * img.width + (cx + dx)) * 4;
              const g = img.data[i] * 0.299 + img.data[i+1] * 0.587 + img.data[i+2] * 0.114;
              score += Math.abs(g - tpl.data[n++]);
            }
          }
          score /= tpl.data.length;
          if (score < best.score) best = { score, x: cx, y: cy };
        }
      }
      const candidate = best.score < 28 ? analysisToVideo(best) : state.anchors[k];
      updated.push({
        x: state.anchors[k].x * 0.65 + candidate.x * 0.35,
        y: state.anchors[k].y * 0.65 + candidate.y * 0.35
      });
    }
    state.anchors = updated;
    rebuildGrid();
  }

  function detectLaser(img) {
    if (!img || !state.calibrated || !state.grid.length) return null;
    const threshold = +els.laserThreshold.value;
    const mode = els.laserMode.value;
    let best = null;
    const step = 2;
    for (let y = 1; y < img.height - 1; y += step) {
      for (let x = 1; x < img.width - 1; x += step) {
        const vpt = analysisToVideo({ x, y });
        if (!insideAntenna(vpt)) continue;
        const i = (y * img.width + x) * 4;
        const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
        const brightScore = Math.max(r, g, b);
        const redScore = r - (g + b) * 0.48;
        const isBright = brightScore >= threshold && (r + g + b) / 3 >= threshold - 18;
        const isRed = r >= Math.max(150, threshold - 20) && r > g * 1.35 && r > b * 1.25 && redScore > 60;
        const ok = mode === 'bright' ? isBright : mode === 'red' ? isRed : (isRed || isBright);
        if (!ok) continue;
        const score = (isRed ? redScore + r : 0) + (isBright ? brightScore * 0.7 : 0);
        if (!best || score > best.score) best = { x, y, score };
      }
    }
    if (!best) return null;

    let sx = 0, sy = 0, sw = 0;
    const rad = 6;
    for (let y = Math.max(0, best.y-rad); y <= Math.min(img.height-1, best.y+rad); y++) {
      for (let x = Math.max(0, best.x-rad); x <= Math.min(img.width-1, best.x+rad); x++) {
        const i = (y * img.width + x) * 4;
        const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
        const lum = Math.max(r,g,b);
        const red = r > g*1.3 && r > b*1.2 ? r : 0;
        const w = Math.max(0, lum - threshold + 25) + red;
        if (w > 0) { sx += x*w; sy += y*w; sw += w; }
      }
    }
    const p = analysisToVideo(sw ? { x: sx/sw, y: sy/sw } : best);
    return { x: p.x, y: p.y, nx: p.x / els.overlay.width, ny: p.y / els.overlay.height };
  }

  function insideAntenna(p) {
    if (state.anchors.length !== 4) return false;
    if (state.shape === 'rect') return pointInPolygon(p, state.anchors);
    const basis = ellipseBasis();
    if (!basis) return false;
    const det = basis.ax.x * basis.ay.y - basis.ax.y * basis.ay.x;
    if (Math.abs(det) < 1e-6) return false;
    const dx = p.x - basis.center.x, dy = p.y - basis.center.y;
    const nx = (dx * basis.ay.y - dy * basis.ay.x) / det;
    const ny = (basis.ax.x * dy - basis.ax.y * dx) / det;
    return nx * nx + ny * ny <= 1.06;
  }

  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      const hit = ((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y + 1e-9) + a.x);
      if (hit) inside = !inside;
    }
    return inside;
  }

  function nearestGridPoint(laser) {
    if (!laser || !state.grid.length) return null;
    let best = null, bestD = Infinity;
    for (const p of state.grid) {
      const dx = p.x - laser.x, dy = p.y - laser.y, d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? { ...best, distance: Math.sqrt(bestD) } : null;
  }

  function enableAruco() {
    if (!state.running) return toast('Спочатку увімкніть камеру.');
    if (!window.AR?.Detector) return toast('ArUco-бібліотека ще не завантажилась або недоступна.');
    state.mode = 'aruco';
    state.arucoEnabled = true;
    state.calibrating = false;
    state.detector ||= new AR.Detector();
    toast(state.shape === 'rect' ? 'ArUco: ID 0→TL, 1→TR, 2→BR, 3→BL.' : 'ArUco: ID 0→верх, 1→право, 2→низ, 3→ліво.');
  }

  function processAruco(img) {
    if (!state.arucoEnabled || !state.detector || !img) return;
    let markers = [];
    try { markers = state.detector.detect(img); } catch { return; }
    const pts = new Array(4);
    for (const m of markers) {
      if (m.id < 0 || m.id > 3) continue;
      const cx = m.corners.reduce((s, p) => s + p.x, 0) / m.corners.length;
      const cy = m.corners.reduce((s, p) => s + p.y, 0) / m.corners.length;
      pts[m.id] = analysisToVideo({ x: cx, y: cy });
    }
    if (pts.every(Boolean)) {
      state.anchors = pts;
      state.calibrated = true;
      state.mode = 'aruco';
      rebuildGrid();
    }
  }

  function autoContour() {
    if (!state.running) return toast('Спочатку увімкніть камеру.');
    const img = captureAnalysisFrame();
    if (!img) return toast('Не вдалося прочитати кадр.');
    const points = [];
    for (let y = 2; y < img.height - 2; y += 2) {
      for (let x = 2; x < img.width - 2; x += 2) {
        const g1 = grayAt(img, x + 1, y) - grayAt(img, x - 1, y);
        const g2 = grayAt(img, x, y + 1) - grayAt(img, x, y - 1);
        const mag = Math.abs(g1) + Math.abs(g2);
        if (mag > 95) points.push({ x, y });
      }
    }
    if (points.length < 60) return toast('Контур не знайдено. Спробуйте ручне калібрування.');
    const xs = points.map(p => p.x).sort((a, b) => a - b);
    const ys = points.map(p => p.y).sort((a, b) => a - b);
    const q = (arr, t) => arr[Math.floor((arr.length - 1) * t)];
    const minX = q(xs, .08), maxX = q(xs, .92), minY = q(ys, .08), maxY = q(ys, .92);
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    const anchors = state.shape === 'rect'
      ? [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
      : [{ x: midX, y: minY }, { x: maxX, y: midY }, { x: midX, y: maxY }, { x: minX, y: midY }];
    finishCalibration(anchors.map(analysisToVideo), 'contour');
    toast('Експериментальний контур знайдено. Перевірте накладання сітки.');
  }

  function grayAt(img, x, y) {
    const i = (y * img.width + x) * 4;
    return img.data[i] * .299 + img.data[i+1] * .587 + img.data[i+2] * .114;
  }

  function confirmActive() {
    if (!state.active || !state.laser) return toast('Немає активної точки.');
    const id = state.active.id;
    if (state.done.has(id)) return toast(`${id} уже була позначена як знята.`);
    const entry = {
      point: id,
      row: state.active.row,
      column: state.active.col,
      time: new Date().toISOString(),
      laser_x_px: round2(state.laser.x),
      laser_y_px: round2(state.laser.y),
      laser_x_norm: round6(state.laser.nx),
      laser_y_norm: round6(state.laser.ny),
      antenna_shape: state.shape === 'ellipse' ? 'circle_ellipse' : 'rectangle',
      confirmation: 'manual'
    };
    state.done.add(id);
    state.journal.push(entry);
    saveState();
    toast(`${id}: точку знято.`);
    updateUI();
  }

  function clearJournal() {
    if (!confirm('Очистити всі позначки «знято» та журнал?')) return;
    state.done.clear();
    state.journal = [];
    saveState();
    updateUI();
    toast('Журнал очищено.');
  }

  function exportCSV() {
    if (!state.journal.length) return toast('Журнал порожній.');
    const headers = ['point', 'row', 'column', 'time', 'laser_x_px', 'laser_y_px', 'laser_x_norm', 'laser_y_norm', 'antenna_shape', 'confirmation'];
    const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const csv = '\uFEFF' + [headers.join(','), ...state.journal.map(r => headers.map(h => esc(r[h])).join(','))].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const name = (els.jobName.value.trim() || 'tacheometer_points').replace(/[^\p{L}\p{N}_-]+/gu, '_');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function draw() {
    const w = els.overlay.width, h = els.overlay.height;
    ctx.clearRect(0, 0, w, h);
    if (!w || !h) return;

    if (state.calibrating) {
      ctx.save();
      ctx.lineWidth = Math.max(2, w / 500);
      ctx.strokeStyle = '#c7d2de';
      ctx.fillStyle = '#c7d2de';
      state.calibration.forEach((p, i) => {
        circle(p.x, p.y, 8, true);
        label(`${i + 1}`, p.x + 11, p.y - 10, '#fff');
      });
      if (state.calibration.length > 1) {
        ctx.beginPath();
        ctx.moveTo(state.calibration[0].x, state.calibration[0].y);
        for (let i = 1; i < state.calibration.length; i++) ctx.lineTo(state.calibration[i].x, state.calibration[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (state.calibrated && state.anchors.length === 4) {
      ctx.save();
      ctx.lineWidth = Math.max(2, w / 650);
      ctx.strokeStyle = 'rgba(220, 226, 235, .95)';
      if (state.shape === 'rect') {
        ctx.beginPath();
        ctx.moveTo(state.anchors[0].x, state.anchors[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(state.anchors[i].x, state.anchors[i].y);
        ctx.closePath();
        ctx.stroke();
      } else {
        drawEllipseBoundary();
      }
      ctx.restore();

      if (state.showLines) drawGridLines();

      const baseR = Math.max(4, Math.min(w, h) / 180);
      for (const p of state.grid) {
        const done = state.done.has(p.id);
        const active = state.active?.id === p.id;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? baseR * 1.65 : baseR, 0, Math.PI * 2);
        ctx.fillStyle = done ? '#4ed28a' : active ? '#ff646e' : '#f4c84a';
        ctx.fill();
        if (active) {
          ctx.lineWidth = Math.max(2, baseR * .35);
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
        if (state.showLabels) label(p.id, p.x + baseR + 3, p.y - baseR - 1, done ? '#b4f5d1' : active ? '#fff' : '#ffea9a');
      }
    }

    if (state.laser) {
      const r = Math.max(10, Math.min(w, h) / 70);
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(2, w / 600);
      ctx.beginPath();
      ctx.arc(state.laser.x, state.laser.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(state.laser.x - r * 1.5, state.laser.y);
      ctx.lineTo(state.laser.x + r * 1.5, state.laser.y);
      ctx.moveTo(state.laser.x, state.laser.y - r * 1.5);
      ctx.lineTo(state.laser.x, state.laser.y + r * 1.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawGridLines() {
    const { rows, cols } = getGridSize();
    ctx.save();
    ctx.strokeStyle = 'rgba(223, 229, 236, .52)';
    ctx.lineWidth = Math.max(1.2, Math.min(els.overlay.width, els.overlay.height) / 800);

    if (state.shape === 'rect') {
      const [tl, tr, br, bl] = state.anchors;
      for (let r = 0; r < rows; r++) {
        const v = rows === 1 ? 0 : r / (rows - 1);
        const a = bilerp(tl, tr, br, bl, 0, v);
        const b = bilerp(tl, tr, br, bl, 1, v);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let c = 0; c < cols; c++) {
        const u = cols === 1 ? 0 : c / (cols - 1);
        const a = bilerp(tl, tr, br, bl, u, 0);
        const b = bilerp(tl, tr, br, bl, u, 1);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    } else {
      const basis = ellipseBasis();
      if (!basis) return;

      for (let r = 0; r < rows; r++) {
        const ny = rows === 1 ? 0 : -1 + 2 * r / (rows - 1);
        const nxSpan = Math.sqrt(Math.max(0, 1 - ny * ny));
        const a = ellipsePointFromNormalized(-nxSpan, ny, basis);
        const b = ellipsePointFromNormalized(nxSpan, ny, basis);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let c = 0; c < cols; c++) {
        const nx = cols === 1 ? 0 : -1 + 2 * c / (cols - 1);
        const nySpan = Math.sqrt(Math.max(0, 1 - nx * nx));
        const a = ellipsePointFromNormalized(nx, -nySpan, basis);
        const b = ellipsePointFromNormalized(nx, nySpan, basis);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  function drawEllipseBoundary() {
    const basis = ellipseBasis();
    if (!basis) return;
    ctx.beginPath();
    for (let i = 0; i <= 80; i++) {
      const t = i / 80 * Math.PI * 2;
      const x = basis.center.x + Math.cos(t) * basis.ax.x + Math.sin(t) * basis.ay.x;
      const y = basis.center.y + Math.cos(t) * basis.ax.y + Math.sin(t) * basis.ay.y;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  function circle(x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    fill ? ctx.fill() : ctx.stroke();
  }

  function label(text, x, y, color) {
    ctx.font = `${Math.max(12, els.overlay.width / 95)}px system-ui,sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function updateStatus() {
    const active = state.active;
    els.currentPoint.textContent = active?.id || '—';
    els.dockPoint.textContent = active?.id || '—';
    els.laserStatus.textContent = state.laser ? 'Лазер знайдено' : 'Лазер не знайдено';
    els.laserStatus.className = 'pill ' + (state.laser ? 'success' : 'warn');
    els.trackingStatus.textContent = state.calibrated
      ? (state.mode === 'aruco' ? 'ArUco прив’язка' : state.mode === 'contour' ? 'Контур прив’язаний' : 'Сітка прив’язана')
      : 'Сітка не прив’язана';
    els.trackingStatus.className = 'pill ' + (state.calibrated ? 'success' : '');
    els.confirmPointBtn.disabled = !active || !state.laser || state.done.has(active.id);
    els.confirmPointBtn.textContent = active && state.done.has(active.id) ? 'Уже знято' : 'Точку знято';
  }

  function updateUI() {
    const doneInGrid = state.grid.filter(p => state.done.has(p.id));
    const pending = state.grid.filter(p => !state.done.has(p.id));
    els.gridCount.textContent = `${state.grid.length} точок`;
    els.doneCount.textContent = doneInGrid.length;
    els.pendingCount.textContent = pending.length;
    if (els.doneCountDuplicate) els.doneCountDuplicate.textContent = doneInGrid.length;
    if (els.pendingCountDuplicate) els.pendingCountDuplicate.textContent = pending.length;
    els.progressText.textContent = `${doneInGrid.length} / ${state.grid.length}`;
    els.progressBar.style.width = state.grid.length ? `${doneInGrid.length / state.grid.length * 100}%` : '0%';
    els.doneList.innerHTML = doneInGrid.length ? doneInGrid.map(p => `<span class="point-chip done">${p.id}</span>`).join('') : 'Ще немає';
    els.doneList.classList.toggle('empty', !doneInGrid.length);
    els.pendingList.innerHTML = pending.length ? pending.map(p => `<span class="point-chip">${p.id}</span>`).join('') : 'Усі точки знято';
    els.pendingList.classList.toggle('empty', !pending.length);
    updateStatus();
    draw();
  }

  function loop(ts) {
    if (!state.running) return;
    if (ts - state.lastAnalysisAt > 110) {
      state.lastAnalysisAt = ts;
      const img = captureAnalysisFrame();
      if (img) {
        if (state.arucoEnabled) processAruco(img);
        if (ts - state.lastTrackAt > 360) {
          state.lastTrackAt = ts;
          trackAnchors(img);
        }
        state.laser = detectLaser(img);
        state.active = nearestGridPoint(state.laser);
        updateStatus();
        draw();
      }
    }
    requestAnimationFrame(loop);
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function round2(v) { return Math.round(v * 100) / 100; }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  els.overlay.addEventListener('pointerup', ev => {
    if (!state.calibrating) return;
    ev.preventDefault();
    const p = canvasPointFromEvent(ev);
    state.calibration.push(p);
    if (state.calibration.length === 4) finishCalibration(state.calibration, 'manual');
    else updateCalibrationHint();
    draw();
  });

  els.startCameraBtn.addEventListener('click', startCamera);
  els.stopCameraBtn.addEventListener('click', stopCamera);
  els.rectShapeBtn.addEventListener('click', () => setShape('rect'));
  els.ellipseShapeBtn.addEventListener('click', () => setShape('ellipse'));
  els.manualCalibrateBtn.addEventListener('click', beginManualCalibration);
  els.arucoBtn.addEventListener('click', enableAruco);
  els.contourBtn.addEventListener('click', autoContour);
  els.resetCalibrationBtn.addEventListener('click', () => resetCalibration(true));
  els.rowsInput.addEventListener('change', rebuildGrid);
  els.colsInput.addEventListener('change', rebuildGrid);
  els.laserThreshold.addEventListener('input', () => els.thresholdValue.textContent = els.laserThreshold.value);
  els.confirmPointBtn.addEventListener('click', confirmActive);
  els.exportCsvBtn.addEventListener('click', exportCSV);
  els.clearJournalBtn.addEventListener('click', clearJournal);
  els.showLinesInput?.addEventListener('change', () => { state.showLines = !!els.showLinesInput.checked; saveState(); draw(); });
  els.showLabelsInput?.addEventListener('change', () => { state.showLabels = !!els.showLabelsInput.checked; saveState(); draw(); });

  setSecureBadge();
  els.showLinesInput.checked = !!state.showLines;
  els.showLabelsInput.checked = !!state.showLabels;
  setShape(state.shape);
  els.thresholdValue.textContent = els.laserThreshold.value;
  updateUI();

  if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
