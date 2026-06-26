const CSV_NAME = 'dados_simulados_jaguareguava.csv';

// Station metadata
const STATIONS = {
  P1: {
    label: 'Estação de Confluência Itapanhaú',
    desc: '<span class="tag tag-confluencia">Confluência</span> Ponto de encontro com o Rio Itapanhaú · monitoramento da cunha salina e dinâmica estuarina',
    colorClass: 'active-p1',
    accent: '#a78bfa'
  },
  P2: {
    label: 'Estação de Interferência Antrópica',
    desc: '<span class="tag tag-antropica">Antrópica</span> Seção de captação da adutora regional · avaliação de impacto sobre vazão ecológica mínima',
    colorClass: 'active-p2',
    accent: '#f0855a'
  },
  P3: {
    label: 'Estação de Referência Natural',
    desc: '<span class="tag tag-referencia">Referência</span> Trecho preservado de Mata Atlântica · linha de base hidroquímica sem pressão antrópica direta',
    colorClass: 'active-p3',
    accent: '#3ecf8e'
  }
};

let ALL = {}, CHARTS = {}, currentStation = 'P1';

function fmt(v, d = 2) { return v != null && v !== '' ? (+v).toFixed(d) : '–'; }

function getStationData(rawData, station) {
  // If CSV has a 'estacao' or 'station' column, filter by it.
  // Otherwise, simulate station differences by applying offsets.
  const offsets = {
    P1: { vazao_m3s: 0,    salinidade_psu: 0,    nivel_m: 0,    od_mgL: 0,    temperatura_C: 0 },
    P2: { vazao_m3s: -0.3, salinidade_psu: -0.5, nivel_m: -0.1, od_mgL: -0.8, temperatura_C: 0.4 },
    P3: { vazao_m3s: 0.15, salinidade_psu: -1.2, nivel_m: 0.05, od_mgL: 0.6,  temperatura_C: -0.3 }
  };

  const hasStationCol = rawData.length > 0 && ('estacao' in rawData[0] || 'station' in rawData[0]);

  if (hasStationCol) {
    const key = 'estacao' in rawData[0] ? 'estacao' : 'station';
    const filtered = rawData.filter(r => r[key] === station);
    return filtered.length > 0 ? filtered : rawData; // fallback to all if no match
  }

  // Apply simulated offsets per station
  const off = offsets[station];
  return rawData.map(r => {
    const row = { ...r };
    for (const [field, delta] of Object.entries(off)) {
      if (row[field] != null && row[field] !== '') {
        row[field] = String(Math.max(0, +row[field] + delta));
      }
    }
    return row;
  });
}

