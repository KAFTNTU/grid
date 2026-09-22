(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), overlay: $('overlay'), analysisCanvas: $('analysisCanvas'), cameraFrame: $('cameraFrame'),
    cameraPlaceholder: $('cameraPlaceholder'), calibrationHint: $('calibrationHint'), secureBadge: $('secureBadge'),
    startCameraBtn: $('startCameraBtn'), stopCameraBtn: $('stopCameraBtn'), currentPoint: $('currentPoint'), dockPoint: $('dockPoint'),
    laserStatus: $('laserStatus'), trackingStatus: $('trackingStatus'), rowsInput: $('rowsInput'), colsInput: $('colsInput'),
    addFigureBtn: $('addFigureBtn'), shapeMenu: $('shapeMenu'), rectShapeBtn: $('rectShapeBtn'), circleShapeBtn: $('circleShapeBtn'), ellipseShapeBtn: $('ellipseShapeBtn'), figureLockInput: $('figureLockInput'), antennaColorInput: $('antennaColorInput'), resetCalibrationBtn: $('resetCalibrationBtn'),
    calibrationHelp: $('calibrationHelp'), laserMode: $('laserMode'), laserThreshold: $('laserThreshold'), thresholdValue: $('thresholdValue'),
    confirmPointBtn: $('confirmPointBtn'), gridCount: $('gridCount'), progressText: $('progressText'), progressBar: $('progressBar'),
    doneCount: $('doneCount'), pendingCount: $('pendingCount'), doneCountDuplicate: $('doneCountDuplicate'), pendingCountDuplicate: $('pendingCountDuplicate'),
    doneList: $('doneList'), pendingList: $('pendingList'), jobName: $('jobName'), exportCsvBtn: $('exportCsvBtn'), clearJournalBtn: $('clearJournalBtn'),
    showLinesInput: $('showLinesInput'), showLabelsInput: $('showLabelsInput'), toast: $('toast'),
    trackingStatus: $('trackingStatus'), trackingMethod: $('trackingMethod'), antennaColorStatus: $('antennaColorStatus'), trackingHud: document.querySelector('.tracking-hud')
  };

  const ctx = els.overlay.getContext('2d');
  const aCtx = els.analysisCanvas.getContext('2d', { willReadFrequently: true });

  const state = {
    stream: null,
    running: false,
    shape: localStorage.getItem('tn_shape') || 'circle',
    showLines: loadJSON('tn_show_lines', true),
    showLabels: loadJSON('tn_show_labels', true),
    mode: 'manual',
    calibration: [],
    calibrating: false,
    calibrated: false,
    figureLocked: false,
    figure: null,
    anchors: [],
    anchorTemplates: [],
    grid: [],
    active: null,
    activeSeenAt: 0,
    laser: null,
    journal: loadJSON('tn_journal', []),
    done: new Set(loadJSON('tn_done', [])),
    lastAnalysisAt: 0,
    lastTrackAt: 0,
    lastContourAt: 0,
    toastTimer: null,
    pointerEdit: null,
    cvPrevGray: null,
    cvPrevPoints: null,
    cvFeatureMode: false,
    trackingPoints: [],
    trackingMode: 'Очікування',
    trackingConfidence: 0,
    antennaColor: null,
    kalman: null
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

  function saveCalibration() {
    if (!state.figureLocked || state.anchors.length !== 4 || !els.overlay.width || !els.overlay.height) return;
    const p = shapeParams(state.anchors);
    localStorage.setItem('tn_calibration', JSON.stringify({
      shape: state.shape,
      params: {
        cx: p.cx / els.overlay.width,
        cy: p.cy / els.overlay.height,
        rx: p.rx / els.overlay.width,
        ry: p.ry / els.overlay.height
      },
      colorEnabled: !!els.antennaColorInput?.checked,
      color: state.antennaColor
    }));
  }

  function clearSavedCalibration() {
    localStorage.removeItem('tn_calibration');
  }

  function restoreCalibration() {
    const saved = loadJSON('tn_calibration', null);
    if (!saved || saved.shape !== state.shape || !saved.params || !els.overlay.width || !els.overlay.height) return false;
    const p = {
      cx: saved.params.cx * els.overlay.width,
      cy: saved.params.cy * els.overlay.height,
      rx: saved.params.rx * els.overlay.width,
      ry: saved.params.ry * els.overlay.height
    };
    if (!Object.values(p).every(Number.isFinite) || p.rx < 12 || p.ry < 12) return false;
    state.figure = { ...p };
    state.anchors = anchorsFromParams(p);
    state.calibration = state.anchors.map(point => ({ ...point }));
    state.calibrating = false;
    state.calibrated = true;
    state.figureLocked = true;
    state.mode = 'manual';
    state.antennaColor = saved.color || null;
    if (els.antennaColorInput) els.antennaColorInput.checked = !!saved.colorEnabled;
    initKalman(state.anchors);
    if (els.figureLockInput) els.figureLockInput.checked = true;
    els.calibrationHint.classList.add('hidden');
    rebuildGrid();
    return true;
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
    els.circleShapeBtn.classList.toggle('active', shape === 'circle');
    els.ellipseShapeBtn.classList.toggle('active', shape === 'ellipse');
    els.calibrationHelp.textContent = shape === 'rect'
      ? 'Перетягни прямокутник на антену, потягни маркер у куті для зміни розміру й постав галочку.'
      : shape === 'circle'
        ? 'Перетягни коло на антену, потягни маркер для рівномірного розміру й постав галочку.'
        : 'Перетягни еліпс на антену, потягни маркер у куті для зміни розміру й постав галочку.';
    resetCalibration(false);
    els.shapeMenu.classList.add('hidden');
    els.addFigureBtn.setAttribute('aria-expanded', 'false');
    saveState();
  }

  function setSecureBadge() {
    const secure = window.isSecureContext || location.hostname === 'localhost';
    if (els.secureBadge) {
      els.secureBadge.textContent = secure ? 'Камера доступна' : 'Потрібен HTTPS';
      els.secureBadge.className = 'badge ' + (secure ? 'ok' : 'error');
    }
  }

  function cameraErrorMessage(err) {
    switch (err?.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Доступ до камери заборонений. Натисніть замок біля адреси → Камера → Дозволити, потім оновіть сторінку.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Камеру не знайдено. Перевірте, чи підключена вебкамера до ПК.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Камера зайнята іншою програмою. Закрийте Teams, Zoom, OBS або іншу вкладку.';
      case 'SecurityError':
        return 'Браузер заблокував камеру. Відкрийте сайт через HTTPS і дозвольте доступ.';
      case 'OverconstrainedError':
        return 'Камера не підтримує вибраний режим. Спробуйте іншу вебкамеру.';
      default:
        return `Не вдалося відкрити камеру${err?.name ? ` (${err.name})` : ''}. Перевірте дозвіл браузера.`;
    }
  }

  async function requestCameraStream() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const preferred = {
      video: isMobile
        ? { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    };

    try {
      return await navigator.mediaDevices.getUserMedia(preferred);
    } catch (firstError) {
      // Some desktop cameras reject resolution/facing-mode hints. Retry with
      // the browser's default camera instead of failing the whole startup.
      if (firstError?.name === 'NotAllowedError' || firstError?.name === 'SecurityError' || firstError?.name === 'NotReadableError') {
        throw firstError;
      }
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Цей браузер не підтримує доступ до камери.');
      return;
    }
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      toast('Камера працює тільки через HTTPS. Відкрийте адресу з https:// і дозвольте доступ.');
      return;
    }
    try {
      state.stream = await requestCameraStream();
      els.video.srcObject = state.stream;
      await els.video.play();
      await new Promise((resolve, reject) => {
        if (els.video.videoWidth) return resolve();
        const timer = setTimeout(() => reject(new Error('VIDEO_METADATA_TIMEOUT')), 6000);
        els.video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
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
      els.addFigureBtn.disabled = false;
      els.figureLockInput.disabled = !state.figure;
      els.startCameraBtn.disabled = true;
      els.stopCameraBtn.disabled = false;
      state.running = true;
      if (restoreCalibration()) captureAnchorTemplates();
      updateUI();
      requestAnimationFrame(loop);
    } catch (err) {
      if (state.stream) state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
      els.video.srcObject = null;
      toast(err?.message === 'VIDEO_METADATA_TIMEOUT' ? 'Камера не передала відео. Перевірте підключення вебкамери.' : cameraErrorMessage(err));
    }
  }

  function stopCamera() {
    state.running = false;
    releaseCvTracking();
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    els.video.srcObject = null;
    els.startCameraBtn.disabled = false;
    els.stopCameraBtn.disabled = true;
    els.cameraPlaceholder.classList.remove('hidden');
    els.cameraFrame.classList.remove('live');
    els.figureLockInput.disabled = !state.figure;
    els.figureLockInput.checked = state.figureLocked;
    els.addFigureBtn.disabled = true;
    els.shapeMenu.classList.add('hidden');
    els.addFigureBtn.setAttribute('aria-expanded', 'false');
    state.anchorTemplates = [];
    state.kalman = null;
    state.laser = null;
    state.active = null;
    state.activeSeenAt = 0;
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

  function updateCalibrationHint() {
    if (!state.running || state.figureLocked) {
      els.calibrationHint.classList.add('hidden');
      return;
    }
    els.calibrationHint.textContent = 'Перетягни фігуру на антену та зафіксуй її галочкою.';
    els.calibrationHint.classList.remove('hidden');
  }

  function ensureFigure() {
    if (state.figure || !els.overlay.width || !els.overlay.height) return;
    state.figure = {
      cx: els.overlay.width * .5,
      cy: els.overlay.height * .5,
      rx: els.overlay.width * .32,
      ry: els.overlay.height * .32
    };
    if (state.shape === 'circle') state.figure.ry = state.figure.rx = Math.min(state.figure.rx, state.figure.ry);
  }

  function toggleFigureMenu() {
    if (!state.running) return toast('Спочатку увімкніть камеру.');
    if (state.figureLocked) resetCalibration(false);
    const opened = els.shapeMenu.classList.toggle('hidden') === false;
    els.addFigureBtn.setAttribute('aria-expanded', String(opened));
  }

  function figureAnchors() {
    const f = state.figure;
    if (!f) return [];
    if (state.shape === 'rect') {
      return [
        { x: f.cx - f.rx, y: f.cy - f.ry },
        { x: f.cx + f.rx, y: f.cy - f.ry },
        { x: f.cx + f.rx, y: f.cy + f.ry },
        { x: f.cx - f.rx, y: f.cy + f.ry }
      ];
    }
    if (state.shape === 'circle') {
      const r = (f.rx + f.ry) / 2;
      f.rx = f.ry = r;
    }
    return [
      { x: f.cx, y: f.cy - f.ry },
      { x: f.cx + f.rx, y: f.cy },
      { x: f.cx, y: f.cy + f.ry },
      { x: f.cx - f.rx, y: f.cy }
    ];
  }

  function lockFigure(locked) {
    if (locked) {
      if (!state.running) {
        els.figureLockInput.checked = false;
        return toast('Спочатку увімкніть камеру.');
      }
      ensureFigure();
      const lockedAnchors = figureAnchors();
      if (!validAnchors(lockedAnchors)) {
        els.figureLockInput.checked = false;
        return toast('Не вдалося зафіксувати фігуру. Перемістіть її на камері й спробуйте ще раз.');
      }
      state.anchors = lockedAnchors;
      state.calibration = state.anchors.map(p => ({ ...p }));
      state.calibrating = false;
      state.calibrated = true;
      state.figureLocked = true;
      state.mode = 'manual';
      const frame = captureAnalysisFrame();
      state.antennaColor = frame ? captureAntennaColor(frame) : null;
      initKalman(state.anchors);
      els.calibrationHint.classList.add('hidden');
      captureAnchorTemplates();
      const lockedGrid = buildGridPoints(state.anchors);
      if (lockedGrid.length) state.grid = lockedGrid;
      rebuildGrid();
      saveCalibration();
      toast('Фігуру зафіксовано. Сітка стежить за антеною.');
    } else {
      state.figureLocked = false;
      state.calibrated = false;
      state.anchors = [];
      state.calibration = [];
      state.anchorTemplates = [];
      state.kalman = null;
      state.grid = [];
      state.active = null;
      state.activeSeenAt = 0;
      state.antennaColor = null;
      clearSavedCalibration();
      updateCalibrationHint();
      updateUI();
    }
  }

  function resetCalibration(showToast = true) {
    releaseCvTracking();
    state.calibration = [];
    state.anchors = [];
    state.anchorTemplates = [];
    state.kalman = null;
    state.calibrating = false;
    state.calibrated = false;
    state.figureLocked = false;
    state.figure = null;
    state.grid = [];
    state.active = null;
    state.activeSeenAt = 0;
    state.trackingPoints = [];
    state.trackingMode = 'Очікування';
    state.trackingConfidence = 0;
    state.antennaColor = null;
    clearSavedCalibration();
    if (els.figureLockInput) els.figureLockInput.checked = false;
    els.calibrationHint.classList.add('hidden');
    ensureFigure();
    if (els.figureLockInput) els.figureLockInput.disabled = !state.figure;
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
    if (!state.calibrated) {
      state.grid = [];
      updateUI();
      return;
    }
    if (!validAnchors(state.anchors)) return;

    const nextGrid = buildGridPoints(state.anchors);
    // A bad tracking frame must not erase the last valid grid.
    if (!nextGrid.length) return;
    state.grid = nextGrid;
    if (state.active && !state.grid.some(p => p.id === state.active.id)) state.active = null;
    updateUI();
  }

  function buildGridPoints(anchors) {
    if (!validAnchors(anchors)) return [];

    const { rows, cols } = getGridSize();
    const pts = [];
    let number = 1;

    if (state.shape === 'rect') {
      const [tl, tr, br, bl] = anchors;
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
      const basis = ellipseBasis(anchors);
      if (!basis) {
        return [];
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
    return pts;
  }

  function validAnchors(anchors) {
    return Array.isArray(anchors) && anchors.length === 4
      && anchors.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  function bilerp(tl, tr, br, bl, u, v) {
    return {
      x: (1-u)*(1-v)*tl.x + u*(1-v)*tr.x + u*v*br.x + (1-u)*v*bl.x,
      y: (1-u)*(1-v)*tl.y + u*(1-v)*tr.y + u*v*br.y + (1-u)*v*bl.y
    };
  }

  function ellipseBasis(anchors = state.anchors) {
    if (anchors.length !== 4) return null;
    const [top, right, bottom, left] = anchors;
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

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return { h, s: max ? d / max : 0, v: max };
  }

  function colorToHex(r, g, b) {
    return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  }

  function captureAntennaColor(img) {
    if (!els.antennaColorInput?.checked || !img || !validAnchors(state.anchors)) return null;
    const rs = [], gs = [], bs = [];
    const step = Math.max(2, Math.round(Math.min(img.width, img.height) / 120));
    for (let y = 0; y < img.height; y += step) {
      for (let x = 0; x < img.width; x += step) {
        if (!insideAntenna(analysisToVideo({ x, y }))) continue;
        const i = (y * img.width + x) * 4;
        rs.push(img.data[i]); gs.push(img.data[i + 1]); bs.push(img.data[i + 2]);
      }
    }
    if (rs.length < 20) return null;
    const r = median(rs), g = median(gs), b = median(bs);
    return { r, g, b, ...rgbToHsv(r, g, b), hex: colorToHex(r, g, b), samples: rs.length };
  }

  function colorSimilarityAt(img, x, y) {
    const profile = state.antennaColor;
    if (!profile) return .5;
    const radius = 3;
    let r = 0, g = 0, b = 0, count = 0;
    for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(img.height - 1, Math.ceil(y + radius)); yy++) {
      for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(img.width - 1, Math.ceil(x + radius)); xx++) {
        const i = (yy * img.width + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; count++;
      }
    }
    if (!count) return 0;
    const hsv = rgbToHsv(r / count, g / count, b / count);
    const hueDistance = Math.min(Math.abs(hsv.h - profile.h), 1 - Math.abs(hsv.h - profile.h));
    if (profile.s > .18 && hsv.s < profile.s * .35) return .05;
    const hueScore = 1 - clamp(hueDistance / .22, 0, 1);
    const satScore = 1 - clamp(Math.abs(hsv.s - profile.s) / .55, 0, 1);
    const valueScore = 1 - clamp(Math.abs(hsv.v - profile.v) / .7, 0, 1);
    return hueScore * .5 + satScore * .3 + valueScore * .2;
  }

  function captureAnchorTemplates() {
    const img = captureAnalysisFrame();
    if (!img || !state.anchors.length) return;
    state.anchorTemplates = state.anchors.map(a => makeTemplate(img, videoToAnalysis(a), 4));
    initializeCvTracking(img);
  }

  function cvReady() {
    const opencv = window.cv;
    return !!(opencv && opencv.Mat && opencv.calcOpticalFlowPyrLK && opencv.goodFeaturesToTrack && opencv.cvtColor);
  }

  function imageDataToGray(img) {
    const rgba = new cv.Mat(img.height, img.width, cv.CV_8UC4);
    rgba.data.set(img.data);
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    rgba.delete();
    return gray;
  }

  function releaseCvTracking() {
    state.cvPrevGray?.delete();
    state.cvPrevPoints?.delete();
    state.cvPrevGray = null;
    state.cvPrevPoints = null;
    state.cvFeatureMode = false;
    state.trackingMode = state.calibrated ? 'Повторне захоплення' : 'Очікування';
    state.trackingConfidence = 0;
  }

  function initializeCvTracking(img) {
    if (!cvReady() || !img || state.anchors.length !== 4) return false;
    releaseCvTracking();
    state.cvPrevGray = imageDataToGray(img);
    const corners = new cv.Mat();
    const points = [];
    try {
      cv.goodFeaturesToTrack(state.cvPrevGray, corners, 80, 0.01, 8);
      const values = corners.data32F;
      for (let i = 0; i < corners.rows; i++) {
        const p = analysisToVideo({ x: values[i * 2], y: values[i * 2 + 1] });
        if (insideAntenna(p)) points.push({ x: values[i * 2], y: values[i * 2 + 1] });
      }
    } finally {
      corners.delete();
    }
    if (points.length < 6) {
      points.length = 0;
      state.anchors.forEach(p => {
        const a = videoToAnalysis(p);
        points.push({ x: a.x, y: a.y });
      });
    }
    state.cvFeatureMode = points.length > 4;
    const flat = points.flatMap(p => [p.x, p.y]);
    state.cvPrevPoints = cv.matFromArray(points.length, 1, cv.CV_32FC2, flat);
    state.trackingPoints = points.map(analysisToVideo);
    state.trackingMode = 'OpenCV: контрольні ознаки';
    state.trackingConfidence = clamp(points.length / 12, 0, 1);
    return true;
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
    if (!state.calibrated || state.mode !== 'manual' || state.anchorTemplates.length !== 4) {
      state.trackingMode = state.calibrated ? 'Очікування трекера' : 'Очікування фіксації';
      state.trackingConfidence = 0;
      return;
    }
    if (cvReady() && trackAnchorsWithOpenCv(img)) return;
    trackAnchorsWithTemplates(img);
  }

  function trackAnchorsWithOpenCv(img) {
    if (!state.cvPrevGray || !state.cvPrevPoints) {
      return initializeCvTracking(img);
    }
    let nextGray = null, nextPoints = null, status = null, error = null;
    try {
      nextGray = imageDataToGray(img);
      nextPoints = new cv.Mat();
      status = new cv.Mat();
      error = new cv.Mat();
      const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
      cv.calcOpticalFlowPyrLK(
        state.cvPrevGray,
        nextGray,
        state.cvPrevPoints,
        nextPoints,
        status,
        error,
        new cv.Size(21, 21),
        3,
        criteria,
        0,
        0.0001
      );
      const values = nextPoints.data32F;
      const prev = state.cvPrevPoints.data32F;
      const matches = [];
      for (let i = 0; i < state.cvPrevPoints.rows; i++) {
        const flowError = error.data32F?.[i] ?? 0;
        if (status.data[i] !== 1 || flowError > 65) continue;
        const px = prev[i * 2], py = prev[i * 2 + 1];
        const nx = values[i * 2], ny = values[i * 2 + 1];
        if (![px, py, nx, ny].every(Number.isFinite)) continue;
        matches.push({ px, py, nx, ny });
      }
      if (matches.length < 4) {
        releaseCvTracking();
        return false;
      }
      const transform = robustSimilarity(matches);
      if (!transform || transform.scale < .72 || transform.scale > 1.38) {
        releaseCvTracking();
        return false;
      }
      const updated = state.anchors.map(p => {
        const a = videoToAnalysis(p);
        return analysisToVideo(applySimilarity(a, transform));
      });
      state.trackingPoints = matches.map(m => analysisToVideo({ x: m.nx, y: m.ny }));
      state.trackingMode = 'OpenCV: optical flow';
      state.trackingConfidence = clamp(matches.length / Math.max(1, state.cvPrevPoints.rows), 0, 1);
      state.anchors = stabilizeAnchors(updated);
      state.cvPrevGray.delete();
      state.cvPrevPoints.delete();
      state.cvPrevGray = nextGray;
      state.cvPrevPoints = nextPoints;
      nextGray = null;
      nextPoints = null;
      rebuildGrid();
      return true;
    } catch (err) {
      releaseCvTracking();
      return false;
    } finally {
      nextGray?.delete();
      nextPoints?.delete();
      status?.delete();
      error?.delete();
    }
  }

  function robustSimilarity(matches) {
    const prevCenter = centroid(matches.map(m => ({ x: m.px, y: m.py })));
    const nextCenter = centroid(matches.map(m => ({ x: m.nx, y: m.ny })));
    const scales = [], angles = [];
    for (const m of matches) {
      const ax = m.px - prevCenter.x, ay = m.py - prevCenter.y;
      const bx = m.nx - nextCenter.x, by = m.ny - nextCenter.y;
      const an = Math.hypot(ax, ay), bn = Math.hypot(bx, by);
      if (an < 2 || bn < 2) continue;
      scales.push(bn / an);
      angles.push(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    }
    if (scales.length < 3) return null;
    const scale = median(scales);
    const angle = median(angles);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return {
      scale,
      angle,
      tx: nextCenter.x - scale * (cos * prevCenter.x - sin * prevCenter.y),
      ty: nextCenter.y - scale * (sin * prevCenter.x + cos * prevCenter.y)
    };
  }

  function applySimilarity(p, t) {
    return {
      x: t.scale * (Math.cos(t.angle) * p.x - Math.sin(t.angle) * p.y) + t.tx,
      y: t.scale * (Math.sin(t.angle) * p.x + Math.cos(t.angle) * p.y) + t.ty
    };
  }

  function centroid(points) {
    return points.reduce((s, p) => ({ x: s.x + p.x / points.length, y: s.y + p.y / points.length }), { x: 0, y: 0 });
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function shapeParams(anchors) {
    const center = centroid(anchors);
    if (state.shape === 'rect') {
      const width = (Math.hypot(anchors[1].x - anchors[0].x, anchors[1].y - anchors[0].y) + Math.hypot(anchors[2].x - anchors[3].x, anchors[2].y - anchors[3].y)) / 2;
      const height = (Math.hypot(anchors[3].x - anchors[0].x, anchors[3].y - anchors[0].y) + Math.hypot(anchors[2].x - anchors[1].x, anchors[2].y - anchors[1].y)) / 2;
      return { cx: center.x, cy: center.y, rx: width / 2, ry: height / 2 };
    }
    let rx = Math.hypot(anchors[1].x - anchors[3].x, anchors[1].y - anchors[3].y) / 2;
    let ry = Math.hypot(anchors[2].x - anchors[0].x, anchors[2].y - anchors[0].y) / 2;
    if (state.shape === 'circle') rx = ry = (rx + ry) / 2;
    return { cx: center.x, cy: center.y, rx, ry };
  }

  function anchorsFromParams(p) {
    if (state.shape === 'rect') {
      return [
        { x: p.cx - p.rx, y: p.cy - p.ry },
        { x: p.cx + p.rx, y: p.cy - p.ry },
        { x: p.cx + p.rx, y: p.cy + p.ry },
        { x: p.cx - p.rx, y: p.cy + p.ry }
      ];
    }
    return [
      { x: p.cx, y: p.cy - p.ry },
      { x: p.cx + p.rx, y: p.cy },
      { x: p.cx, y: p.cy + p.ry },
      { x: p.cx - p.rx, y: p.cy }
    ];
  }

  function initKalman(anchors) {
    const p = shapeParams(anchors);
    state.kalman = {
      ...p,
      vx: 0, vy: 0, vrx: 0, vry: 0,
      variance: { cx: 4, cy: 4, rx: 4, ry: 4 }
    };
  }

  function kalmanAnchors(measured) {
    if (!state.kalman) initKalman(measured);
    const m = shapeParams(measured);
    const next = { ...state.kalman, variance: { ...state.kalman.variance } };
    for (const key of ['cx', 'cy', 'rx', 'ry']) {
      const velocityKey = `v${key}`;
      const prediction = state.kalman[key] + state.kalman[velocityKey];
      const processNoise = key === 'cx' || key === 'cy' ? 1.5 : 0.8;
      const measurementNoise = key === 'rx' || key === 'ry' ? 8 : 5;
      const variance = state.kalman.variance[key] + processNoise;
      const gain = variance / (variance + measurementNoise);
      next[key] = prediction + gain * (m[key] - prediction);
      next[velocityKey] = state.kalman[velocityKey] * .82 + (next[key] - state.kalman[key]) * .18;
      next.variance[key] = (1 - gain) * variance;
    }
    if (state.shape === 'circle') next.rx = next.ry = (next.rx + next.ry) / 2;
    next.rx = Math.max(12, next.rx);
    next.ry = Math.max(12, next.ry);
    state.kalman = next;
    return anchorsFromParams(next);
  }

  function stabilizeAnchors(anchors) {
    return kalmanAnchors(anchors);
  }

  function trackAnchorsWithTemplates(img) {
    const updated = [];
    let matched = 0;
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
      if (best.score < 28) matched++;
      updated.push({
        x: state.anchors[k].x * 0.65 + candidate.x * 0.35,
        y: state.anchors[k].y * 0.65 + candidate.y * 0.35
      });
    }
    state.trackingPoints = updated.map(p => ({ ...p }));
    state.trackingMode = 'Шаблонне стеження';
    state.trackingConfidence = matched / 4;
    state.anchors = stabilizeAnchors(updated);
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

  function refineContourWithOpenCv(img) {
    if (!cvReady() || !state.calibrated || state.anchors.length !== 4) return;
    const current = state.anchors.map(videoToAnalysis);
    const pad = Math.max(12, Math.round(Math.min(img.width, img.height) * .06));
    const x0 = clamp(Math.floor(Math.min(...current.map(p => p.x)) - pad), 0, img.width - 2);
    const y0 = clamp(Math.floor(Math.min(...current.map(p => p.y)) - pad), 0, img.height - 2);
    const x1 = clamp(Math.ceil(Math.max(...current.map(p => p.x)) + pad), x0 + 2, img.width);
    const y1 = clamp(Math.ceil(Math.max(...current.map(p => p.y)) + pad), y0 + 2, img.height);
    const rect = new cv.Rect(x0, y0, x1 - x0, y1 - y0);
    let gray = null, roi = null, blurred = null, edges = null, contours = null, hierarchy = null;
    try {
      gray = imageDataToGray(img);
      roi = gray.roi(rect);
      blurred = new cv.Mat();
      edges = new cv.Mat();
      cv.GaussianBlur(roi, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      cv.Canny(blurred, edges, 42, 110);
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const params = shapeParams(state.anchors);
      const expectedAreaVideo = state.shape === 'rect' ? params.rx * params.ry * 4 : Math.PI * params.rx * params.ry;
      const videoToAnalysisScale = els.analysisCanvas.width / els.overlay.width;
      const expectedArea = expectedAreaVideo * videoToAnalysisScale * videoToAnalysisScale;
      const expectedCenter = centroid(current);
      let best = null;
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = Math.abs(cv.contourArea(contour));
        const perimeter = cv.arcLength(contour, true);
        if (area < expectedArea * .22 || area > expectedArea * 2.8 || perimeter < 20) {
          contour.delete();
          continue;
        }
        const moments = cv.moments(contour, false);
        if (!moments.m00) {
          contour.delete();
          continue;
        }
        const center = { x: moments.m10 / moments.m00 + x0, y: moments.m01 / moments.m00 + y0 };
        const distance = Math.hypot(center.x - expectedCenter.x, center.y - expectedCenter.y);
        const circularity = perimeter ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
        const areaScore = Math.exp(-Math.abs(Math.log(area / expectedArea)));
        const centerScore = Math.exp(-distance / Math.max(18, Math.sqrt(expectedArea) * .8));
        const shapeScore = state.shape === 'circle' ? clamp(circularity / .78, 0, 1) : state.shape === 'ellipse' ? clamp(circularity / .62, 0, 1) : .65;
        const colorScore = state.antennaColor ? colorSimilarityAt(img, center.x, center.y) : .5;
        const score = areaScore * .35 + centerScore * .28 + shapeScore * .17 + colorScore * .20;
        if (!best || score > best.score) {
          best?.contour.delete();
          let fit = null;
          if (contour.rows >= 5) {
            try { fit = cv.fitEllipse(contour); } catch {}
          }
          best = { score, contour, area, center, fit, rect: cv.boundingRect(contour) };
        } else {
          contour.delete();
        }
      }

      if (!best || best.score < .52) return;
      const b = best.rect;
      const bx = b.x + x0, by = b.y + y0;
      let cx = best.fit ? best.fit.center.x + x0 : best.center.x;
      let cy = best.fit ? best.fit.center.y + y0 : best.center.y;
      let rx = best.fit ? best.fit.size.width / 2 : b.width / 2;
      let ry = best.fit ? best.fit.size.height / 2 : b.height / 2;
      if (state.shape === 'circle') rx = ry = (rx + ry) / 2;
      const measured = state.shape === 'rect'
        ? [{ x: bx, y: by }, { x: bx + b.width, y: by }, { x: bx + b.width, y: by + b.height }, { x: bx, y: by + b.height }].map(analysisToVideo)
        : [{ x: cx, y: cy - ry }, { x: cx + rx, y: cy }, { x: cx, y: cy + ry }, { x: cx - rx, y: cy }].map(analysisToVideo);
      state.anchors = stabilizeAnchors(measured);
      initializeCvTracking(img);
      rebuildGrid();
    } catch (err) {
      // A frame without a usable contour is normal while the camera moves.
      // Keep the last stable grid and do not flood the browser console.
    } finally {
      gray?.delete();
      roi?.delete();
      blurred?.delete();
      edges?.delete();
      hierarchy?.delete();
      if (contours) {
        for (let i = 0; i < contours.size(); i++) {
          try { contours.get(i).delete(); } catch {}
        }
        contours.delete();
      }
    }
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
      antenna_shape: state.shape === 'circle' ? 'circle' : state.shape === 'ellipse' ? 'ellipse' : 'rectangle',
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

    if (!state.figureLocked && state.figure) {
      drawEditableFigure();
    }

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

    const displayAnchors = state.calibrated && state.anchors.length === 4
      ? state.anchors
      : state.figure ? figureAnchors() : [];
    const previewGrid = buildGridPoints(displayAnchors);
    const displayGrid = state.grid.length ? state.grid : previewGrid;
    if (state.calibrated && !state.grid.length && previewGrid.length) state.grid = previewGrid;

    if (displayAnchors.length === 4) {
      ctx.save();
      ctx.lineWidth = Math.max(2, w / 650);
      ctx.strokeStyle = 'rgba(220, 226, 235, .95)';
      if (state.shape === 'rect') {
        ctx.beginPath();
        ctx.moveTo(displayAnchors[0].x, displayAnchors[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(displayAnchors[i].x, displayAnchors[i].y);
        ctx.closePath();
        ctx.stroke();
      } else {
        drawEllipseBoundary(displayAnchors);
      }
      ctx.restore();

      if (state.showLines) drawGridLines(displayAnchors);

      const baseR = Math.max(4, Math.min(w, h) / 180);
      for (const p of displayGrid) {
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

    if (state.calibrated && state.trackingPoints.length) {
      ctx.save();
      ctx.fillStyle = '#61d8ff';
      ctx.strokeStyle = 'rgba(0, 30, 48, .8)';
      ctx.lineWidth = 1.5;
      const pointRadius = Math.max(2.5, Math.min(w, h) / 260);
      for (const p of state.trackingPoints) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, pointRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
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

  function drawEditableFigure() {
    const f = state.figure;
    if (!f) return;
    ctx.save();
    ctx.lineWidth = Math.max(3, els.overlay.width / 360);
    ctx.strokeStyle = '#69b7ff';
    ctx.fillStyle = 'rgba(65, 156, 255, .12)';
    ctx.setLineDash([12, 8]);
    if (state.shape === 'rect') {
      ctx.beginPath();
      ctx.rect(f.cx - f.rx, f.cy - f.ry, f.rx * 2, f.ry * 2);
    } else if (state.shape === 'circle') {
      ctx.beginPath();
      const radius = Math.min(f.rx, f.ry);
      ctx.arc(f.cx, f.cy, radius, 0, Math.PI * 2);
    } else {
      ctx.beginPath();
      ctx.ellipse(f.cx, f.cy, f.rx, f.ry, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#69b7ff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(f.cx + f.rx, f.cy + f.ry, Math.max(10, els.overlay.width / 90), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function figureContains(p) {
    if (!state.figure) return false;
    const f = state.figure;
    if (state.shape === 'rect') {
      return Math.abs(p.x - f.cx) <= f.rx && Math.abs(p.y - f.cy) <= f.ry;
    }
    const radius = state.shape === 'circle' ? Math.min(f.rx, f.ry) : null;
    const nx = (p.x - f.cx) / (radius || f.rx);
    const ny = (p.y - f.cy) / (radius || f.ry);
    return nx * nx + ny * ny <= 1;
  }

  function figureHandleHit(p) {
    if (!state.figure) return false;
    const f = state.figure;
    const radius = Math.max(24, Math.min(els.overlay.width, els.overlay.height) / 16);
    return Math.hypot(p.x - (f.cx + f.rx), p.y - (f.cy + f.ry)) <= radius;
  }

  function beginFigureEdit(ev) {
    if (!state.running || state.figureLocked) return;
    ensureFigure();
    const p = canvasPointFromEvent(ev);
    if (!figureHandleHit(p) && !figureContains(p)) return;
    ev.preventDefault();
    els.overlay.setPointerCapture?.(ev.pointerId);
    state.pointerEdit = {
      mode: figureHandleHit(p) ? 'resize' : 'move',
      start: p,
      base: { ...state.figure }
    };
  }

  function moveFigure(ev) {
    if (!state.pointerEdit || state.figureLocked) return;
    ev.preventDefault();
    const p = canvasPointFromEvent(ev);
    const d = { x: p.x - state.pointerEdit.start.x, y: p.y - state.pointerEdit.start.y };
    const base = state.pointerEdit.base;
    const minRadius = Math.max(32, Math.min(els.overlay.width, els.overlay.height) * .04);
    if (state.pointerEdit.mode === 'move') {
      state.figure.cx = clamp(base.cx + d.x, base.rx, els.overlay.width - base.rx);
      state.figure.cy = clamp(base.cy + d.y, base.ry, els.overlay.height - base.ry);
    } else {
      const nextRx = clamp(base.rx + d.x, minRadius, els.overlay.width * .48);
      const nextRy = clamp(base.ry + d.y, minRadius, els.overlay.height * .48);
      if (state.shape === 'circle') {
        const radius = clamp((nextRx + nextRy) / 2, minRadius, Math.min(els.overlay.width, els.overlay.height) * .48);
        state.figure.rx = state.figure.ry = radius;
      } else {
        state.figure.rx = nextRx;
        state.figure.ry = nextRy;
      }
      state.figure.cx = clamp(base.cx, state.figure.rx, els.overlay.width - state.figure.rx);
      state.figure.cy = clamp(base.cy, state.figure.ry, els.overlay.height - state.figure.ry);
    }
    draw();
  }

  function endFigureEdit(ev) {
    if (!state.pointerEdit) return;
    ev?.preventDefault();
    state.pointerEdit = null;
    updateCalibrationHint();
  }

  function drawGridLines(anchors = state.anchors) {
    const { rows, cols } = getGridSize();
    ctx.save();
    ctx.strokeStyle = 'rgba(223, 229, 236, .52)';
    ctx.lineWidth = Math.max(1.2, Math.min(els.overlay.width, els.overlay.height) / 800);

    if (state.shape === 'rect') {
      const [tl, tr, br, bl] = anchors;
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
      const basis = ellipseBasis(anchors);
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

  function drawEllipseBoundary(anchors = state.anchors) {
    const basis = ellipseBasis(anchors);
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
    if (els.laserStatus) {
      els.laserStatus.textContent = state.laser ? 'Лазер знайдено' : 'Лазер не знайдено';
      els.laserStatus.className = 'pill ' + (state.laser ? 'success' : 'warn');
    }
    if (els.trackingStatus) {
      els.trackingStatus.textContent = state.calibrated
        ? `Стеження ${Math.round(state.trackingConfidence * 100)}%`
        : 'Сітка не прив’язана';
      els.trackingStatus.className = 'pill ' + (state.calibrated && state.trackingConfidence > .35 ? 'success' : '');
    }
    if (els.trackingMethod) els.trackingMethod.textContent = `Трекер: ${state.trackingMode}`;
    if (els.antennaColorStatus) {
      els.antennaColorStatus.textContent = state.antennaColor
        ? `Колір антени: ${state.antennaColor.hex}`
        : 'Колір антени: вимкнено';
    }
    if (els.trackingHud) {
      els.trackingHud.classList.toggle('ok', state.calibrated && state.trackingConfidence > .35);
      els.trackingHud.classList.toggle('warn', state.calibrated && state.trackingConfidence <= .35);
      if (state.antennaColor) els.trackingHud.style.setProperty('--antenna-color', state.antennaColor.hex);
    }
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
        if (ts - state.lastTrackAt > 360) {
          state.lastTrackAt = ts;
          trackAnchors(img);
        }
        if (ts - state.lastContourAt > 620) {
          state.lastContourAt = ts;
          refineContourWithOpenCv(img);
        }
        const detectedLaser = detectLaser(img);
        if (detectedLaser) {
          state.laser = detectedLaser;
          const candidate = nearestGridPoint(detectedLaser);
          if (candidate) {
            state.active = candidate;
            state.activeSeenAt = ts;
          }
        } else {
          // The laser detector can miss a frame because of camera exposure or
          // motion. Keep the last selected grid point visible briefly instead
          // of making the UI flicker between a point and an empty state.
          state.laser = null;
          if (!state.active || ts - state.activeSeenAt > 1600) {
            state.active = null;
          }
        }
        updateStatus();
        draw();
      }
    }
    requestAnimationFrame(loop);
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function round2(v) { return Math.round(v * 100) / 100; }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  els.overlay.addEventListener('pointerdown', beginFigureEdit);
  els.overlay.addEventListener('pointermove', moveFigure);
  els.overlay.addEventListener('pointerup', endFigureEdit);
  els.overlay.addEventListener('pointercancel', endFigureEdit);

  els.startCameraBtn.addEventListener('click', startCamera);
  els.stopCameraBtn.addEventListener('click', stopCamera);
  els.addFigureBtn.addEventListener('click', toggleFigureMenu);
  els.rectShapeBtn.addEventListener('click', () => setShape('rect'));
  els.circleShapeBtn.addEventListener('click', () => setShape('circle'));
  els.ellipseShapeBtn.addEventListener('click', () => setShape('ellipse'));
  els.figureLockInput.addEventListener('change', () => lockFigure(els.figureLockInput.checked));
  els.antennaColorInput?.addEventListener('change', () => {
    if (state.figureLocked) {
      const frame = captureAnalysisFrame();
      state.antennaColor = els.antennaColorInput.checked && frame ? captureAntennaColor(frame) : null;
      saveCalibration();
      updateStatus();
    }
  });
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
