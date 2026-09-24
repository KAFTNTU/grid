(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    source: $('sourceInput'), file: $('fileInput'), parse: $('parseBtn'), example: $('exampleBtn'), clear: $('clearBtn'),
    status: $('parseStatus'), modelStatus: $('modelStatus'), mode: $('coordinateMode'), robust: $('robustMode'), sigma: $('sigmaInput'),
    width: $('widthInput'), height: $('heightInput'), depth: $('depthInput'), plot3d: $('plot3d'), residualPlot: $('residualPlot'),
    parsed: $('statParsed'), used: $('statUsed'), rmse: $('statRmse'), max: $('statMax'), r2: $('statR2'), modelText: $('modelText'),
    body: $('resultBody'), csv: $('downloadCsvBtn'), matlab: $('downloadMatlabBtn')
  };
  const state = { source: '', points: [], result: null, sourceName: 'points' };

  function setStatus(message, type) {
    els.status.textContent = message;
    els.status.className = 'status' + (type ? ' ' + type : '');
  }
  function setModelStatus(message, type) {
    els.modelStatus.textContent = message;
    els.modelStatus.className = 'status' + (type ? ' ' + type : '');
  }
  function number(value) {
    if (value == null || value === '') return NaN;
    const n = Number(String(value).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  function median(values) {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function mean(values) {
    const a = values.filter(Number.isFinite);
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  }
  function decodeSignedDigits(payload) {
    const text = String(payload || '').trim();
    const sign = text.startsWith('-') ? -1 : 1;
    const digits = text.replace(/^[+-]/, '').replace(/[^0-9]/g, '');
    return digits ? sign * Number(digits) : NaN;
  }
  function decodeDistance(payload, unit) {
    const raw = decodeSignedDigits(payload);
    if (!Number.isFinite(raw)) return NaN;
    if (unit === '0' || unit === '1') return raw / 1000;
    if (unit === '6' || unit === '7') return raw / 10000;
    if (unit === '8') return raw / 100000;
    return raw / 10000;
  }
  function decodeAngle(payload, unit) {
    const raw = decodeSignedDigits(payload);
    if (!Number.isFinite(raw)) return NaN;
    if (unit === '2') return raw / 100000 * 0.9;
    if (unit === '3') return raw / 100000;
    if (unit === '4') {
      const sign = raw < 0 ? -1 : 1, value = Math.abs(raw);
      return sign * (Math.floor(value / 10000) + Math.floor(value / 100) % 100 / 60 + value % 100 / 3600);
    }
    return raw / 100000;
  }
  function normalizePointId(value, fallback) {
    const clean = String(value || '').replace(/^[-+]/, '').replace(/^0+/, '');
    return clean || String(fallback);
  }

  function parseGsi(text) {
    const markers = [...text.matchAll(/[*wW]?11(?<block>\d{4})(?<sign>[+-])(?<id>[0-9A-Za-z]{8,16})/g)];
    if (!markers.length) return [];
    return markers.map((marker, index) => {
      const start = marker.index || 0;
      const end = index + 1 < markers.length ? (markers[index + 1].index || text.length) : text.length;
      const tokens = text.slice(start, end).trim().split(/\s+/);
      const row = { n: index + 1, point: normalizePointId(marker.groups.id, index + 1), block: marker.groups.block, e: NaN, nCoord: NaN, h: NaN, hz: NaN, v: NaN, sd: NaN, source: tokens.join(' ') };
      for (const token of tokens.slice(1)) {
        const match = token.match(/^(\d{2})(.{4})([+-].+)$/);
        if (!match) continue;
        const word = Number(match[1]), info = match[2], payload = match[3], unit = info[3];
        if (word === 21) row.hz = decodeAngle(payload, unit);
        else if (word === 22) row.v = decodeAngle(payload, unit);
        else if (word === 31) row.sd = decodeDistance(payload, unit);
        else if (word === 81) row.e = decodeDistance(payload, unit);
        else if (word === 82) row.nCoord = decodeDistance(payload, unit);
        else if (word === 83) row.h = decodeDistance(payload, unit);
      }
      return row;
    });
  }

  function splitDelimited(line, delimiter) {
    const cells = [];
    let cell = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\"') {
        if (quoted && line[i + 1] === '\"') { cell += '\"'; i++; } else quoted = !quoted;
      } else if (ch === delimiter && !quoted) { cells.push(cell.trim()); cell = ''; } else cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  }
  function parseDelimited(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return [];
    const delimiters = [',', ';', '\t'];
    const delimiter = delimiters.sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
    const first = splitDelimited(lines[0], delimiter);
    const normalized = first.map(v => v.toLowerCase().replace(/[^a-zа-яіїє0-9]/gi, ''));
    const hasHeader = normalized.some(v => /^(e|east|x|n|north|y|h|height|z|coord)/.test(v));
    const headers = hasHeader ? normalized : first.map((_, i) => 'c' + i);
    const find = names => headers.findIndex(h => names.includes(h));
    let ei = find(['e', 'east', 'em', 'x', 'xm', 'coordx', 'xem']);
    let ni = find(['n', 'north', 'nm', 'y', 'ym', 'coordy', 'ynm']);
    let hi = find(['h', 'height', 'hm', 'z', 'zm', 'coordz']);
    if (!hasHeader) [ei, ni, hi] = [1, 2, 3];
    if (ei < 0 || ni < 0 || hi < 0) [ei, ni, hi] = [first.length - 3, first.length - 2, first.length - 1];
    return lines.slice(hasHeader ? 1 : 0).map((line, index) => {
      const cells = splitDelimited(line, delimiter);
      return { n: index + 1, point: cells[0] || String(index + 1), e: number(cells[ei]), nCoord: number(cells[ni]), h: number(cells[hi]), source: line };
    }).filter(p => [p.e, p.nCoord, p.h].every(Number.isFinite));
  }

  function reconstructCoordinates(rows, mode) {
    const coordinateRows = rows.filter(p => [p.e, p.nCoord, p.h].every(Number.isFinite));
    const hasCoordinateData = coordinateRows.some(p => Math.abs(p.e) + Math.abs(p.nCoord) + Math.abs(p.h) > 1e-12);
    const useCoordinates = mode !== 'polar' && hasCoordinateData;
    const polarRows = rows.filter(p => [p.hz, p.v, p.sd].every(Number.isFinite));
    if (mode === 'coordinates' && !useCoordinates) throw new Error('У масиві не знайдено повні координати 81/82/83 або X/Y/Z.');
    if (mode === 'polar' && !polarRows.length) throw new Error('У масиві не знайдено повні поля 21/22/31.');
    const reference = rows.find(p => Number.isFinite(p.h) && Number.isFinite(p.v) && Number.isFinite(p.sd));
    const stationH = reference ? reference.h - reference.sd * Math.sin((reference.v - 270) * Math.PI / 180) : 0;
    return rows.map((p, index) => {
      const fullCoordinates = [p.e, p.nCoord, p.h].every(Number.isFinite) && Math.abs(p.e) + Math.abs(p.nCoord) + Math.abs(p.h) > 1e-12;
      if (useCoordinates && fullCoordinates) return { ...p, point: p.point || String(index + 1) };
      if (![p.hz, p.v, p.sd].every(Number.isFinite)) return null;
      const hz = p.hz * Math.PI / 180, elevation = (p.v - 270) * Math.PI / 180;
      const horizontal = p.sd * Math.cos(elevation);
      return { ...p, point: p.point || String(index + 1), e: horizontal * Math.sin(hz), nCoord: horizontal * Math.cos(hz), h: stationH + p.sd * Math.sin(elevation), reconstructed: true };
    }).filter(Boolean).map((p, index) => ({ ...p, n: index + 1 }));
  }

  function parseSource(text) {
    const looksGsi = /[*wW]?11\d{4}[+-][0-9A-Za-z]{8,16}/.test(text);
    const parsed = looksGsi ? parseGsi(text) : parseDelimited(text);
    if (!parsed.length) throw new Error('Не знайшов точок. Встав GSI або CSV з координатами.');
    const points = reconstructCoordinates(parsed, els.mode.value);
    if (points.length < 6) throw new Error('Для poly22 потрібно щонайменше 6 повних точок, знайдено ' + points.length + '.');
    return points;
  }

  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function solveLinear(matrix, vector) {
    const n = vector.length, a = matrix.map((row, i) => [...row, vector[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      if (Math.abs(a[pivot][col]) < 1e-12) a[pivot][col] += 1e-9;
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const divisor = a[col][col] || 1e-12;
      for (let j = col; j <= n; j++) a[col][j] /= divisor;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = a[row][col];
        for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
      }
    }
    return a.map(row => row[n]);
  }
  function leastSquares(A, z, weights) {
    const p = A[0].length, normal = Array.from({ length: p }, () => Array(p).fill(0)), rhs = Array(p).fill(0);
    for (let i = 0; i < A.length; i++) {
      const w = Math.max(weights ? weights[i] : 1, 1e-7);
      for (let j = 0; j < p; j++) {
        rhs[j] += w * A[i][j] * z[i];
        for (let k = 0; k < p; k++) normal[j][k] += w * A[i][j] * A[i][k];
      }
    }
    const scale = Math.max(...normal.map((row, i) => Math.abs(row[i])), 1);
    for (let i = 0; i < p; i++) normal[i][i] += scale * 1e-12;
    return solveLinear(normal, rhs);
  }
  function design(u, v) { return [u * u, u * v, v * v, u, v, 1]; }
  function predict(coeff, u, v) { return dot(design(u, v), coeff); }

  function fitSurface(points) {
    const xs = points.map(p => p.e), ys = points.map(p => p.nCoord), zs = points.map(p => p.h);
    const cx = mean(xs), cy = mean(ys), cz = mean(zs);
    const sx = Math.max((Math.max(...xs) - Math.min(...xs)) / 2, 1e-9);
    const sy = Math.max((Math.max(...ys) - Math.min(...ys)) / 2, 1e-9);
    const u = xs.map(x => (x - cx) / sx), v = ys.map(y => (y - cy) / sy), z = zs.map(h => h - cz);
    const A = u.map((x, i) => design(x, v[i]));
    let weights = Array(points.length).fill(1);
    let coeff = leastSquares(A, z, weights);
    const robust = els.robust.value === 'bisquare';
    let robustScale = 0;
    if (robust) {
      for (let iteration = 0; iteration < 12; iteration++) {
        const residuals = z.map((value, i) => value - predict(coeff, u[i], v[i]));
        const center = median(residuals);
        const mad = median(residuals.map(r => Math.abs(r - center)));
        robustScale = Math.max(1.4826 * mad, Math.sqrt(mean(residuals.map(r => r * r))), 1e-9);
        const c = 4.685 * robustScale;
        const nextWeights = residuals.map(r => {
          const q = Math.abs((r - center) / c);
          return q < 1 ? (1 - q * q) ** 2 : 1e-7;
        });
        const next = leastSquares(A, z, nextWeights);
        const change = Math.max(...next.map((value, i) => Math.abs(value - coeff[i])));
        coeff = next; weights = nextWeights;
        if (change < 1e-10) break;
      }
    }
    const predictedLocal = z.map((_, i) => predict(coeff, u[i], v[i]));
    const residuals = z.map((value, i) => value - predictedLocal[i]);
    if (!robustScale) {
      const center = median(residuals);
      robustScale = Math.max(1.4826 * median(residuals.map(r => Math.abs(r - center))), Math.sqrt(mean(residuals.map(r => r * r))), 1e-9);
    }
    const sigma = Math.max(number(els.sigma.value) || 2.5, 1);
    const outlierLimit = sigma * robustScale;
    const outliers = residuals.map(r => Math.abs(r) > outlierLimit);
    const sse = residuals.reduce((sum, r) => sum + r * r, 0);
    const rmse = Math.sqrt(sse / Math.max(1, points.length - 6));
    const zMean = mean(z), sst = z.reduce((sum, value) => sum + (value - zMean) ** 2, 0);
    const r2 = sst > 1e-20 ? 1 - sse / sst : 1;
    const adjustedR2 = points.length > 6 ? 1 - (1 - r2) * (points.length - 1) / (points.length - 6) : NaN;
    return {
      points: points.map((p, i) => ({ ...p, predicted: cz + predictedLocal[i], residual: residuals[i], weight: weights[i], outlier: outliers[i] })),
      coeff, cx, cy, cz, sx, sy, sse, rmse, r2, adjustedR2, robustScale, outlierLimit,
      used: weights.filter(w => w > 0.05).length,
      surface: makeSurfaceMesh(coeff, cx, cy, cz, sx, sy),
      nominal: makeNominalMesh()
    };
  }

  function makeSurfaceMesh(coeff, cx, cy, cz, sx, sy) {
    const n = 32, x = [], y = [], z = [];
    for (let i = 0; i < n; i++) {
      const rowX = [], rowY = [], rowZ = [], u = -1 + 2 * i / (n - 1);
      for (let j = 0; j < n; j++) {
        const v = -1 + 2 * j / (n - 1);
        rowX.push(sx * u * 1000);
        rowY.push(sy * v * 1000);
        rowZ.push(predict(coeff, u, v) * 1000);
      }
      x.push(rowX); y.push(rowY); z.push(rowZ);
    }
    return { x, y, z, cx, cy, cz };
  }
  function makeNominalMesh() {
    const width = Math.max(number(els.width.value) || 660, 1);
    const height = Math.max(number(els.height.value) || 765, 1);
    const depth = Math.max(number(els.depth.value) || 0, 0);
    const n = 32, x = [], y = [], z = [];
    for (let i = 0; i < n; i++) {
      const rowX = [], rowY = [], rowZ = [], u = -1 + 2 * i / (n - 1);
      for (let j = 0; j < n; j++) {
        const v = -1 + 2 * j / (n - 1);
        rowX.push(width / 2 * u);
        rowY.push(height / 2 * v);
        rowZ.push(depth * (u * u + v * v - 2 / 3));
      }
      x.push(rowX); y.push(rowY); z.push(rowZ);
    }
    return { x, y, z, width, height, depth };
  }
  function fmt(value, digits) { return Number.isFinite(value) ? value.toFixed(digits == null ? 4 : digits) : '—'; }
  function fmtMm(value) { return Number.isFinite(value) ? value.toFixed(2) + ' мм' : '—'; }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
  }

  function renderResult(result) {
    state.result = result;
    const residualMm = result.points.map(p => p.residual * 1000);
    const maxAbs = Math.max(...residualMm.map(Math.abs));
    els.parsed.textContent = String(result.points.length);
    els.used.textContent = result.used + ' / ' + result.points.length;
    els.rmse.textContent = fmtMm(result.rmse * 1000);
    els.max.textContent = fmtMm(maxAbs);
    els.r2.textContent = fmt(result.r2, 5);
    setModelStatus(result.points.length + ' точок · poly22', 'ok');
    const c = result.coeff;
    const sign = value => value >= 0 ? '+ ' : '− ';
    els.modelText.textContent = [
      'Лінійний least-squares poly22 у локальних координатах:',
      'z = ' + fmt(c[0], 8) + '·u² ' + sign(c[1]) + fmt(Math.abs(c[1]), 8) + '·u·v ' + sign(c[2]) + fmt(Math.abs(c[2]), 8) + '·v²',
      '    ' + sign(c[3]) + fmt(Math.abs(c[3]), 8) + '·u ' + sign(c[4]) + fmt(Math.abs(c[4]), 8) + '·v ' + sign(c[5]) + fmt(Math.abs(c[5]), 8) + ' м',
      'Центр: E/X ' + fmt(result.cx) + ' м; N/Y ' + fmt(result.cy) + ' м; H/Z ' + fmt(result.cz) + ' м',
      'Номінал антени: ' + result.nominal.width + '×' + result.nominal.height + '×' + result.nominal.depth + ' мм',
      'SSE: ' + fmt(result.sse, 8) + ' м² | RMSE: ' + fmtMm(result.rmse * 1000) + ' | R²: ' + fmt(result.r2, 6) + ' | adjusted R²: ' + fmt(result.adjustedR2, 6),
      'Робастний масштаб: ' + fmtMm(result.robustScale * 1000) + ' | поріг викиду: ' + fmtMm(result.outlierLimit * 1000),
      'Залишок = виміряне H/Z − значення поверхні. Червоні рядки перевищують поріг.'
    ].join('\n');
    els.body.innerHTML = result.points.map(p => '<tr class=\"' + (p.outlier ? 'outlier' : '') + '\"><td>' + escapeHtml(p.point) + '</td><td>' + fmt(p.e) + '</td><td>' + fmt(p.nCoord) + '</td><td>' + fmt(p.h) + '</td><td>' + fmt(p.predicted) + '</td><td>' + fmt(p.residual * 1000, 2) + '</td><td>' + (p.outlier ? 'аномалія' : 'у фіті') + '</td></tr>').join('');
    els.csv.disabled = false; els.matlab.disabled = false;
    drawPlots(result);
  }

  function drawPlots(result) {
    if (!window.Plotly) return;
    const all = result.points;
    const centerX = mean(all.map(p => p.e)), centerY = mean(all.map(p => p.nCoord)), centerZ = mean(all.map(p => p.h));
    const pointTrace = {
      type: 'scatter3d', mode: 'markers', name: 'Виміряні точки',
      x: all.map(p => (p.e - centerX) * 1000), y: all.map(p => (p.nCoord - centerY) * 1000), z: all.map(p => (p.h - centerZ) * 1000),
      text: all.map(p => p.point + (p.outlier ? ' · аномалія' : '')),
      customdata: all.map(p => [p.e, p.nCoord, p.h, p.predicted, p.residual * 1000]),
      hovertemplate: '<b>%{text}</b><br>E/X: %{customdata[0]:.5f} м<br>N/Y: %{customdata[1]:.5f} м<br>H/Z: %{customdata[2]:.5f} м<br>Модель: %{customdata[3]:.5f} м<br>Залишок: %{customdata[4]:.2f} мм<extra></extra>',
      marker: { size: 4.5, color: all.map(p => p.residual * 1000), colorscale: 'RdBu', reversescale: true, colorbar: { title: 'мм' }, line: { color: '#fff', width: .4 } }
    };
    const surfaceTrace = {
      type: 'surface', name: 'Апроксимація poly22',
      x: result.surface.x, y: result.surface.y, z: result.surface.z,
      opacity: .56, showscale: false, colorscale: [[0, '#4c91ff'], [1, '#a9d5ff']], hoverinfo: 'skip'
    };
    const nominalTrace = {
      type: 'surface', name: 'Номінальна форма', x: result.nominal.x, y: result.nominal.y, z: result.nominal.z,
      opacity: .18, showscale: false, colorscale: [[0, '#f0a44b'], [1, '#ffd18b']], hoverinfo: 'skip'
    };
    Plotly.react(els.plot3d, [surfaceTrace, nominalTrace, pointTrace], {
      margin: { l: 0, r: 0, t: 8, b: 0 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', showlegend: true,
      legend: { font: { color: '#dce8f3' } },
      scene: { aspectmode: 'data', xaxis: { title: 'E / X, мм', color: '#aebdca' }, yaxis: { title: 'N / Y, мм', color: '#aebdca' }, zaxis: { title: 'H / Z, мм', color: '#aebdca' }, bgcolor: 'rgba(0,0,0,0)', camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } } }
    }, { responsive: true, displaylogo: false });
    Plotly.react(els.residualPlot, [{
      type: 'bar', name: 'Залишок', x: all.map(p => p.point), y: all.map(p => p.residual * 1000),
      marker: { color: all.map(p => p.outlier ? '#ff6875' : '#66b9ff') }, hovertemplate: '%{x}: %{y:.2f} мм<extra></extra>'
    }], {
      margin: { l: 50, r: 15, t: 10, b: 45 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', showlegend: false,
      xaxis: { title: 'Точка', color: '#aebdca', tickangle: -45 }, yaxis: { title: 'Залишок, мм', color: '#aebdca', zeroline: true, zerolinecolor: '#fff' }
    }, { responsive: true, displaylogo: false });
  }

  function exampleData() {
    const lines = ['point,E_m,N_m,H_m'];
    let n = 1;
    for (let row = -4; row <= 4; row++) for (let col = -4; col <= 4; col++) {
      if (row * row + col * col > 16) continue;
      const e = col * .08, north = row * .08;
      const h = .04 * (e / .32) ** 2 + .055 * (north / .32) ** 2 + Math.sin(n * 1.7) * .0008;
      lines.push('P' + n + ',' + e.toFixed(5) + ',' + north.toFixed(5) + ',' + h.toFixed(5)); n++;
    }
    return lines.join('\n');
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function csvExport() {
    const headers = ['point', 'E_m', 'N_m', 'H_m', 'model_H_m', 'residual_mm', 'weight', 'outlier'];
    const rows = state.result.points.map(p => [p.point, p.e, p.nCoord, p.h, p.predicted, p.residual * 1000, p.weight, p.outlier]);
    const quote = value => '\"' + String(value).replaceAll('\"', '\"\"') + '\"';
    download(state.sourceName + '_surface_fit.csv', '\uFEFF' + [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  function matlabExport() {
    const code = '% MATLAB-style reproduction of the browser fit\n' +
      '% Model: z = a*u^2 + b*u*v + c*v^2 + d*u + e*v + f\n' +
      'data = readtable(\'' + state.sourceName + '_surface_fit.csv\');\n' +
      'x = data.E_m; y = data.N_m; z = data.H_m;\n' +
      'cx = mean(x); cy = mean(y); cz = mean(z);\n' +
      'sx = max((max(x)-min(x))/2, eps); sy = max((max(y)-min(y))/2, eps);\n' +
      'u = (x-cx)/sx; v = (y-cy)/sy;\n' +
      'A = [u.^2, u.*v, v.^2, u, v, ones(size(u))];\n' +
      'coef = A\\z; zfit = A*coef; residual = z-zfit;\n' +
      'SSE = sum(residual.^2); RMSE = sqrt(SSE/(height(data)-6));\n' +
      'R2 = 1-SSE/sum((z-mean(z)).^2);\n' +
      'fprintf(\"SSE = %.8g m^2\\nRMSE = %.4f mm\\nR2 = %.6f\\n\",SSE,RMSE*1000,R2);\n';
    download(state.sourceName + '_surface_fit.m', code);
  }
  function calculate() {
    try {
      state.source = els.source.value;
      if (!state.source.trim()) throw new Error('Спочатку встав або відкрий файл.');
      state.points = parseSource(state.source);
      state.result = fitSurface(state.points);
      state.sourceName = (state.sourceName || 'points').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_');
      setStatus(state.points.length + ' точок розібрано', 'ok');
      renderResult(state.result);
    } catch (error) {
      setStatus(error.message || 'Помилка розрахунку', 'error');
      setModelStatus('Немає моделі', 'error');
      els.parsed.textContent = '—'; els.used.textContent = '—'; els.rmse.textContent = '—'; els.max.textContent = '—'; els.r2.textContent = '—';
      els.csv.disabled = true; els.matlab.disabled = true;
    }
  }

  els.file.addEventListener('change', async () => {
    const file = els.file.files && els.file.files[0];
    if (!file) return;
    state.sourceName = file.name;
    els.source.value = await file.text();
    setStatus('Файл: ' + file.name);
  });
  els.parse.addEventListener('click', calculate);
  els.example.addEventListener('click', () => { state.sourceName = 'demo_antenna'; els.source.value = exampleData(); calculate(); });
  els.clear.addEventListener('click', () => { els.source.value = ''; state.points = []; state.result = null; setStatus('Очікує дані'); setModelStatus('Немає моделі'); });
  [els.mode, els.robust, els.sigma].forEach(input => input.addEventListener('change', () => { if (els.source.value.trim()) calculate(); }));
  els.csv.addEventListener('click', csvExport);
  els.matlab.addEventListener('click', matlabExport);
})();