function makeChart(canvasId, rows, field, yLabel, accentColor) {
  const obsRows  = rows.filter(r => r.tipo === 'observado');
  const prevRows = rows.filter(r => r.tipo === 'previsto');

  if (obsRows.length && prevRows.length) {
    prevRows.unshift(obsRows[obsRows.length - 1]);
  }

  const allLabels = rows.map(r => r.timestamp.slice(5, 16));
  const obsMap = {}, prevMap = {};
  obsRows.forEach(r  => obsMap[r.timestamp.slice(5,16)]  = +r[field]);
  prevRows.forEach(r => prevMap[r.timestamp.slice(5,16)] = +r[field]);

  const obsVals  = allLabels.map(l => obsMap[l]  !== undefined ? obsMap[l]  : null);
  const prevVals = allLabels.map(l => prevMap[l] !== undefined ? prevMap[l] : null);

  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (CHARTS[canvasId]) CHARTS[canvasId].destroy();

  CHARTS[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: allLabels,
      datasets: [
        {
          label: 'Observado',
          data: obsVals,
          borderColor: accentColor || '#a78bfa',
          borderWidth: 1.6,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
          backgroundColor: (accentColor || '#a78bfa') + '12',
          spanGaps: false
        },
        {
          label: 'Previsto',
          data: prevVals,
          borderColor: '#f0855a',
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          spanGaps: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: canvasId === 'ch-temp' ? 4 : 2.2,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0e1620',
          borderColor: '#1e2f42',
          borderWidth: 1,
          titleColor: '#5e7d99',
          bodyColor: '#ddeaf5',
          padding: 10,
          titleFont: { family: "'IBM Plex Mono', monospace", size: 11 },
          bodyFont:  { family: "'IBM Plex Mono', monospace", size: 11 },
          filter: item => item.raw !== null,
          callbacks: {
            label: item => ` ${item.dataset.label}: ${fmt(item.raw)} ${yLabel}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#5e7d99', maxTicksLimit: 8, maxRotation: 0, font: { family: "'IBM Plex Mono', monospace", size: 10 } },
          grid:  { color: 'rgba(255,255,255,.03)' },
          border:{ color: '#1e2f42' }
        },
        y: {
          ticks: { color: '#5e7d99', font: { family: "'IBM Plex Mono', monospace", size: 10 } },
          grid:  { color: 'rgba(255,255,255,.04)' },
          border:{ color: '#1e2f42' }
        }
      }
    }
  });
}

// ── MODELO PREDITIVO: Regressão Linear (OLS) sobre janela recente ──
// Projeta 12 h à frente usando os últimos N pontos observados.
// Captura tendência linear + componente periódica (seno 12.4 h = M2).
const PRED_H   = 12;   // horas à frente
const FIT_WIN  = 48;   // pontos usados para ajustar o modelo

function linRegPredict(obsRows, field, nFuture) {
  // usa os últimos FIT_WIN pontos observados
  const src = obsRows.slice(-FIT_WIN);
  const n   = src.length;
  if (n < 4) return [];

  // regressores: [1, t, sin(2π t/12.4), cos(2π t/12.4)]
  // t em horas relativas ao último ponto
  const T = 12.4;
  const lastTs = new Date(src[src.length - 1].timestamp.replace(' ', 'T')).getTime();

  function regressors(tH) {
    const ang = 2 * Math.PI * tH / T;
    return [1, tH, Math.sin(ang), Math.cos(ang)];
  }

  // montar matriz X e vetor Y
  const X = [], Y = [];
  src.forEach(r => {
    const tH = (new Date(r.timestamp.replace(' ', 'T')).getTime() - lastTs) / 3600000;
    X.push(regressors(tH));
    Y.push(+r[field]);
  });

  // OLS normal equations: β = (X'X)^{-1} X'Y  (4×4 system)
  const k = 4;
  // X'X
  const XtX = Array.from({length:k}, () => new Array(k).fill(0));
  const XtY = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      XtY[a] += X[i][a] * Y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }

  // Gauss-Jordan inversion of XtX
  const aug = XtX.map((row, i) => {
    const r = [...row, ...new Array(k).fill(0)];
    r[k + i] = 1;
    return r;
  });
  for (let col = 0; col < k; col++) {
    let maxR = col;
    for (let r = col+1; r < k; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[maxR][col])) maxR = r;
    [aug[col], aug[maxR]] = [aug[maxR], aug[col]];
    const piv = aug[col][col];
    if (Math.abs(piv) < 1e-12) return [];
    for (let j = 0; j < 2*k; j++) aug[col][j] /= piv;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      for (let j = 0; j < 2*k; j++) aug[r][j] -= f * aug[col][j];
    }
  }
  const inv = aug.map(r => r.slice(k));
  // β = inv * XtY
  const beta = new Array(k).fill(0);
  for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) beta[a] += inv[a][b] * XtY[b];

  // gerar previsões para t = 1..nFuture (horas após último obs)
  const preds = [];
  const lastDate = new Date(src[src.length-1].timestamp.replace(' ', 'T'));
  for (let h = 1; h <= nFuture; h++) {
    const reg = regressors(h);
    let val = 0;
    for (let a = 0; a < k; a++) val += beta[a] * reg[a];
    const ts = new Date(lastDate.getTime() + h * 3600000);
    const pad = n => String(n).padStart(2,'0');
    const tsStr = `${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
    preds.push({ timestamp: tsStr, [field]: String(Math.max(0, val)), tipo: 'previsto' });
  }
  return preds;
}

function buildRows(stationRows, win) {
  const obsAll  = stationRows.filter(r => r.tipo === 'observado');
  const fields  = ['vazao_m3s','salinidade_psu','nivel_m','od_mgL','temperatura_C'];

  // gerar previsões por regressão linear para cada campo
  const predRows = {};
  fields.forEach(f => {
    const preds = linRegPredict(obsAll, f, PRED_H);
    preds.forEach(p => {
      const key = p.timestamp;
      if (!predRows[key]) predRows[key] = { timestamp: key, tipo: 'previsto' };
      predRows[key][f] = p[f];
    });
  });

  const predArr = Object.values(predRows);
  const combined = [...obsAll.slice(-win), ...predArr];
  return combined;
}

function render(win) {
  const rawRows = ALL.raw || [];
  if (!rawRows.length) return;

  const stationRows = getStationData(rawRows, currentStation);
  const accent = STATIONS[currentStation].accent;

  // KPIs: último observado
  const last = [...stationRows].filter(r => r.tipo === 'observado').slice(-1)[0];
  if (last) {
    document.getElementById('k-vazao').textContent = fmt(last.vazao_m3s);
    document.getElementById('k-sal').textContent   = fmt(last.salinidade_psu);
    document.getElementById('k-nivel').textContent = fmt(last.nivel_m);
    document.getElementById('k-od').textContent    = fmt(last.od_mgL);
    document.getElementById('k-temp').textContent  = fmt(last.temperatura_C, 1);
  }

  // construir séries obs + previsão do modelo
  const rows = buildRows(stationRows, win);

  if (rows.length) {
    document.getElementById('tsRange').textContent =
      `${rows[0].timestamp.slice(5,16)} → ${rows[rows.length-1].timestamp.slice(5,16)} (+${PRED_H}h prev.)`;
  }

  makeChart('ch-vazao', rows, 'vazao_m3s',      'm³/s', accent);
  makeChart('ch-sal',   rows, 'salinidade_psu', 'PSU',  accent);
  makeChart('ch-nivel', rows, 'nivel_m',        'm',    accent);
  makeChart('ch-od',    rows, 'od_mgL',         'mg/L', accent);
  makeChart('ch-temp',  rows, 'temperatura_C',  '°C',   accent);
}

function switchStation(st) {
  if (!STATIONS[st]) return;
  currentStation = st;

  // Update tabs
  document.querySelectorAll('.station-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.st === st);
  });

  // Update station desc
  document.getElementById('stationDesc').innerHTML = STATIONS[st].desc;

  // Update KPI accent
  const kpis = document.querySelectorAll('.kpi');
  kpis.forEach(k => {
    k.classList.remove('active-p1', 'active-p2', 'active-p3');
    k.classList.add(STATIONS[st].colorClass);
  });

  // Re-render charts
  if (ALL.raw) render(+document.getElementById('winRange').value);
}

function init(data) {
  ALL.raw = data;
  document.getElementById('uploadScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  render(+document.getElementById('winRange').value);
}

function parseCSV(txt) {
  Papa.parse(txt, {
    header: true, skipEmptyLines: true,
    complete: r => init(r.data),
    error: () => alert('Erro ao processar o CSV.')
  });
}

// Event listeners
document.getElementById('winRange').addEventListener('input', e => {
  const v = +e.target.value;
  document.getElementById('rangeVal').textContent = v + ' h';
  if (ALL.raw) render(v);
});

document.getElementById('varSel').addEventListener('change', e => {
  const v = e.target.value;
  const ids = ['c-vazao','c-sal','c-nivel','c-od','c-temp'];
  const map  = { vazao:'c-vazao', sal:'c-sal', nivel:'c-nivel', od:'c-od', temp:'c-temp' };
  if (v === 'all') {
    ids.forEach(id => {
      const el = document.getElementById(id);
      el.style.display = 'block';
      el.style.gridColumn = id === 'c-temp' ? 'span 2' : '';
    });
  } else {
    ids.forEach(id => document.getElementById(id).style.display = 'none');
    const el = document.getElementById(map[v]);
    el.style.display = 'block';
    el.style.gridColumn = 'span 2';
  }
  if (ALL.raw) render(+document.getElementById('winRange').value);
});

document.querySelectorAll('.station-tab').forEach(tab => {
  tab.addEventListener('click', () => switchStation(tab.dataset.st));
});

document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => parseCSV(ev.target.result);
  r.readAsText(f);
});

// Auto-load if served via HTTP
fetch(CSV_NAME)
  .then(r => { if (!r.ok) throw 0; return r.text(); })
  .then(parseCSV)
  .catch(() => {});
