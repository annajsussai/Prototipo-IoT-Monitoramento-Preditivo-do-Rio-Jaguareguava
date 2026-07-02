const PARAM_COLORS_BASE = {
  vazao_m3s:      { obs: '#4fa8e8', bg: '#4fa8e810' },
  salinidade_psu: { obs: '#a78bfa', bg: '#a78bfa10' },
  nivel_m:        { obs: '#38bdf8', bg: '#38bdf810' },
  od_mgL:         { obs: '#34d399', bg: '#34d39910' },
  temperatura_C:  { obs: '#f472b6', bg: '#f472b610' },
};

const PALETA = {
  atencao:   { obs: '#eab308', bg: '#eab30812' },
  alerta:    { obs: '#f97316', bg: '#f9731612' },
  emergencia:{ obs: '#ef4444', bg: '#ef444412' },
};

const PARAM_CENARIO = {
  atencao:    { vazao_m3s: 'atencao',    nivel_m: 'atencao',    salinidade_psu: 'atencao' },
  alerta:     { vazao_m3s: 'alerta',     nivel_m: 'alerta',     salinidade_psu: 'alerta',     od_mgL: 'atencao',    temperatura_C: 'atencao' },
  emergencia: { vazao_m3s: 'emergencia', nivel_m: 'emergencia', salinidade_psu: 'emergencia', od_mgL: 'emergencia', temperatura_C: 'alerta' },
};

let cenarioAtivo = null;

function getParamColor(field) {
  if (!cenarioAtivo || cenarioAtivo === 'normal') {
    return PARAM_COLORS_BASE[field] || { obs: '#a78bfa', bg: '#a78bfa10' };
  }
  const mapa = PARAM_CENARIO[cenarioAtivo] || {};
  const nivel = mapa[field];
  if (nivel) return PALETA[nivel];
  return PARAM_COLORS_BASE[field] || { obs: '#a78bfa', bg: '#a78bfa10' };
}

const PREV_COLOR = '#fbbf24';

const STATIONS = {
  P1: {
    desc: '<span class="tag tag-confluencia">Confluência</span> Ponto de encontro com o Rio Itapanhaú · monitoramento da cunha salina e dinâmica estuarina',
  },
  P2: {
    desc: '<span class="tag tag-antropica">Antrópica</span> Seção de captação da adutora regional · avaliação de impacto sobre vazão ecológica mínima',
  },
  P3: {
    desc: '<span class="tag tag-referencia">Referência</span> Trecho preservado de Mata Atlântica · linha de base hidroquímica sem pressão antrópica direta',
  }
};

const LIMITES = {
  od_mgL:    { atencao: 5.0, alerta: 4.3, critico: 3.0 },
  vazao_m3s: { atencao: 1.5, alerta: 1.0, critico: 0.8 },
};

const PRED_H = 12, FIT_WIN = 48;
let ALL_DATA = [], CHARTS = {}, currentStation = 'P1';

function fmt(v, d=2) { return v != null && v !== '' ? (+v).toFixed(d) : '–'; }

function linRegPredict(obsRows, field, nFuture) {
  const src = obsRows.slice(-FIT_WIN);
  const n = src.length;
  if (n < 4) return [];
  const T = 12.4;
  const lastTs = new Date(src[src.length-1].timestamp.replace(' ','T')).getTime();
  const regressors = tH => [1, tH, Math.sin(2*Math.PI*tH/T), Math.cos(2*Math.PI*tH/T)];
  const k = 4, X = [], Y = [];
  src.forEach(r => {
    const tH = (new Date(r.timestamp.replace(' ','T')).getTime() - lastTs) / 3600000;
    X.push(regressors(tH)); Y.push(+r[field]);
  });
  const XtX = Array.from({length:k}, () => new Array(k).fill(0));
  const XtY = new Array(k).fill(0);
  for (let i=0; i<n; i++) for (let a=0; a<k; a++) {
    XtY[a] += X[i][a]*Y[i];
    for (let b=0; b<k; b++) XtX[a][b] += X[i][a]*X[i][b];
  }
  const aug = XtX.map((row,i) => { const r=[...row,...new Array(k).fill(0)]; r[k+i]=1; return r; });
  for (let col=0; col<k; col++) {
    let maxR=col;
    for (let r=col+1; r<k; r++) if (Math.abs(aug[r][col])>Math.abs(aug[maxR][col])) maxR=r;
    [aug[col],aug[maxR]]=[aug[maxR],aug[col]];
    const piv=aug[col][col];
    if (Math.abs(piv)<1e-12) return [];
    for (let j=0; j<2*k; j++) aug[col][j]/=piv;
    for (let r=0; r<k; r++) { if (r===col) continue; const f=aug[r][col]; for (let j=0; j<2*k; j++) aug[r][j]-=f*aug[col][j]; }
  }
  const inv=aug.map(r=>r.slice(k));
  const beta=new Array(k).fill(0);
  for (let a=0; a<k; a++) for (let b=0; b<k; b++) beta[a]+=inv[a][b]*XtY[b];
  const preds=[], lastDate=new Date(src[src.length-1].timestamp.replace(' ','T'));
  for (let h=1; h<=nFuture; h++) {
    const reg=regressors(h); let val=0;
    for (let a=0; a<k; a++) val+=beta[a]*reg[a];
    const ts=new Date(lastDate.getTime()+h*3600000);
    const pad=n=>String(n).padStart(2,'0');
    const tsStr=`${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
    preds.push({timestamp:tsStr,[field]:String(Math.max(0,val)),tipo:'previsto'});
  }
  return preds;
}

function buildRows(stRows, win) {
  const obs = stRows.filter(r => r.tipo==='observado');
  const fields = ['vazao_m3s','salinidade_psu','nivel_m','od_mgL','temperatura_C'];
  const predMap = {};
  fields.forEach(f => {
    linRegPredict(obs, f, PRED_H).forEach(p => {
      if (!predMap[p.timestamp]) predMap[p.timestamp]={timestamp:p.timestamp,tipo:'previsto'};
      predMap[p.timestamp][f]=p[f];
    });
  });
  return [...obs.slice(-win), ...Object.values(predMap)];
}

function isCompactLandscape() {
  return window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
}

function makeChart(canvasId, rows, field, yLabel) {
  const colors = getParamColor(field);
  const obsRows  = rows.filter(r=>r.tipo==='observado');
  const prevRows = rows.filter(r=>r.tipo==='previsto');
  if (obsRows.length && prevRows.length) prevRows.unshift(obsRows[obsRows.length-1]);
  const allLabels = rows.map(r=>r.timestamp.slice(5,16));
  const obsMap={}, prevMap={};
  obsRows.forEach(r=>obsMap[r.timestamp.slice(5,16)]=+r[field]);
  prevRows.forEach(r=>prevMap[r.timestamp.slice(5,16)]=+r[field]);
  const obsVals  = allLabels.map(l=>obsMap[l]  !==undefined?obsMap[l]:null);
  const prevVals = allLabels.map(l=>prevMap[l]!==undefined?prevMap[l]:null);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (CHARTS[canvasId]) CHARTS[canvasId].destroy();
  CHARTS[canvasId] = new Chart(ctx, {
    type:'line',
    data:{
      labels:allLabels,
      datasets:[
        { label:'Observado', data:obsVals, borderColor:colors.obs, borderWidth:1.6, pointRadius:0, tension:0.3, fill:true, backgroundColor:colors.bg, spanGaps:false },
        { label:'Previsto',  data:prevVals, borderColor:PREV_COLOR, borderDash:[5,4], borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, spanGaps:false }
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:true,
      aspectRatio: isCompactLandscape() ? (canvasId==='ch-temp'?6:3.4) : (canvasId==='ch-temp'?4:2.2),
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'#0e1620', borderColor:'#1e2f42', borderWidth:1,
          titleColor:'#5e7090', bodyColor:'#e0e8f4', padding:10,
          titleFont:{family:"'Space Mono',monospace",size:11},
          bodyFont:{family:"'Space Mono',monospace",size:11},
          filter:item=>item.raw!==null,
          callbacks:{ label:item=>` ${item.dataset.label}: ${fmt(item.raw)} ${yLabel}` }
        }
      },
      scales:{
        x:{
          ticks:{color:'#5a7090',maxTicksLimit:8,maxRotation:0,font:{family:"'Space Mono',monospace",size:10}},
          grid:{color:'rgba(255,255,255,.025)'}, border:{color:'#1c2230'}
        },
        y:{
          ticks:{color:'#5a7090',font:{family:"'Space Mono',monospace",size:10}},
          grid:{color:'rgba(255,255,255,.03)'}, border:{color:'#1c2230'}
        }
      }
    }
  });
}

function calcTrend(rows, field) {
  const obs = rows.filter(r=>r.tipo==='observado' && r[field]!=null && r[field]!=='');
  if (obs.length < 6) return null;
  const last  = +obs[obs.length-1][field];
  const prev  = +obs[obs.length-6][field];
  const delta = last - prev;
  return delta;
}

function updateAlerts(stRows) {
  const last = stRows.filter(r=>r.tipo==='observado').slice(-1)[0];
  if (!last) return;
  const od    = +last.od_mgL;
  const vazao = +last.vazao_m3s;

  let status = 'normal';
  document.getElementById('alert-od').style.display    = 'none';
  document.getElementById('alert-vazao').style.display = 'none';

  if (cenarioAtivo && CENARIOS[cenarioAtivo]) {
    status = cenarioAtivo;
    if (status === 'emergencia') document.getElementById('alert-od').style.display = 'flex';
    if (status === 'alerta' || status === 'atencao') {
      if (vazao < LIMITES.vazao_m3s.atencao) document.getElementById('alert-vazao').style.display = 'flex';
    }
  } else if (od < LIMITES.od_mgL.critico || vazao < LIMITES.vazao_m3s.critico) {
    status = 'emergencia';
    document.getElementById('alert-od').style.display = 'flex';
  } else if (od < LIMITES.od_mgL.alerta || vazao < LIMITES.vazao_m3s.alerta) {
    status = 'alerta';
    if (vazao < LIMITES.vazao_m3s.alerta) document.getElementById('alert-vazao').style.display = 'flex';
  } else if (od < LIMITES.od_mgL.atencao || vazao < LIMITES.vazao_m3s.atencao) {
    status = 'atencao';
    if (vazao < LIMITES.vazao_m3s.atencao) document.getElementById('alert-vazao').style.display = 'flex';
  }

  const badge = document.getElementById('badge-status');
  badge.className = 'nivel-badge';
  if (status === 'normal')     { badge.textContent='Normal';     badge.classList.add('nivel-normal'); }
  if (status === 'atencao')    { badge.textContent='Atenção';    badge.classList.add('nivel-atencao'); }
  if (status === 'alerta')     { badge.textContent='Alerta';     badge.classList.add('nivel-alerta'); }
  if (status === 'emergencia') { badge.textContent='Emergência'; badge.classList.add('nivel-emergencia'); }

  const vazaoDot  = document.getElementById('alert-vazao-dot');
  const vazaoText = document.getElementById('alert-vazao-text');
  if (status === 'alerta') {
    vazaoText.textContent = 'Vazão e nível muito baixos';
    vazaoDot.style.background  = '#f97316';
    vazaoText.style.color      = '#f97316';
  } else {
    vazaoText.textContent = 'Vazão em atenção';
    vazaoDot.style.background  = 'var(--alerta-amarelo)';
    vazaoText.style.color      = 'var(--alerta-amarelo)';
  }
}

function render(win) {
  const stRows = ALL_DATA.filter(r=>r.estacao===currentStation);
  if (!stRows.length) return;
  const rows = buildRows(stRows, win);
  const last = stRows.filter(r=>r.tipo==='observado').slice(-1)[0];
  const prev = stRows.filter(r=>r.tipo==='observado').slice(-7,-6)[0];

  if (rows.length) {
    document.getElementById('tsRange').textContent =
      `${rows[0].timestamp.slice(5,16)} → ${rows[rows.length-1].timestamp.slice(5,16)} (+${PRED_H}h prev.)`;
  }

  if (last) {
    const fields = {
      'k-vazao':['vazao_m3s','t-vazao'],
      'k-sal':['salinidade_psu','t-sal'],
      'k-nivel':['nivel_m','t-nivel'],
      'k-od':['od_mgL','t-od'],
      'k-temp':['temperatura_C','t-temp'],
    };
    const prevObs = stRows.filter(r=>r.tipo==='observado');
    Object.entries(fields).forEach(([kid, [field, tid]]) => {
      const d = field==='temperatura_C' ? 1 : 2;
      document.getElementById(kid).textContent = fmt(last[field], d);
      const delta = calcTrend(prevObs.map(r=>({...r,tipo:'observado'})).map(r=>({timestamp:r.timestamp,[field]:r[field],tipo:'observado'})), field);
      const tel = document.getElementById(tid);
      if (delta !== null) {
        const sign = delta > 0 ? '▲' : '▼';
        const cls  = delta > 0 ? 'trend-up' : 'trend-down';
        tel.innerHTML = `<span class="${cls}">${sign} ${Math.abs(delta).toFixed(2)}</span> <span class="trend-ok">vs 6h atrás</span>`;
      }
    });
  }

  updateAlerts(stRows);
  makeChart('ch-vazao', rows, 'vazao_m3s',      'm³/s');
  makeChart('ch-sal',   rows, 'salinidade_psu', 'PSU');
  makeChart('ch-nivel', rows, 'nivel_m',        'm');
  makeChart('ch-od',    rows, 'od_mgL',         'mg/L');
  makeChart('ch-temp',  rows, 'temperatura_C',  '°C');
}

function switchStation(st) {
  currentStation = st;
  document.querySelectorAll('.station-tab').forEach(t=>t.classList.toggle('active', t.dataset.st===st));
  document.getElementById('stationDesc').innerHTML = STATIONS[st].desc;
  render(+document.getElementById('winRange').value);
}

document.getElementById('winRange').addEventListener('input', e=>{
  const v=+e.target.value;
  document.getElementById('rangeVal').textContent=v+' h';
  render(v);
});

document.getElementById('varSel').addEventListener('change', e=>{
  const v=e.target.value;
  const ids=['c-vazao','c-sal','c-nivel','c-od','c-temp'];
  const map={vazao:'c-vazao',sal:'c-sal',nivel:'c-nivel',od:'c-od',temp:'c-temp'};
  if (v==='all') {
    ids.forEach(id=>{ const el=document.getElementById(id); el.style.display='block'; el.style.gridColumn=id==='c-nivel'?'span 2':''; });
  } else {
    ids.forEach(id=>document.getElementById(id).style.display='none');
    const el=document.getElementById(map[v]); el.style.display='block'; el.style.gridColumn='span 2';
  }
  render(+document.getElementById('winRange').value);
});

document.querySelectorAll('.station-tab').forEach(tab=>tab.addEventListener('click',()=>switchStation(tab.dataset.st)));


const landscapeMQ = window.matchMedia('(orientation: landscape) and (max-height: 520px)');
const onOrientationToggle = () => render(+document.getElementById('winRange').value);
if (landscapeMQ.addEventListener) landscapeMQ.addEventListener('change', onOrientationToggle);
else if (landscapeMQ.addListener) landscapeMQ.addListener(onOrientationToggle);
window.addEventListener('orientationchange', () => setTimeout(onOrientationToggle, 200));

const portraitMQ = window.matchMedia('(orientation: portrait) and (max-width: 900px)');
const resetRotateOverlay = () => {
  if (!portraitMQ.matches) {
    const ov = document.getElementById('rotateOverlay');
    if (ov) ov.classList.remove('dismissed');
  }
};
if (portraitMQ.addEventListener) portraitMQ.addEventListener('change', resetRotateOverlay);
else if (portraitMQ.addListener) portraitMQ.addListener(resetRotateOverlay);

const ALERT_CFG = {
  atencao:    { title:'ATENÇÃO',    color:'#eab308', sub:'Parâmetros fora do ideal. Vazão e nível reduzidos. Monitore com frequência.' },
  alerta:     { title:'ALERTA',     color:'#f97316', sub:'Situação crítica! Vazão e nível muito baixos. OD em queda. Ação recomendada.' },
  emergencia: { title:'EMERGÊNCIA', color:'#ef4444', sub:'Colapso de oxigênio dissolvido. Risco à biota aquática. Ação imediata necessária.' },
};

let countdownTimer = null;

let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function beep(freq, duration, type = 'sine', volume = 0.3) {
  const ctx = getAudio();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

let soundLoopTimer = null;

function stopSound() {
  if (soundLoopTimer) { clearInterval(soundLoopTimer); soundLoopTimer = null; }
}

function playAlertSound(cenario) {
  stopSound();
  const intervals = { atencao: 1800, alerta: 1400, emergencia: 1800 };
  const interval = intervals[cenario];
  if (!interval) return;

  const play = () => {
    if (cenario === 'atencao') {
      beep(660, 0.18, 'sine', 0.25);
      setTimeout(() => beep(660, 0.18, 'sine', 0.25), 280);
    } else if (cenario === 'alerta') {
      beep(880, 0.2, 'square', 0.18);
      setTimeout(() => beep(740, 0.2, 'square', 0.18), 280);
      setTimeout(() => beep(660, 0.3, 'square', 0.18), 560);
    } else if (cenario === 'emergencia') {
      let delay = 0;
      for (let i = 0; i < 6; i++) {
        const f = i % 2 === 0 ? 960 : 640;
        setTimeout(() => beep(f, 0.22, 'sawtooth', 0.22), delay);
        delay += 240;
      }
    }
  };

  play();
  soundLoopTimer = setInterval(play, interval);
}

function dismissAlert() {
  document.getElementById('alertOverlay').classList.remove('visible');
  stopSound();
}

function showAlertOverlay(cenario) {
  const cfg = ALERT_CFG[cenario];
  if (!cfg) return;
  const overlay = document.getElementById('alertOverlay');
  const box = overlay.querySelector('.alert-box');
  overlay.style.setProperty('--ao-color', cfg.color);
  box.style.setProperty('--ao-color', cfg.color);
  document.getElementById('ao-title').textContent = cfg.title;
  document.getElementById('ao-sub').textContent   = cfg.sub;
  overlay.classList.add('visible');
  playAlertSound(cenario);
}

function startCountdown(cenario) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (cenario === 'normal' || cenario === 'reset') {
    document.getElementById('sim-countdown').classList.remove('visible');
    return;
  }
  let secs = 5;
  const pill   = document.getElementById('sim-countdown');
  const numEl  = document.getElementById('countdown-num');
  pill.classList.add('visible');
  numEl.textContent = secs;
  countdownTimer = setInterval(() => {
    secs--;
    numEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      pill.classList.remove('visible');
      showAlertOverlay(cenario);
    }
  }, 1000);
}

const CENARIOS = {
  normal: {
    label: 'Normal',
    vazao_m3s:      2.85,
    salinidade_psu: 7.20,
    nivel_m:        1.18,
    od_mgL:         7.40,
    temperatura_C:  24.2,
  },
  atencao: {
    label: 'Atenção',
    vazao_m3s:      1.35,
    salinidade_psu: 9.80,
    nivel_m:        0.72,
    od_mgL:         5.30,
    temperatura_C:  27.1,
  },
  alerta: {
    label: 'Alerta',
    vazao_m3s:      0.70,
    salinidade_psu: 12.50,
    nivel_m:        0.48,
    od_mgL:         3.80,
    temperatura_C:  29.4,
  },
  emergencia: {
    label: 'Emergência',
    vazao_m3s:      0.40,
    salinidade_psu: 15.20,
    nivel_m:        0.31,
    od_mgL:         1.80,
    temperatura_C:  31.6,
  },
};

let DADOS_ORIGINAIS = null;

function simular(cenario) {
  if (!DADOS_ORIGINAIS) DADOS_ORIGINAIS = JSON.parse(JSON.stringify(ALL_DATA));

  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  stopSound();
  document.getElementById('sim-countdown').classList.remove('visible');
  dismissAlert();

  document.querySelectorAll('.sim-btn[id^="sim-"]').forEach(b => b.classList.remove('active'));

  if (cenario === 'reset') {
    ALL_DATA = JSON.parse(JSON.stringify(DADOS_ORIGINAIS));
    cenarioAtivo = null;
  } else {
    const cfg = CENARIOS[cenario];
    if (!cfg) return;
    cenarioAtivo = cenario;

    ALL_DATA = JSON.parse(JSON.stringify(DADOS_ORIGINAIS));

    const multiplicadores = { P1: 1.0, P2: 0.85, P3: 1.1 };
    const estacoes = ['P1', 'P2', 'P3'];
    estacoes.forEach(st => {
      const m = multiplicadores[st];
      const stRows = ALL_DATA.filter(r => r.estacao === st && r.tipo === 'observado');
      if (!stRows.length) return;
      const lastTs = stRows[stRows.length - 1].timestamp;
      const d = new Date(lastTs.replace(' ', 'T'));
      d.setHours(d.getHours() + 1);
      const pad = n => String(n).padStart(2, '0');
      const novoTs = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

      ALL_DATA.push({
        timestamp:      novoTs,
        estacao:        st,
        vazao_m3s:      Math.max(0.1, +(cfg.vazao_m3s * m).toFixed(3)),
        salinidade_psu: Math.max(0,   +(cfg.salinidade_psu * (st==='P3'?0.1:m)).toFixed(3)),
        nivel_m:        Math.max(0.1, +(cfg.nivel_m * m).toFixed(3)),
        od_mgL:         Math.max(0.5, +(cfg.od_mgL * (st==='P3'?1.15:m)).toFixed(3)),
        temperatura_C:  +(cfg.temperatura_C * (st==='P3'?0.95:m)).toFixed(2),
        tipo:           'observado',
      });
    });

    document.getElementById('sim-' + cenario).classList.add('active');

    if (cenario !== 'normal') startCountdown(cenario);
  }

  render(+document.getElementById('winRange').value);
}

const DADOS = [{"timestamp":"2026-06-15 00:00","estacao":"P1","vazao_m3s":2.778,"salinidade_psu":8.448,"nivel_m":1.197,"od_mgL":7.34,"temperatura_C":24.48,"tipo":"observado"},{"timestamp":"2026-06-15 00:00","estacao":"P2","vazao_m3s":1.875,"salinidade_psu":3.9,"nivel_m":0.892,"od_mgL":5.757,"temperatura_C":25.82,"tipo":"observado"},{"timestamp":"2026-06-15 00:00","estacao":"P3","vazao_m3s":3.135,"salinidade_psu":0.649,"nivel_m":1.42,"od_mgL":8.122,"temperatura_C":23.49,"tipo":"observado"},{"timestamp":"2026-06-15 01:00","estacao":"P1","vazao_m3s":2.842,"salinidade_psu":9.447,"nivel_m":1.327,"od_mgL":7.053,"temperatura_C":24.87,"tipo":"observado"},{"timestamp":"2026-06-15 01:00","estacao":"P2","vazao_m3s":2.374,"salinidade_psu":4.237,"nivel_m":0.978,"od_mgL":5.743,"temperatura_C":26.32,"tipo":"observado"},{"timestamp":"2026-06-15 01:00","estacao":"P3","vazao_m3s":3.258,"salinidade_psu":1.287,"nivel_m":1.495,"od_mgL":8.101,"temperatura_C":23.82,"tipo":"observado"},{"timestamp":"2026-06-15 02:00","estacao":"P1","vazao_m3s":3.225,"salinidade_psu":9.573,"nivel_m":1.274,"od_mgL":6.779,"temperatura_C":25.11,"tipo":"observado"},{"timestamp":"2026-06-15 02:00","estacao":"P2","vazao_m3s":2.571,"salinidade_psu":5.527,"nivel_m":1.016,"od_mgL":5.669,"temperatura_C":26.4,"tipo":"observado"},{"timestamp":"2026-06-15 02:00","estacao":"P3","vazao_m3s":3.427,"salinidade_psu":1.739,"nivel_m":1.556,"od_mgL":7.964,"temperatura_C":24.45,"tipo":"observado"},{"timestamp":"2026-06-15 03:00","estacao":"P1","vazao_m3s":3.252,"salinidade_psu":10.493,"nivel_m":1.394,"od_mgL":6.65,"temperatura_C":25.45,"tipo":"observado"},{"timestamp":"2026-06-15 03:00","estacao":"P2","vazao_m3s":2.429,"salinidade_psu":5.747,"nivel_m":1.072,"od_mgL":5.843,"temperatura_C":26.74,"tipo":"observado"},{"timestamp":"2026-06-15 03:00","estacao":"P3","vazao_m3s":3.335,"salinidade_psu":2.328,"nivel_m":1.622,"od_mgL":7.777,"temperatura_C":24.79,"tipo":"observado"},{"timestamp":"2026-06-15 04:00","estacao":"P1","vazao_m3s":3.373,"salinidade_psu":10.088,"nivel_m":1.319,"od_mgL":6.574,"temperatura_C":25.94,"tipo":"observado"},{"timestamp":"2026-06-15 04:00","estacao":"P2","vazao_m3s":2.243,"salinidade_psu":5.426,"nivel_m":1.069,"od_mgL":5.217,"temperatura_C":27.21,"tipo":"observado"},{"timestamp":"2026-06-15 04:00","estacao":"P3","vazao_m3s":3.546,"salinidade_psu":2.612,"nivel_m":1.58,"od_mgL":7.459,"temperatura_C":24.81,"tipo":"observado"},{"timestamp":"2026-06-15 05:00","estacao":"P1","vazao_m3s":2.904,"salinidade_psu":9.814,"nivel_m":1.286,"od_mgL":6.606,"temperatura_C":26.06,"tipo":"observado"},{"timestamp":"2026-06-15 05:00","estacao":"P2","vazao_m3s":2.22,"salinidade_psu":4.74,"nivel_m":0.948,"od_mgL":5.004,"temperatura_C":27.16,"tipo":"observado"},{"timestamp":"2026-06-15 05:00","estacao":"P3","vazao_m3s":3.391,"salinidade_psu":1.686,"nivel_m":1.502,"od_mgL":7.573,"temperatura_C":25.07,"tipo":"observado"},{"timestamp":"2026-06-15 06:00","estacao":"P1","vazao_m3s":3.003,"salinidade_psu":8.95,"nivel_m":1.226,"od_mgL":6.398,"temperatura_C":26.14,"tipo":"observado"},{"timestamp":"2026-06-15 06:00","estacao":"P2","vazao_m3s":2.198,"salinidade_psu":4.35,"nivel_m":0.917,"od_mgL":5.591,"temperatura_C":27.25,"tipo":"observado"},{"timestamp":"2026-06-15 06:00","estacao":"P3","vazao_m3s":3.379,"salinidade_psu":0.517,"nivel_m":1.403,"od_mgL":7.274,"temperatura_C":25.08,"tipo":"observado"},{"timestamp":"2026-06-15 07:00","estacao":"P1","vazao_m3s":2.856,"salinidade_psu":8.035,"nivel_m":1.15,"od_mgL":6.145,"temperatura_C":26.06,"tipo":"observado"},{"timestamp":"2026-06-15 07:00","estacao":"P2","vazao_m3s":2.026,"salinidade_psu":2.925,"nivel_m":0.81,"od_mgL":5.22,"temperatura_C":27.51,"tipo":"observado"},{"timestamp":"2026-06-15 07:00","estacao":"P3","vazao_m3s":2.784,"salinidade_psu":0,"nivel_m":1.37,"od_mgL":7.431,"temperatura_C":24.99,"tipo":"observado"},{"timestamp":"2026-06-15 08:00","estacao":"P1","vazao_m3s":2.498,"salinidade_psu":6.704,"nivel_m":1.064,"od_mgL":6.438,"temperatura_C":25.93,"tipo":"observado"},{"timestamp":"2026-06-15 08:00","estacao":"P2","vazao_m3s":1.784,"salinidade_psu":3.062,"nivel_m":0.766,"od_mgL":5.554,"temperatura_C":26.9,"tipo":"observado"},{"timestamp":"2026-06-15 08:00","estacao":"P3","vazao_m3s":2.765,"salinidade_psu":0,"nivel_m":1.31,"od_mgL":7.244,"temperatura_C":25.05,"tipo":"observado"},{"timestamp":"2026-06-15 09:00","estacao":"P1","vazao_m3s":2.493,"salinidade_psu":7.181,"nivel_m":1.043,"od_mgL":6.786,"temperatura_C":25.48,"tipo":"observado"},{"timestamp":"2026-06-15 09:00","estacao":"P2","vazao_m3s":1.517,"salinidade_psu":2.079,"nivel_m":0.716,"od_mgL":5.78,"temperatura_C":26.77,"tipo":"observado"},{"timestamp":"2026-06-15 09:00","estacao":"P3","vazao_m3s":2.753,"salinidade_psu":0,"nivel_m":1.21,"od_mgL":7.728,"temperatura_C":24.78,"tipo":"observado"},{"timestamp":"2026-06-15 10:00","estacao":"P1","vazao_m3s":2.642,"salinidade_psu":6.799,"nivel_m":0.998,"od_mgL":6.992,"temperatura_C":25.33,"tipo":"observado"},{"timestamp":"2026-06-15 10:00","estacao":"P2","vazao_m3s":1.799,"salinidade_psu":1.902,"nivel_m":0.765,"od_mgL":5.518,"temperatura_C":26.65,"tipo":"observado"},{"timestamp":"2026-06-15 10:00","estacao":"P3","vazao_m3s":2.916,"salinidade_psu":0,"nivel_m":1.24,"od_mgL":8.231,"temperatura_C":24.39,"tipo":"observado"},{"timestamp":"2026-06-15 11:00","estacao":"P1","vazao_m3s":2.495,"salinidade_psu":7.361,"nivel_m":1.127,"od_mgL":7.068,"temperatura_C":24.97,"tipo":"observado"},{"timestamp":"2026-06-15 11:00","estacao":"P2","vazao_m3s":2.019,"salinidade_psu":2.474,"nivel_m":0.731,"od_mgL":5.705,"temperatura_C":26.22,"tipo":"observado"},{"timestamp":"2026-06-15 11:00","estacao":"P3","vazao_m3s":2.748,"salinidade_psu":0,"nivel_m":1.301,"od_mgL":7.746,"temperatura_C":24.07,"tipo":"observado"},{"timestamp":"2026-06-15 12:00","estacao":"P1","vazao_m3s":2.69,"salinidade_psu":7.693,"nivel_m":1.177,"od_mgL":7.191,"temperatura_C":24.39,"tipo":"observado"},{"timestamp":"2026-06-15 12:00","estacao":"P2","vazao_m3s":2.098,"salinidade_psu":3.584,"nivel_m":0.846,"od_mgL":5.88,"temperatura_C":25.95,"tipo":"observado"},{"timestamp":"2026-06-15 12:00","estacao":"P3","vazao_m3s":2.913,"salinidade_psu":0.052,"nivel_m":1.364,"od_mgL":8.553,"temperatura_C":23.32,"tipo":"observado"},{"timestamp":"2026-06-15 13:00","estacao":"P1","vazao_m3s":3.024,"salinidade_psu":8.947,"nivel_m":1.251,"od_mgL":7.736,"temperatura_C":24.11,"tipo":"observado"},{"timestamp":"2026-06-15 13:00","estacao":"P2","vazao_m3s":2.556,"salinidade_psu":4.206,"nivel_m":0.964,"od_mgL":5.857,"temperatura_C":25.31,"tipo":"observado"},{"timestamp":"2026-06-15 13:00","estacao":"P3","vazao_m3s":3.229,"salinidade_psu":0.754,"nivel_m":1.46,"od_mgL":7.834,"temperatura_C":23.51,"tipo":"observado"},{"timestamp":"2026-06-15 14:00","estacao":"P1","vazao_m3s":3.065,"salinidade_psu":10.327,"nivel_m":1.3,"od_mgL":7.559,"temperatura_C":24.22,"tipo":"observado"},{"timestamp":"2026-06-15 14:00","estacao":"P2","vazao_m3s":2.259,"salinidade_psu":4.656,"nivel_m":1.014,"od_mgL":6.194,"temperatura_C":25.15,"tipo":"observado"},{"timestamp":"2026-06-15 14:00","estacao":"P3","vazao_m3s":3.583,"salinidade_psu":1.528,"nivel_m":1.482,"od_mgL":8.313,"temperatura_C":23.04,"tipo":"observado"},{"timestamp":"2026-06-15 15:00","estacao":"P1","vazao_m3s":3.257,"salinidade_psu":9.655,"nivel_m":1.373,"od_mgL":7.904,"temperatura_C":23.76,"tipo":"observado"},{"timestamp":"2026-06-15 15:00","estacao":"P2","vazao_m3s":2.571,"salinidade_psu":5.635,"nivel_m":1.037,"od_mgL":6.056,"temperatura_C":24.75,"tipo":"observado"},{"timestamp":"2026-06-15 15:00","estacao":"P3","vazao_m3s":3.563,"salinidade_psu":2.217,"nivel_m":1.56,"od_mgL":8.294,"temperatura_C":22.42,"tipo":"observado"},{"timestamp":"2026-06-15 16:00","estacao":"P1","vazao_m3s":3.014,"salinidade_psu":10.436,"nivel_m":1.305,"od_mgL":7.653,"temperatura_C":23.27,"tipo":"observado"},{"timestamp":"2026-06-15 16:00","estacao":"P2","vazao_m3s":2.716,"salinidade_psu":5.564,"nivel_m":1.104,"od_mgL":6.24,"temperatura_C":24.39,"tipo":"observado"},{"timestamp":"2026-06-15 16:00","estacao":"P3","vazao_m3s":3.386,"salinidade_psu":2.501,"nivel_m":1.604,"od_mgL":8.717,"temperatura_C":22.8,"tipo":"observado"},{"timestamp":"2026-06-15 17:00","estacao":"P1","vazao_m3s":3.085,"salinidade_psu":9.991,"nivel_m":1.34,"od_mgL":7.735,"temperatura_C":23.4,"tipo":"observado"},{"timestamp":"2026-06-15 17:00","estacao":"P2","vazao_m3s":2.616,"salinidade_psu":4.685,"nivel_m":1.018,"od_mgL":6.465,"temperatura_C":24.47,"tipo":"observado"},{"timestamp":"2026-06-15 17:00","estacao":"P3","vazao_m3s":3.188,"salinidade_psu":0.928,"nivel_m":1.473,"od_mgL":8.665,"temperatura_C":22.14,"tipo":"observado"},{"timestamp":"2026-06-15 18:00","estacao":"P1","vazao_m3s":2.972,"salinidade_psu":8.808,"nivel_m":1.217,"od_mgL":7.395,"temperatura_C":23.05,"tipo":"observado"},{"timestamp":"2026-06-15 18:00","estacao":"P2","vazao_m3s":2.275,"salinidade_psu":4.637,"nivel_m":0.978,"od_mgL":6.362,"temperatura_C":24.5,"tipo":"observado"},{"timestamp":"2026-06-15 18:00","estacao":"P3","vazao_m3s":3.199,"salinidade_psu":0.641,"nivel_m":1.438,"od_mgL":8.583,"temperatura_C":21.78,"tipo":"observado"},{"timestamp":"2026-06-15 19:00","estacao":"P1","vazao_m3s":2.743,"salinidade_psu":8.213,"nivel_m":1.153,"od_mgL":7.637,"temperatura_C":23.11,"tipo":"observado"},{"timestamp":"2026-06-15 19:00","estacao":"P2","vazao_m3s":2.277,"salinidade_psu":3.449,"nivel_m":0.849,"od_mgL":6.261,"temperatura_C":24.34,"tipo":"observado"},{"timestamp":"2026-06-15 19:00","estacao":"P3","vazao_m3s":2.83,"salinidade_psu":0,"nivel_m":1.366,"od_mgL":9.048,"temperatura_C":22.29,"tipo":"observado"},{"timestamp":"2026-06-15 20:00","estacao":"P1","vazao_m3s":2.695,"salinidade_psu":7.114,"nivel_m":1.103,"od_mgL":7.492,"temperatura_C":23.25,"tipo":"observado"},{"timestamp":"2026-06-15 20:00","estacao":"P2","vazao_m3s":1.902,"salinidade_psu":2.398,"nivel_m":0.843,"od_mgL":6.433,"temperatura_C":24.22,"tipo":"observado"},{"timestamp":"2026-06-15 20:00","estacao":"P3","vazao_m3s":2.922,"salinidade_psu":0,"nivel_m":1.283,"od_mgL":8.713,"temperatura_C":22.36,"tipo":"observado"},{"timestamp":"2026-06-15 21:00","estacao":"P1","vazao_m3s":2.119,"salinidade_psu":6.465,"nivel_m":1.054,"od_mgL":7.885,"temperatura_C":23.72,"tipo":"observado"},{"timestamp":"2026-06-15 21:00","estacao":"P2","vazao_m3s":1.995,"salinidade_psu":1.495,"nivel_m":0.754,"od_mgL":5.841,"temperatura_C":24.98,"tipo":"observado"},{"timestamp":"2026-06-15 21:00","estacao":"P3","vazao_m3s":2.763,"salinidade_psu":0,"nivel_m":1.292,"od_mgL":8.653,"temperatura_C":22.26,"tipo":"observado"},{"timestamp":"2026-06-15 22:00","estacao":"P1","vazao_m3s":2.449,"salinidade_psu":6.501,"nivel_m":1.025,"od_mgL":7.407,"temperatura_C":23.96,"tipo":"observado"},{"timestamp":"2026-06-15 22:00","estacao":"P2","vazao_m3s":1.491,"salinidade_psu":2.116,"nivel_m":0.777,"od_mgL":5.935,"temperatura_C":25.08,"tipo":"observado"},{"timestamp":"2026-06-15 22:00","estacao":"P3","vazao_m3s":2.735,"salinidade_psu":0,"nivel_m":1.242,"od_mgL":8.419,"temperatura_C":22.71,"tipo":"observado"},{"timestamp":"2026-06-15 23:00","estacao":"P1","vazao_m3s":2.748,"salinidade_psu":7.314,"nivel_m":1.053,"od_mgL":7.228,"temperatura_C":23.99,"tipo":"observado"},{"timestamp":"2026-06-15 23:00","estacao":"P2","vazao_m3s":1.968,"salinidade_psu":2.333,"nivel_m":0.771,"od_mgL":5.918,"temperatura_C":25.5,"tipo":"observado"},{"timestamp":"2026-06-15 23:00","estacao":"P3","vazao_m3s":2.766,"salinidade_psu":0,"nivel_m":1.252,"od_mgL":8.421,"temperatura_C":23.31,"tipo":"observado"},{"timestamp":"2026-06-16 00:00","estacao":"P1","vazao_m3s":2.625,"salinidade_psu":7.532,"nivel_m":1.101,"od_mgL":7.052,"temperatura_C":24.35,"tipo":"observado"},{"timestamp":"2026-06-16 00:00","estacao":"P2","vazao_m3s":2.072,"salinidade_psu":3.076,"nivel_m":0.876,"od_mgL":6.256,"temperatura_C":25.8,"tipo":"observado"},{"timestamp":"2026-06-16 00:00","estacao":"P3","vazao_m3s":2.71,"salinidade_psu":0,"nivel_m":1.327,"od_mgL":7.802,"temperatura_C":23.56,"tipo":"observado"},{"timestamp":"2026-06-16 01:00","estacao":"P1","vazao_m3s":2.884,"salinidade_psu":8.544,"nivel_m":1.195,"od_mgL":6.893,"temperatura_C":25.16,"tipo":"observado"},{"timestamp":"2026-06-16 01:00","estacao":"P2","vazao_m3s":2.117,"salinidade_psu":3.733,"nivel_m":0.907,"od_mgL":5.836,"temperatura_C":26.09,"tipo":"observado"},{"timestamp":"2026-06-16 01:00","estacao":"P3","vazao_m3s":3.213,"salinidade_psu":0.7,"nivel_m":1.441,"od_mgL":8.225,"temperatura_C":23.91,"tipo":"observado"},{"timestamp":"2026-06-16 02:00","estacao":"P1","vazao_m3s":3.198,"salinidade_psu":9.29,"nivel_m":1.291,"od_mgL":7.139,"temperatura_C":25.37,"tipo":"observado"},{"timestamp":"2026-06-16 02:00","estacao":"P2","vazao_m3s":2.329,"salinidade_psu":4.471,"nivel_m":1.02,"od_mgL":5.374,"temperatura_C":26.41,"tipo":"observado"},{"timestamp":"2026-06-16 02:00","estacao":"P3","vazao_m3s":3.231,"salinidade_psu":1.402,"nivel_m":1.439,"od_mgL":7.872,"temperatura_C":24.38,"tipo":"observado"},{"timestamp":"2026-06-16 03:00","estacao":"P1","vazao_m3s":3.071,"salinidade_psu":10.427,"nivel_m":1.38,"od_mgL":6.654,"temperatura_C":25.46,"tipo":"observado"},{"timestamp":"2026-06-16 03:00","estacao":"P2","vazao_m3s":2.563,"salinidade_psu":4.961,"nivel_m":1.052,"od_mgL":5.25,"temperatura_C":26.87,"tipo":"observado"},{"timestamp":"2026-06-16 03:00","estacao":"P3","vazao_m3s":3.491,"salinidade_psu":1.927,"nivel_m":1.596,"od_mgL":7.721,"temperatura_C":24.61,"tipo":"observado"},{"timestamp":"2026-06-16 04:00","estacao":"P1","vazao_m3s":3.018,"salinidade_psu":10.514,"nivel_m":1.396,"od_mgL":6.971,"temperatura_C":25.69,"tipo":"observado"},{"timestamp":"2026-06-16 04:00","estacao":"P2","vazao_m3s":2.503,"salinidade_psu":5.58,"nivel_m":1.077,"od_mgL":5.282,"temperatura_C":26.84,"tipo":"observado"},{"timestamp":"2026-06-16 04:00","estacao":"P3","vazao_m3s":3.623,"salinidade_psu":2.294,"nivel_m":1.614,"od_mgL":8.03,"temperatura_C":24.85,"tipo":"observado"},{"timestamp":"2026-06-16 05:00","estacao":"P1","vazao_m3s":3.134,"salinidade_psu":10.03,"nivel_m":1.411,"od_mgL":6.274,"temperatura_C":26.02,"tipo":"observado"},{"timestamp":"2026-06-16 05:00","estacao":"P2","vazao_m3s":2.219,"salinidade_psu":4.553,"nivel_m":0.992,"od_mgL":4.944,"temperatura_C":27.41,"tipo":"observado"},{"timestamp":"2026-06-16 05:00","estacao":"P3","vazao_m3s":3.309,"salinidade_psu":1.759,"nivel_m":1.518,"od_mgL":7.643,"temperatura_C":24.88,"tipo":"observado"},{"timestamp":"2026-06-16 06:00","estacao":"P1","vazao_m3s":3.192,"salinidade_psu":9.076,"nivel_m":1.264,"od_mgL":6.625,"temperatura_C":26.0,"tipo":"observado"},{"timestamp":"2026-06-16 06:00","estacao":"P2","vazao_m3s":2.508,"salinidade_psu":4.71,"nivel_m":0.951,"od_mgL":5.088,"temperatura_C":27.21,"tipo":"observado"},{"timestamp":"2026-06-16 06:00","estacao":"P3","vazao_m3s":3.403,"salinidade_psu":1.289,"nivel_m":1.484,"od_mgL":7.674,"temperatura_C":25.02,"tipo":"observado"},{"timestamp":"2026-06-16 07:00","estacao":"P1","vazao_m3s":2.78,"salinidade_psu":8.554,"nivel_m":1.246,"od_mgL":6.601,"temperatura_C":25.9,"tipo":"observado"},{"timestamp":"2026-06-16 07:00","estacao":"P2","vazao_m3s":1.943,"salinidade_psu":4.006,"nivel_m":0.882,"od_mgL":5.289,"temperatura_C":26.96,"tipo":"observado"},{"timestamp":"2026-06-16 07:00","estacao":"P3","vazao_m3s":3.256,"salinidade_psu":0,"nivel_m":1.377,"od_mgL":7.732,"temperatura_C":24.85,"tipo":"observado"},{"timestamp":"2026-06-16 08:00","estacao":"P1","vazao_m3s":2.594,"salinidade_psu":7.649,"nivel_m":1.083,"od_mgL":6.949,"temperatura_C":26.02,"tipo":"observado"},{"timestamp":"2026-06-16 08:00","estacao":"P2","vazao_m3s":1.61,"salinidade_psu":2.492,"nivel_m":0.837,"od_mgL":5.02,"temperatura_C":27.04,"tipo":"observado"},{"timestamp":"2026-06-16 08:00","estacao":"P3","vazao_m3s":2.925,"salinidade_psu":0,"nivel_m":1.306,"od_mgL":7.599,"temperatura_C":24.78,"tipo":"observado"},{"timestamp":"2026-06-16 09:00","estacao":"P1","vazao_m3s":2.654,"salinidade_psu":6.824,"nivel_m":1.057,"od_mgL":6.673,"temperatura_C":25.58,"tipo":"observado"},{"timestamp":"2026-06-16 09:00","estacao":"P2","vazao_m3s":1.735,"salinidade_psu":2.224,"nivel_m":0.717,"od_mgL":5.535,"temperatura_C":27.07,"tipo":"observado"},{"timestamp":"2026-06-16 09:00","estacao":"P3","vazao_m3s":2.797,"salinidade_psu":0,"nivel_m":1.272,"od_mgL":7.861,"temperatura_C":24.71,"tipo":"observado"},{"timestamp":"2026-06-16 10:00","estacao":"P1","vazao_m3s":2.432,"salinidade_psu":6.962,"nivel_m":1.022,"od_mgL":6.705,"temperatura_C":25.25,"tipo":"observado"},{"timestamp":"2026-06-16 10:00","estacao":"P2","vazao_m3s":1.417,"salinidade_psu":2.001,"nivel_m":0.733,"od_mgL":5.747,"temperatura_C":26.57,"tipo":"observado"},{"timestamp":"2026-06-16 10:00","estacao":"P3","vazao_m3s":2.84,"salinidade_psu":0,"nivel_m":1.19,"od_mgL":7.518,"temperatura_C":24.2,"tipo":"observado"},{"timestamp":"2026-06-16 11:00","estacao":"P1","vazao_m3s":2.236,"salinidade_psu":7.074,"nivel_m":1.032,"od_mgL":7.159,"temperatura_C":24.9,"tipo":"observado"},{"timestamp":"2026-06-16 11:00","estacao":"P2","vazao_m3s":1.897,"salinidade_psu":2.502,"nivel_m":0.719,"od_mgL":5.59,"temperatura_C":26.11,"tipo":"observado"},{"timestamp":"2026-06-16 11:00","estacao":"P3","vazao_m3s":2.498,"salinidade_psu":0,"nivel_m":1.274,"od_mgL":7.943,"temperatura_C":23.91,"tipo":"observado"},{"timestamp":"2026-06-16 12:00","estacao":"P1","vazao_m3s":2.735,"salinidade_psu":6.768,"nivel_m":1.102,"od_mgL":7.229,"temperatura_C":24.41,"tipo":"observado"},{"timestamp":"2026-06-16 12:00","estacao":"P2","vazao_m3s":2.08,"salinidade_psu":3.063,"nivel_m":0.789,"od_mgL":5.783,"temperatura_C":25.74,"tipo":"observado"},{"timestamp":"2026-06-16 12:00","estacao":"P3","vazao_m3s":2.795,"salinidade_psu":0,"nivel_m":1.339,"od_mgL":8.306,"temperatura_C":23.72,"tipo":"observado"},{"timestamp":"2026-06-16 13:00","estacao":"P1","vazao_m3s":2.595,"salinidade_psu":8.942,"nivel_m":1.241,"od_mgL":7.393,"temperatura_C":23.98,"tipo":"observado"},{"timestamp":"2026-06-16 13:00","estacao":"P2","vazao_m3s":1.93,"salinidade_psu":3.743,"nivel_m":0.854,"od_mgL":5.948,"temperatura_C":25.58,"tipo":"observado"},{"timestamp":"2026-06-16 13:00","estacao":"P3","vazao_m3s":2.834,"salinidade_psu":0.72,"nivel_m":1.429,"od_mgL":8.008,"temperatura_C":23.0,"tipo":"observado"},{"timestamp":"2026-06-16 14:00","estacao":"P1","vazao_m3s":2.915,"salinidade_psu":8.9,"nivel_m":1.263,"od_mgL":6.984,"temperatura_C":23.72,"tipo":"observado"},{"timestamp":"2026-06-16 14:00","estacao":"P2","vazao_m3s":2.528,"salinidade_psu":4.175,"nivel_m":0.963,"od_mgL":5.802,"temperatura_C":25.15,"tipo":"observado"},{"timestamp":"2026-06-16 14:00","estacao":"P3","vazao_m3s":3.224,"salinidade_psu":1.592,"nivel_m":1.477,"od_mgL":8.326,"temperatura_C":22.93,"tipo":"observado"},{"timestamp":"2026-06-16 15:00","estacao":"P1","vazao_m3s":3.04,"salinidade_psu":9.522,"nivel_m":1.351,"od_mgL":7.589,"temperatura_C":23.46,"tipo":"observado"},{"timestamp":"2026-06-16 15:00","estacao":"P2","vazao_m3s":2.473,"salinidade_psu":5.07,"nivel_m":1.055,"od_mgL":6.572,"temperatura_C":24.57,"tipo":"observado"},{"timestamp":"2026-06-16 15:00","estacao":"P3","vazao_m3s":3.677,"salinidade_psu":1.651,"nivel_m":1.519,"od_mgL":9.01,"temperatura_C":22.56,"tipo":"observado"},{"timestamp":"2026-06-16 16:00","estacao":"P1","vazao_m3s":3.401,"salinidade_psu":10.525,"nivel_m":1.328,"od_mgL":7.744,"temperatura_C":23.12,"tipo":"observado"},{"timestamp":"2026-06-16 16:00","estacao":"P2","vazao_m3s":2.294,"salinidade_psu":5.048,"nivel_m":1.081,"od_mgL":6.438,"temperatura_C":24.56,"tipo":"observado"},{"timestamp":"2026-06-16 16:00","estacao":"P3","vazao_m3s":3.45,"salinidade_psu":1.84,"nivel_m":1.548,"od_mgL":8.509,"temperatura_C":22.15,"tipo":"observado"},{"timestamp":"2026-06-16 17:00","estacao":"P1","vazao_m3s":3.145,"salinidade_psu":10.181,"nivel_m":1.342,"od_mgL":7.733,"temperatura_C":22.94,"tipo":"observado"},{"timestamp":"2026-06-16 17:00","estacao":"P2","vazao_m3s":2.474,"salinidade_psu":5.64,"nivel_m":1.074,"od_mgL":6.474,"temperatura_C":24.1,"tipo":"observado"},{"timestamp":"2026-06-16 17:00","estacao":"P3","vazao_m3s":3.418,"salinidade_psu":2.071,"nivel_m":1.588,"od_mgL":8.36,"temperatura_C":22.17,"tipo":"observado"},{"timestamp":"2026-06-16 18:00","estacao":"P1","vazao_m3s":3.242,"salinidade_psu":9.619,"nivel_m":1.314,"od_mgL":7.89,"temperatura_C":23.04,"tipo":"observado"},{"timestamp":"2026-06-16 18:00","estacao":"P2","vazao_m3s":2.462,"salinidade_psu":4.994,"nivel_m":1.022,"od_mgL":6.244,"temperatura_C":24.27,"tipo":"observado"},{"timestamp":"2026-06-16 18:00","estacao":"P3","vazao_m3s":3.549,"salinidade_psu":1.411,"nivel_m":1.512,"od_mgL":8.602,"temperatura_C":22.22,"tipo":"observado"},{"timestamp":"2026-06-16 19:00","estacao":"P1","vazao_m3s":2.752,"salinidade_psu":9.135,"nivel_m":1.208,"od_mgL":7.568,"temperatura_C":23.08,"tipo":"observado"},{"timestamp":"2026-06-16 19:00","estacao":"P2","vazao_m3s":2.2,"salinidade_psu":4.252,"nivel_m":0.968,"od_mgL":6.297,"temperatura_C":24.42,"tipo":"observado"},{"timestamp":"2026-06-16 19:00","estacao":"P3","vazao_m3s":3.044,"salinidade_psu":1.04,"nivel_m":1.455,"od_mgL":8.787,"temperatura_C":22.18,"tipo":"observado"},{"timestamp":"2026-06-16 20:00","estacao":"P1","vazao_m3s":2.562,"salinidade_psu":7.863,"nivel_m":1.161,"od_mgL":7.716,"temperatura_C":23.22,"tipo":"observado"},{"timestamp":"2026-06-16 20:00","estacao":"P2","vazao_m3s":1.776,"salinidade_psu":3.315,"nivel_m":0.825,"od_mgL":6.103,"temperatura_C":24.48,"tipo":"observado"},{"timestamp":"2026-06-16 20:00","estacao":"P3","vazao_m3s":2.702,"salinidade_psu":0,"nivel_m":1.372,"od_mgL":8.609,"temperatura_C":22.15,"tipo":"observado"},{"timestamp":"2026-06-16 21:00","estacao":"P1","vazao_m3s":2.368,"salinidade_psu":7.15,"nivel_m":0.997,"od_mgL":7.66,"temperatura_C":23.54,"tipo":"observado"},{"timestamp":"2026-06-16 21:00","estacao":"P2","vazao_m3s":1.763,"salinidade_psu":2.347,"nivel_m":0.775,"od_mgL":6.294,"temperatura_C":24.9,"tipo":"observado"},{"timestamp":"2026-06-16 21:00","estacao":"P3","vazao_m3s":2.813,"salinidade_psu":0,"nivel_m":1.256,"od_mgL":8.561,"temperatura_C":22.77,"tipo":"observado"},{"timestamp":"2026-06-16 22:00","estacao":"P1","vazao_m3s":2.365,"salinidade_psu":6.442,"nivel_m":1.0,"od_mgL":7.081,"temperatura_C":23.8,"tipo":"observado"},{"timestamp":"2026-06-16 22:00","estacao":"P2","vazao_m3s":1.509,"salinidade_psu":1.687,"nivel_m":0.666,"od_mgL":5.876,"temperatura_C":25.14,"tipo":"observado"},{"timestamp":"2026-06-16 22:00","estacao":"P3","vazao_m3s":2.516,"salinidade_psu":0,"nivel_m":1.231,"od_mgL":8.332,"temperatura_C":22.91,"tipo":"observado"},{"timestamp":"2026-06-16 23:00","estacao":"P1","vazao_m3s":2.524,"salinidade_psu":6.755,"nivel_m":0.987,"od_mgL":7.331,"temperatura_C":24.19,"tipo":"observado"},{"timestamp":"2026-06-16 23:00","estacao":"P2","vazao_m3s":1.625,"salinidade_psu":1.626,"nivel_m":0.759,"od_mgL":5.872,"temperatura_C":25.35,"tipo":"observado"},{"timestamp":"2026-06-16 23:00","estacao":"P3","vazao_m3s":2.715,"salinidade_psu":0,"nivel_m":1.234,"od_mgL":8.189,"temperatura_C":23.31,"tipo":"observado"},{"timestamp":"2026-06-17 00:00","estacao":"P1","vazao_m3s":2.832,"salinidade_psu":7.612,"nivel_m":1.09,"od_mgL":6.976,"temperatura_C":25.06,"tipo":"observado"},{"timestamp":"2026-06-17 00:00","estacao":"P2","vazao_m3s":1.63,"salinidade_psu":2.384,"nivel_m":0.749,"od_mgL":6.125,"temperatura_C":25.86,"tipo":"observado"},{"timestamp":"2026-06-17 00:00","estacao":"P3","vazao_m3s":2.596,"salinidade_psu":0,"nivel_m":1.286,"od_mgL":8.036,"temperatura_C":23.42,"tipo":"observado"},{"timestamp":"2026-06-17 01:00","estacao":"P1","vazao_m3s":2.571,"salinidade_psu":7.83,"nivel_m":1.147,"od_mgL":6.941,"temperatura_C":25.0,"tipo":"observado"},{"timestamp":"2026-06-17 01:00","estacao":"P2","vazao_m3s":1.838,"salinidade_psu":2.742,"nivel_m":0.824,"od_mgL":5.914,"temperatura_C":26.1,"tipo":"observado"},{"timestamp":"2026-06-17 01:00","estacao":"P3","vazao_m3s":3.331,"salinidade_psu":0,"nivel_m":1.311,"od_mgL":7.778,"temperatura_C":24.02,"tipo":"observado"},{"timestamp":"2026-06-17 02:00","estacao":"P1","vazao_m3s":2.704,"salinidade_psu":9.575,"nivel_m":1.207,"od_mgL":7.036,"temperatura_C":25.47,"tipo":"observado"},{"timestamp":"2026-06-17 02:00","estacao":"P2","vazao_m3s":2.164,"salinidade_psu":3.864,"nivel_m":0.928,"od_mgL":5.572,"temperatura_C":26.68,"tipo":"observado"},{"timestamp":"2026-06-17 02:00","estacao":"P3","vazao_m3s":3.189,"salinidade_psu":0.242,"nivel_m":1.438,"od_mgL":7.665,"temperatura_C":24.02,"tipo":"observado"},{"timestamp":"2026-06-17 03:00","estacao":"P1","vazao_m3s":2.956,"salinidade_psu":9.243,"nivel_m":1.335,"od_mgL":7.165,"temperatura_C":25.84,"tipo":"observado"},{"timestamp":"2026-06-17 03:00","estacao":"P2","vazao_m3s":2.275,"salinidade_psu":4.832,"nivel_m":1.038,"od_mgL":5.588,"temperatura_C":26.8,"tipo":"observado"},{"timestamp":"2026-06-17 03:00","estacao":"P3","vazao_m3s":3.339,"salinidade_psu":2.135,"nivel_m":1.514,"od_mgL":7.579,"temperatura_C":24.68,"tipo":"observado"},{"timestamp":"2026-06-17 04:00","estacao":"P1","vazao_m3s":3.262,"salinidade_psu":9.881,"nivel_m":1.361,"od_mgL":6.447,"temperatura_C":25.76,"tipo":"observado"},{"timestamp":"2026-06-17 04:00","estacao":"P2","vazao_m3s":2.757,"salinidade_psu":5.71,"nivel_m":1.066,"od_mgL":5.094,"temperatura_C":27.05,"tipo":"observado"},{"timestamp":"2026-06-17 04:00","estacao":"P3","vazao_m3s":3.633,"salinidade_psu":1.819,"nivel_m":1.612,"od_mgL":7.306,"temperatura_C":24.86,"tipo":"observado"},{"timestamp":"2026-06-17 05:00","estacao":"P1","vazao_m3s":3.457,"salinidade_psu":9.677,"nivel_m":1.414,"od_mgL":6.25,"temperatura_C":25.94,"tipo":"observado"},{"timestamp":"2026-06-17 05:00","estacao":"P2","vazao_m3s":2.47,"salinidade_psu":5.827,"nivel_m":0.983,"od_mgL":4.837,"temperatura_C":27.16,"tipo":"observado"},{"timestamp":"2026-06-17 05:00","estacao":"P3","vazao_m3s":3.501,"salinidade_psu":1.811,"nivel_m":1.571,"od_mgL":7.283,"temperatura_C":24.99,"tipo":"observado"},{"timestamp":"2026-06-17 06:00","estacao":"P1","vazao_m3s":2.989,"salinidade_psu":9.997,"nivel_m":1.36,"od_mgL":6.887,"temperatura_C":25.9,"tipo":"observado"},{"timestamp":"2026-06-17 06:00","estacao":"P2","vazao_m3s":2.369,"salinidade_psu":5.238,"nivel_m":1.033,"od_mgL":5.19,"temperatura_C":27.07,"tipo":"observado"},{"timestamp":"2026-06-17 06:00","estacao":"P3","vazao_m3s":3.472,"salinidade_psu":1.449,"nivel_m":1.514,"od_mgL":7.182,"temperatura_C":25.27,"tipo":"observado"},{"timestamp":"2026-06-17 07:00","estacao":"P1","vazao_m3s":2.937,"salinidade_psu":9.555,"nivel_m":1.279,"od_mgL":6.28,"temperatura_C":25.79,"tipo":"observado"},{"timestamp":"2026-06-17 07:00","estacao":"P2","vazao_m3s":2.371,"salinidade_psu":4.28,"nivel_m":0.938,"od_mgL":5.185,"temperatura_C":27.22,"tipo":"observado"},{"timestamp":"2026-06-17 07:00","estacao":"P3","vazao_m3s":3.106,"salinidade_psu":0.912,"nivel_m":1.457,"od_mgL":7.002,"temperatura_C":25.12,"tipo":"observado"},{"timestamp":"2026-06-17 08:00","estacao":"P1","vazao_m3s":2.638,"salinidade_psu":8.709,"nivel_m":1.147,"od_mgL":6.364,"temperatura_C":25.98,"tipo":"observado"},{"timestamp":"2026-06-17 08:00","estacao":"P2","vazao_m3s":1.822,"salinidade_psu":3.427,"nivel_m":0.9,"od_mgL":5.214,"temperatura_C":26.85,"tipo":"observado"},{"timestamp":"2026-06-17 08:00","estacao":"P3","vazao_m3s":3.088,"salinidade_psu":0.06,"nivel_m":1.42,"od_mgL":7.698,"temperatura_C":25.35,"tipo":"observado"},{"timestamp":"2026-06-17 09:00","estacao":"P1","vazao_m3s":2.325,"salinidade_psu":7.465,"nivel_m":1.065,"od_mgL":7.007,"temperatura_C":25.68,"tipo":"observado"},{"timestamp":"2026-06-17 09:00","estacao":"P2","vazao_m3s":1.985,"salinidade_psu":2.539,"nivel_m":0.775,"od_mgL":4.97,"temperatura_C":27.12,"tipo":"observado"},{"timestamp":"2026-06-17 09:00","estacao":"P3","vazao_m3s":2.948,"salinidade_psu":0,"nivel_m":1.325,"od_mgL":7.826,"temperatura_C":24.81,"tipo":"observado"},{"timestamp":"2026-06-17 10:00","estacao":"P1","vazao_m3s":2.197,"salinidade_psu":6.67,"nivel_m":1.044,"od_mgL":6.971,"temperatura_C":25.39,"tipo":"observado"},{"timestamp":"2026-06-17 10:00","estacao":"P2","vazao_m3s":1.59,"salinidade_psu":2.222,"nivel_m":0.805,"od_mgL":5.638,"temperatura_C":26.68,"tipo":"observado"},{"timestamp":"2026-06-17 10:00","estacao":"P3","vazao_m3s":2.738,"salinidade_psu":0,"nivel_m":1.293,"od_mgL":7.821,"temperatura_C":24.53,"tipo":"observado"},{"timestamp":"2026-06-17 11:00","estacao":"P1","vazao_m3s":2.269,"salinidade_psu":6.879,"nivel_m":1.047,"od_mgL":6.894,"temperatura_C":25.05,"tipo":"observado"},{"timestamp":"2026-06-17 11:00","estacao":"P2","vazao_m3s":1.599,"salinidade_psu":1.761,"nivel_m":0.72,"od_mgL":6.031,"temperatura_C":26.23,"tipo":"observado"},{"timestamp":"2026-06-17 11:00","estacao":"P3","vazao_m3s":2.841,"salinidade_psu":0,"nivel_m":1.223,"od_mgL":7.709,"temperatura_C":23.9,"tipo":"observado"},{"timestamp":"2026-06-17 12:00","estacao":"P1","vazao_m3s":2.586,"salinidade_psu":6.961,"nivel_m":1.091,"od_mgL":7.16,"temperatura_C":24.47,"tipo":"observado"},{"timestamp":"2026-06-17 12:00","estacao":"P2","vazao_m3s":1.952,"salinidade_psu":2.078,"nivel_m":0.702,"od_mgL":6.06,"temperatura_C":25.86,"tipo":"observado"},{"timestamp":"2026-06-17 12:00","estacao":"P3","vazao_m3s":2.436,"salinidade_psu":0,"nivel_m":1.235,"od_mgL":8.449,"temperatura_C":23.49,"tipo":"observado"},{"timestamp":"2026-06-17 13:00","estacao":"P1","vazao_m3s":2.519,"salinidade_psu":7.353,"nivel_m":1.081,"od_mgL":7.215,"temperatura_C":23.9,"tipo":"observado"},{"timestamp":"2026-06-17 13:00","estacao":"P2","vazao_m3s":1.751,"salinidade_psu":2.444,"nivel_m":0.768,"od_mgL":5.643,"temperatura_C":25.33,"tipo":"observado"},{"timestamp":"2026-06-17 13:00","estacao":"P3","vazao_m3s":2.803,"salinidade_psu":0,"nivel_m":1.327,"od_mgL":8.246,"temperatura_C":23.15,"tipo":"observado"},{"timestamp":"2026-06-17 14:00","estacao":"P1","vazao_m3s":2.73,"salinidade_psu":8.978,"nivel_m":1.207,"od_mgL":7.595,"temperatura_C":23.36,"tipo":"observado"},{"timestamp":"2026-06-17 14:00","estacao":"P2","vazao_m3s":2.002,"salinidade_psu":3.149,"nivel_m":0.887,"od_mgL":6.175,"temperatura_C":24.95,"tipo":"observado"},{"timestamp":"2026-06-17 14:00","estacao":"P3","vazao_m3s":3.178,"salinidade_psu":0,"nivel_m":1.417,"od_mgL":8.089,"temperatura_C":22.81,"tipo":"observado"},{"timestamp":"2026-06-17 15:00","estacao":"P1","vazao_m3s":3.057,"salinidade_psu":9.534,"nivel_m":1.284,"od_mgL":8.012,"temperatura_C":23.38,"tipo":"observado"},{"timestamp":"2026-06-17 15:00","estacao":"P2","vazao_m3s":2.226,"salinidade_psu":3.846,"nivel_m":1.04,"od_mgL":6.15,"temperatura_C":24.56,"tipo":"observado"},{"timestamp":"2026-06-17 15:00","estacao":"P3","vazao_m3s":3.492,"salinidade_psu":1.544,"nivel_m":1.491,"od_mgL":8.237,"temperatura_C":22.6,"tipo":"observado"},{"timestamp":"2026-06-17 16:00","estacao":"P1","vazao_m3s":3.046,"salinidade_psu":9.676,"nivel_m":1.384,"od_mgL":7.293,"temperatura_C":23.29,"tipo":"observado"},{"timestamp":"2026-06-17 16:00","estacao":"P2","vazao_m3s":2.508,"salinidade_psu":5.943,"nivel_m":1.063,"od_mgL":5.908,"temperatura_C":24.38,"tipo":"observado"},{"timestamp":"2026-06-17 16:00","estacao":"P3","vazao_m3s":3.449,"salinidade_psu":1.934,"nivel_m":1.582,"od_mgL":8.228,"temperatura_C":22.25,"tipo":"observado"},{"timestamp":"2026-06-17 17:00","estacao":"P1","vazao_m3s":3.345,"salinidade_psu":10.761,"nivel_m":1.436,"od_mgL":7.702,"temperatura_C":23.22,"tipo":"observado"},{"timestamp":"2026-06-17 17:00","estacao":"P2","vazao_m3s":2.756,"salinidade_psu":5.957,"nivel_m":1.101,"od_mgL":6.545,"temperatura_C":24.23,"tipo":"observado"},{"timestamp":"2026-06-17 17:00","estacao":"P3","vazao_m3s":3.282,"salinidade_psu":2.393,"nivel_m":1.569,"od_mgL":8.674,"temperatura_C":22.06,"tipo":"observado"},{"timestamp":"2026-06-17 18:00","estacao":"P1","vazao_m3s":3.1,"salinidade_psu":10.186,"nivel_m":1.331,"od_mgL":7.814,"temperatura_C":23.04,"tipo":"observado"},{"timestamp":"2026-06-17 18:00","estacao":"P2","vazao_m3s":2.448,"salinidade_psu":5.193,"nivel_m":1.085,"od_mgL":6.775,"temperatura_C":24.21,"tipo":"observado"},{"timestamp":"2026-06-17 18:00","estacao":"P3","vazao_m3s":3.644,"salinidade_psu":2.183,"nivel_m":1.482,"od_mgL":8.548,"temperatura_C":22.0,"tipo":"observado"},{"timestamp":"2026-06-17 19:00","estacao":"P1","vazao_m3s":3.146,"salinidade_psu":9.585,"nivel_m":1.317,"od_mgL":7.907,"temperatura_C":22.92,"tipo":"observado"},{"timestamp":"2026-06-17 19:00","estacao":"P2","vazao_m3s":2.217,"salinidade_psu":4.461,"nivel_m":0.998,"od_mgL":6.356,"temperatura_C":24.38,"tipo":"observado"},{"timestamp":"2026-06-17 19:00","estacao":"P3","vazao_m3s":3.219,"salinidade_psu":1.6,"nivel_m":1.53,"od_mgL":8.989,"temperatura_C":22.26,"tipo":"observado"},{"timestamp":"2026-06-17 20:00","estacao":"P1","vazao_m3s":2.868,"salinidade_psu":8.884,"nivel_m":1.237,"od_mgL":7.589,"temperatura_C":23.39,"tipo":"observado"},{"timestamp":"2026-06-17 20:00","estacao":"P2","vazao_m3s":2.398,"salinidade_psu":4.575,"nivel_m":0.919,"od_mgL":6.384,"temperatura_C":24.56,"tipo":"observado"},{"timestamp":"2026-06-17 20:00","estacao":"P3","vazao_m3s":3.14,"salinidade_psu":0.668,"nivel_m":1.415,"od_mgL":8.581,"temperatura_C":22.56,"tipo":"observado"},{"timestamp":"2026-06-17 21:00","estacao":"P1","vazao_m3s":2.667,"salinidade_psu":7.81,"nivel_m":1.155,"od_mgL":7.654,"temperatura_C":23.48,"tipo":"observado"},{"timestamp":"2026-06-17 21:00","estacao":"P2","vazao_m3s":1.933,"salinidade_psu":2.724,"nivel_m":0.828,"od_mgL":5.997,"temperatura_C":24.77,"tipo":"observado"},{"timestamp":"2026-06-17 21:00","estacao":"P3","vazao_m3s":2.765,"salinidade_psu":0,"nivel_m":1.351,"od_mgL":8.58,"temperatura_C":22.52,"tipo":"observado"},{"timestamp":"2026-06-17 22:00","estacao":"P1","vazao_m3s":2.546,"salinidade_psu":6.487,"nivel_m":1.025,"od_mgL":7.47,"temperatura_C":23.8,"tipo":"observado"},{"timestamp":"2026-06-17 22:00","estacao":"P2","vazao_m3s":1.772,"salinidade_psu":2.075,"nivel_m":0.762,"od_mgL":6.009,"temperatura_C":24.89,"tipo":"observado"},{"timestamp":"2026-06-17 22:00","estacao":"P3","vazao_m3s":2.833,"salinidade_psu":0,"nivel_m":1.294,"od_mgL":8.533,"temperatura_C":22.96,"tipo":"observado"},{"timestamp":"2026-06-17 23:00","estacao":"P1","vazao_m3s":2.453,"salinidade_psu":6.467,"nivel_m":0.994,"od_mgL":7.061,"temperatura_C":24.54,"tipo":"observado"},{"timestamp":"2026-06-17 23:00","estacao":"P2","vazao_m3s":1.543,"salinidade_psu":1.958,"nivel_m":0.711,"od_mgL":5.899,"temperatura_C":25.32,"tipo":"observado"},{"timestamp":"2026-06-17 23:00","estacao":"P3","vazao_m3s":2.424,"salinidade_psu":0,"nivel_m":1.18,"od_mgL":8.23,"temperatura_C":23.11,"tipo":"observado"},{"timestamp":"2026-06-18 00:00","estacao":"P1","vazao_m3s":2.322,"salinidade_psu":6.877,"nivel_m":1.014,"od_mgL":7.386,"temperatura_C":24.44,"tipo":"observado"},{"timestamp":"2026-06-18 00:00","estacao":"P2","vazao_m3s":1.759,"salinidade_psu":1.714,"nivel_m":0.751,"od_mgL":5.719,"temperatura_C":25.86,"tipo":"observado"},{"timestamp":"2026-06-18 00:00","estacao":"P3","vazao_m3s":2.774,"salinidade_psu":0,"nivel_m":1.238,"od_mgL":8.023,"temperatura_C":23.8,"tipo":"observado"},{"timestamp":"2026-06-18 01:00","estacao":"P1","vazao_m3s":2.68,"salinidade_psu":7.472,"nivel_m":1.047,"od_mgL":6.825,"temperatura_C":24.79,"tipo":"observado"},{"timestamp":"2026-06-18 01:00","estacao":"P2","vazao_m3s":1.803,"salinidade_psu":2.762,"nivel_m":0.756,"od_mgL":5.88,"temperatura_C":26.19,"tipo":"observado"},{"timestamp":"2026-06-18 01:00","estacao":"P3","vazao_m3s":2.538,"salinidade_psu":0,"nivel_m":1.205,"od_mgL":7.794,"temperatura_C":23.91,"tipo":"observado"},{"timestamp":"2026-06-18 02:00","estacao":"P1","vazao_m3s":2.628,"salinidade_psu":8.04,"nivel_m":1.152,"od_mgL":6.781,"temperatura_C":25.48,"tipo":"observado"},{"timestamp":"2026-06-18 02:00","estacao":"P2","vazao_m3s":2.202,"salinidade_psu":3.095,"nivel_m":0.901,"od_mgL":5.176,"temperatura_C":26.43,"tipo":"observado"},{"timestamp":"2026-06-18 02:00","estacao":"P3","vazao_m3s":3.248,"salinidade_psu":0,"nivel_m":1.381,"od_mgL":7.549,"temperatura_C":24.33,"tipo":"observado"},{"timestamp":"2026-06-18 03:00","estacao":"P1","vazao_m3s":2.893,"salinidade_psu":9.548,"nivel_m":1.23,"od_mgL":6.762,"temperatura_C":25.65,"tipo":"observado"},{"timestamp":"2026-06-18 03:00","estacao":"P2","vazao_m3s":2.182,"salinidade_psu":4.092,"nivel_m":0.952,"od_mgL":5.394,"temperatura_C":26.99,"tipo":"observado"},{"timestamp":"2026-06-18 03:00","estacao":"P3","vazao_m3s":3.078,"salinidade_psu":0.704,"nivel_m":1.464,"od_mgL":7.642,"temperatura_C":24.63,"tipo":"observado"},{"timestamp":"2026-06-18 04:00","estacao":"P1","vazao_m3s":3.087,"salinidade_psu":9.596,"nivel_m":1.306,"od_mgL":6.769,"temperatura_C":25.63,"tipo":"observado"},{"timestamp":"2026-06-18 04:00","estacao":"P2","vazao_m3s":2.565,"salinidade_psu":5.17,"nivel_m":0.992,"od_mgL":5.337,"temperatura_C":27.12,"tipo":"observado"},{"timestamp":"2026-06-18 04:00","estacao":"P3","vazao_m3s":3.504,"salinidade_psu":1.952,"nivel_m":1.519,"od_mgL":7.439,"temperatura_C":24.81,"tipo":"observado"},{"timestamp":"2026-06-18 05:00","estacao":"P1","vazao_m3s":3.04,"salinidade_psu":10.019,"nivel_m":1.383,"od_mgL":6.623,"temperatura_C":25.88,"tipo":"observado"},{"timestamp":"2026-06-18 05:00","estacao":"P2","vazao_m3s":2.376,"salinidade_psu":5.647,"nivel_m":1.059,"od_mgL":5.012,"temperatura_C":27.23,"tipo":"observado"},{"timestamp":"2026-06-18 05:00","estacao":"P3","vazao_m3s":3.448,"salinidade_psu":1.722,"nivel_m":1.599,"od_mgL":7.69,"temperatura_C":25.06,"tipo":"observado"},{"timestamp":"2026-06-18 06:00","estacao":"P1","vazao_m3s":3.207,"salinidade_psu":10.401,"nivel_m":1.373,"od_mgL":6.778,"temperatura_C":26.25,"tipo":"observado"},{"timestamp":"2026-06-18 06:00","estacao":"P2","vazao_m3s":2.499,"salinidade_psu":5.675,"nivel_m":1.1,"od_mgL":5.132,"temperatura_C":27.13,"tipo":"observado"},{"timestamp":"2026-06-18 06:00","estacao":"P3","vazao_m3s":3.623,"salinidade_psu":1.572,"nivel_m":1.628,"od_mgL":7.674,"temperatura_C":25.13,"tipo":"observado"},{"timestamp":"2026-06-18 07:00","estacao":"P1","vazao_m3s":3.098,"salinidade_psu":10.33,"nivel_m":1.302,"od_mgL":6.388,"temperatura_C":25.86,"tipo":"observado"},{"timestamp":"2026-06-18 07:00","estacao":"P2","vazao_m3s":2.351,"salinidade_psu":4.803,"nivel_m":1.035,"od_mgL":5.248,"temperatura_C":27.13,"tipo":"observado"},{"timestamp":"2026-06-18 07:00","estacao":"P3","vazao_m3s":3.63,"salinidade_psu":1.187,"nivel_m":1.492,"od_mgL":7.596,"temperatura_C":25.02,"tipo":"observado"},{"timestamp":"2026-06-18 08:00","estacao":"P1","vazao_m3s":2.982,"salinidade_psu":8.853,"nivel_m":1.223,"od_mgL":6.551,"temperatura_C":25.7,"tipo":"observado"},{"timestamp":"2026-06-18 08:00","estacao":"P2","vazao_m3s":2.298,"salinidade_psu":4.195,"nivel_m":0.977,"od_mgL":5.398,"temperatura_C":27.26,"tipo":"observado"},{"timestamp":"2026-06-18 08:00","estacao":"P3","vazao_m3s":3.355,"salinidade_psu":1.074,"nivel_m":1.477,"od_mgL":7.477,"temperatura_C":24.86,"tipo":"observado"},{"timestamp":"2026-06-18 09:00","estacao":"P1","vazao_m3s":2.445,"salinidade_psu":8.225,"nivel_m":1.144,"od_mgL":6.856,"temperatura_C":25.64,"tipo":"observado"},{"timestamp":"2026-06-18 09:00","estacao":"P2","vazao_m3s":1.817,"salinidade_psu":3.134,"nivel_m":0.853,"od_mgL":5.272,"temperatura_C":26.89,"tipo":"observado"},{"timestamp":"2026-06-18 09:00","estacao":"P3","vazao_m3s":2.846,"salinidade_psu":0,"nivel_m":1.313,"od_mgL":7.245,"temperatura_C":24.77,"tipo":"observado"},{"timestamp":"2026-06-18 10:00","estacao":"P1","vazao_m3s":2.344,"salinidade_psu":7.16,"nivel_m":1.04,"od_mgL":6.618,"temperatura_C":25.19,"tipo":"observado"},{"timestamp":"2026-06-18 10:00","estacao":"P2","vazao_m3s":1.778,"salinidade_psu":2.922,"nivel_m":0.796,"od_mgL":5.448,"temperatura_C":26.66,"tipo":"observado"},{"timestamp":"2026-06-18 10:00","estacao":"P3","vazao_m3s":3.007,"salinidade_psu":0,"nivel_m":1.271,"od_mgL":8.004,"temperatura_C":24.62,"tipo":"observado"},{"timestamp":"2026-06-18 11:00","estacao":"P1","vazao_m3s":2.524,"salinidade_psu":7.343,"nivel_m":1.059,"od_mgL":7.214,"temperatura_C":24.72,"tipo":"observado"},{"timestamp":"2026-06-18 11:00","estacao":"P2","vazao_m3s":1.558,"salinidade_psu":2.097,"nivel_m":0.681,"od_mgL":5.526,"temperatura_C":26.32,"tipo":"observado"},{"timestamp":"2026-06-18 11:00","estacao":"P3","vazao_m3s":2.625,"salinidade_psu":0,"nivel_m":1.191,"od_mgL":7.846,"temperatura_C":24.14,"tipo":"observado"},{"timestamp":"2026-06-18 12:00","estacao":"P1","vazao_m3s":2.436,"salinidade_psu":6.808,"nivel_m":1.073,"od_mgL":7.459,"temperatura_C":24.37,"tipo":"observado"},{"timestamp":"2026-06-18 12:00","estacao":"P2","vazao_m3s":1.902,"salinidade_psu":1.836,"nivel_m":0.722,"od_mgL":5.803,"temperatura_C":25.96,"tipo":"observado"},{"timestamp":"2026-06-18 12:00","estacao":"P3","vazao_m3s":2.535,"salinidade_psu":0,"nivel_m":1.238,"od_mgL":8.262,"temperatura_C":23.57,"tipo":"observado"},{"timestamp":"2026-06-18 13:00","estacao":"P1","vazao_m3s":2.634,"salinidade_psu":6.863,"nivel_m":1.092,"od_mgL":7.426,"temperatura_C":23.9,"tipo":"observado"},{"timestamp":"2026-06-18 13:00","estacao":"P2","vazao_m3s":1.845,"salinidade_psu":2.43,"nivel_m":0.747,"od_mgL":5.808,"temperatura_C":25.38,"tipo":"observado"},{"timestamp":"2026-06-18 13:00","estacao":"P3","vazao_m3s":2.567,"salinidade_psu":0,"nivel_m":1.224,"od_mgL":8.123,"temperatura_C":23.38,"tipo":"observado"},{"timestamp":"2026-06-18 14:00","estacao":"P1","vazao_m3s":2.73,"salinidade_psu":8.006,"nivel_m":1.175,"od_mgL":7.438,"temperatura_C":23.59,"tipo":"observado"},{"timestamp":"2026-06-18 14:00","estacao":"P2","vazao_m3s":2.069,"salinidade_psu":3.329,"nivel_m":0.819,"od_mgL":5.847,"temperatura_C":25.24,"tipo":"observado"},{"timestamp":"2026-06-18 14:00","estacao":"P3","vazao_m3s":3.029,"salinidade_psu":0,"nivel_m":1.352,"od_mgL":8.112,"temperatura_C":22.78,"tipo":"observado"},{"timestamp":"2026-06-18 15:00","estacao":"P1","vazao_m3s":2.672,"salinidade_psu":8.491,"nivel_m":1.193,"od_mgL":7.502,"temperatura_C":23.55,"tipo":"observado"},{"timestamp":"2026-06-18 15:00","estacao":"P2","vazao_m3s":2.185,"salinidade_psu":4.171,"nivel_m":0.951,"od_mgL":6.15,"temperatura_C":24.75,"tipo":"observado"},{"timestamp":"2026-06-18 15:00","estacao":"P3","vazao_m3s":3.221,"salinidade_psu":0.994,"nivel_m":1.445,"od_mgL":8.801,"temperatura_C":22.69,"tipo":"observado"},{"timestamp":"2026-06-18 16:00","estacao":"P1","vazao_m3s":3.187,"salinidade_psu":8.993,"nivel_m":1.329,"od_mgL":7.762,"temperatura_C":23.21,"tipo":"observado"},{"timestamp":"2026-06-18 16:00","estacao":"P2","vazao_m3s":2.249,"salinidade_psu":4.701,"nivel_m":1.015,"od_mgL":6.488,"temperatura_C":24.28,"tipo":"observado"},{"timestamp":"2026-06-18 16:00","estacao":"P3","vazao_m3s":3.361,"salinidade_psu":1.16,"nivel_m":1.474,"od_mgL":8.698,"temperatura_C":22.25,"tipo":"observado"},{"timestamp":"2026-06-18 17:00","estacao":"P1","vazao_m3s":3.06,"salinidade_psu":9.885,"nivel_m":1.37,"od_mgL":7.778,"temperatura_C":22.89,"tipo":"observado"},{"timestamp":"2026-06-18 17:00","estacao":"P2","vazao_m3s":2.333,"salinidade_psu":5.361,"nivel_m":1.074,"od_mgL":6.17,"temperatura_C":24.42,"tipo":"observado"},{"timestamp":"2026-06-18 17:00","estacao":"P3","vazao_m3s":3.336,"salinidade_psu":2.734,"nivel_m":1.533,"od_mgL":8.522,"temperatura_C":22.18,"tipo":"observado"},{"timestamp":"2026-06-18 18:00","estacao":"P1","vazao_m3s":3.064,"salinidade_psu":10.546,"nivel_m":1.434,"od_mgL":7.722,"temperatura_C":23.03,"tipo":"observado"},{"timestamp":"2026-06-18 18:00","estacao":"P2","vazao_m3s":2.422,"salinidade_psu":5.598,"nivel_m":1.123,"od_mgL":6.579,"temperatura_C":24.16,"tipo":"observado"},{"timestamp":"2026-06-18 18:00","estacao":"P3","vazao_m3s":3.731,"salinidade_psu":2.446,"nivel_m":1.594,"od_mgL":8.568,"temperatura_C":22.11,"tipo":"observado"},{"timestamp":"2026-06-18 19:00","estacao":"P1","vazao_m3s":3.02,"salinidade_psu":10.168,"nivel_m":1.343,"od_mgL":7.333,"temperatura_C":23.19,"tipo":"observado"},{"timestamp":"2026-06-18 19:00","estacao":"P2","vazao_m3s":2.468,"salinidade_psu":5.651,"nivel_m":1.049,"od_mgL":6.417,"temperatura_C":24.52,"tipo":"observado"},{"timestamp":"2026-06-18 19:00","estacao":"P3","vazao_m3s":3.498,"salinidade_psu":1.914,"nivel_m":1.649,"od_mgL":8.646,"temperatura_C":22.18,"tipo":"observado"},{"timestamp":"2026-06-18 20:00","estacao":"P1","vazao_m3s":3.254,"salinidade_psu":9.132,"nivel_m":1.256,"od_mgL":7.433,"temperatura_C":23.28,"tipo":"observado"},{"timestamp":"2026-06-18 20:00","estacao":"P2","vazao_m3s":2.388,"salinidade_psu":4.896,"nivel_m":0.947,"od_mgL":6.521,"temperatura_C":24.68,"tipo":"observado"},{"timestamp":"2026-06-18 20:00","estacao":"P3","vazao_m3s":3.28,"salinidade_psu":1.183,"nivel_m":1.508,"od_mgL":8.693,"temperatura_C":22.4,"tipo":"observado"},{"timestamp":"2026-06-18 21:00","estacao":"P1","vazao_m3s":2.637,"salinidade_psu":8.448,"nivel_m":1.164,"od_mgL":7.751,"temperatura_C":23.52,"tipo":"observado"},{"timestamp":"2026-06-18 21:00","estacao":"P2","vazao_m3s":2.085,"salinidade_psu":3.889,"nivel_m":0.853,"od_mgL":6.396,"temperatura_C":24.67,"tipo":"observado"},{"timestamp":"2026-06-18 21:00","estacao":"P3","vazao_m3s":3.119,"salinidade_psu":0.635,"nivel_m":1.377,"od_mgL":8.764,"temperatura_C":22.56,"tipo":"observado"},{"timestamp":"2026-06-18 22:00","estacao":"P1","vazao_m3s":2.61,"salinidade_psu":7.793,"nivel_m":1.075,"od_mgL":7.619,"temperatura_C":23.76,"tipo":"observado"},{"timestamp":"2026-06-18 22:00","estacao":"P2","vazao_m3s":2.061,"salinidade_psu":2.861,"nivel_m":0.802,"od_mgL":6.174,"temperatura_C":25.04,"tipo":"observado"},{"timestamp":"2026-06-18 22:00","estacao":"P3","vazao_m3s":2.73,"salinidade_psu":0,"nivel_m":1.351,"od_mgL":8.381,"temperatura_C":22.72,"tipo":"observado"},{"timestamp":"2026-06-18 23:00","estacao":"P1","vazao_m3s":2.568,"salinidade_psu":6.416,"nivel_m":0.984,"od_mgL":7.354,"temperatura_C":24.14,"tipo":"observado"},{"timestamp":"2026-06-18 23:00","estacao":"P2","vazao_m3s":1.794,"salinidade_psu":2.005,"nivel_m":0.743,"od_mgL":5.676,"temperatura_C":25.44,"tipo":"observado"},{"timestamp":"2026-06-18 23:00","estacao":"P3","vazao_m3s":2.518,"salinidade_psu":0,"nivel_m":1.255,"od_mgL":7.904,"temperatura_C":23.13,"tipo":"observado"},{"timestamp":"2026-06-19 00:00","estacao":"P1","vazao_m3s":2.519,"salinidade_psu":7.167,"nivel_m":0.975,"od_mgL":7.268,"temperatura_C":24.31,"tipo":"observado"},{"timestamp":"2026-06-19 00:00","estacao":"P2","vazao_m3s":1.499,"salinidade_psu":2.481,"nivel_m":0.74,"od_mgL":5.639,"temperatura_C":25.83,"tipo":"observado"},{"timestamp":"2026-06-19 00:00","estacao":"P3","vazao_m3s":2.797,"salinidade_psu":0,"nivel_m":1.288,"od_mgL":8.221,"temperatura_C":23.15,"tipo":"observado"},{"timestamp":"2026-06-19 01:00","estacao":"P1","vazao_m3s":2.397,"salinidade_psu":6.663,"nivel_m":1.032,"od_mgL":7.047,"temperatura_C":24.79,"tipo":"observado"},{"timestamp":"2026-06-19 01:00","estacao":"P2","vazao_m3s":1.578,"salinidade_psu":2.593,"nivel_m":0.756,"od_mgL":5.511,"temperatura_C":26.29,"tipo":"observado"},{"timestamp":"2026-06-19 01:00","estacao":"P3","vazao_m3s":2.842,"salinidade_psu":0,"nivel_m":1.207,"od_mgL":8.101,"temperatura_C":23.9,"tipo":"observado"},{"timestamp":"2026-06-19 02:00","estacao":"P1","vazao_m3s":2.745,"salinidade_psu":7.414,"nivel_m":1.029,"od_mgL":6.907,"temperatura_C":24.98,"tipo":"observado"},{"timestamp":"2026-06-19 02:00","estacao":"P2","vazao_m3s":1.839,"salinidade_psu":2.754,"nivel_m":0.785,"od_mgL":5.203,"temperatura_C":26.38,"tipo":"observado"},{"timestamp":"2026-06-19 02:00","estacao":"P3","vazao_m3s":2.745,"salinidade_psu":0,"nivel_m":1.336,"od_mgL":7.942,"temperatura_C":24.28,"tipo":"observado"},{"timestamp":"2026-06-19 03:00","estacao":"P1","vazao_m3s":2.951,"salinidade_psu":7.907,"nivel_m":1.202,"od_mgL":6.741,"temperatura_C":25.6,"tipo":"observado"},{"timestamp":"2026-06-19 03:00","estacao":"P2","vazao_m3s":2.155,"salinidade_psu":3.414,"nivel_m":0.906,"od_mgL":5.374,"temperatura_C":27.22,"tipo":"observado"},{"timestamp":"2026-06-19 03:00","estacao":"P3","vazao_m3s":3.014,"salinidade_psu":0.499,"nivel_m":1.401,"od_mgL":7.441,"temperatura_C":24.86,"tipo":"observado"},{"timestamp":"2026-06-19 04:00","estacao":"P1","vazao_m3s":2.799,"salinidade_psu":8.54,"nivel_m":1.297,"od_mgL":6.894,"temperatura_C":25.81,"tipo":"observado"},{"timestamp":"2026-06-19 04:00","estacao":"P2","vazao_m3s":2.219,"salinidade_psu":4.985,"nivel_m":0.992,"od_mgL":5.149,"temperatura_C":27.21,"tipo":"observado"},{"timestamp":"2026-06-19 04:00","estacao":"P3","vazao_m3s":3.071,"salinidade_psu":0.842,"nivel_m":1.439,"od_mgL":7.14,"temperatura_C":24.72,"tipo":"observado"},{"timestamp":"2026-06-19 05:00","estacao":"P1","vazao_m3s":3.3,"salinidade_psu":9.594,"nivel_m":1.326,"od_mgL":6.388,"temperatura_C":26.08,"tipo":"observado"},{"timestamp":"2026-06-19 05:00","estacao":"P2","vazao_m3s":2.416,"salinidade_psu":5.371,"nivel_m":1.039,"od_mgL":4.986,"temperatura_C":27.1,"tipo":"observado"},{"timestamp":"2026-06-19 05:00","estacao":"P3","vazao_m3s":3.542,"salinidade_psu":1.706,"nivel_m":1.566,"od_mgL":6.888,"temperatura_C":25.22,"tipo":"observado"},{"timestamp":"2026-06-19 06:00","estacao":"P1","vazao_m3s":3.121,"salinidade_psu":10.931,"nivel_m":1.363,"od_mgL":6.606,"temperatura_C":26.1,"tipo":"observado"},{"timestamp":"2026-06-19 06:00","estacao":"P2","vazao_m3s":2.364,"salinidade_psu":5.841,"nivel_m":1.059,"od_mgL":5.458,"temperatura_C":27.42,"tipo":"observado"},{"timestamp":"2026-06-19 06:00","estacao":"P3","vazao_m3s":3.57,"salinidade_psu":1.862,"nivel_m":1.572,"od_mgL":7.56,"temperatura_C":24.79,"tipo":"observado"},{"timestamp":"2026-06-19 07:00","estacao":"P1","vazao_m3s":3.092,"salinidade_psu":10.469,"nivel_m":1.331,"od_mgL":6.876,"temperatura_C":25.85,"tipo":"observado"},{"timestamp":"2026-06-19 07:00","estacao":"P2","vazao_m3s":2.524,"salinidade_psu":5.144,"nivel_m":1.083,"od_mgL":5.313,"temperatura_C":27.42,"tipo":"observado"},{"timestamp":"2026-06-19 07:00","estacao":"P3","vazao_m3s":3.678,"salinidade_psu":2.364,"nivel_m":1.575,"od_mgL":7.275,"temperatura_C":25.25,"tipo":"observado"},{"timestamp":"2026-06-19 08:00","estacao":"P1","vazao_m3s":2.865,"salinidade_psu":9.541,"nivel_m":1.339,"od_mgL":6.769,"temperatura_C":26.04,"tipo":"observado"},{"timestamp":"2026-06-19 08:00","estacao":"P2","vazao_m3s":2.36,"salinidade_psu":4.465,"nivel_m":1.009,"od_mgL":5.315,"temperatura_C":27.05,"tipo":"observado"},{"timestamp":"2026-06-19 08:00","estacao":"P3","vazao_m3s":3.572,"salinidade_psu":1.398,"nivel_m":1.474,"od_mgL":7.674,"temperatura_C":24.73,"tipo":"observado"},{"timestamp":"2026-06-19 09:00","estacao":"P1","vazao_m3s":3.136,"salinidade_psu":8.943,"nivel_m":1.194,"od_mgL":6.992,"temperatura_C":25.92,"tipo":"observado"},{"timestamp":"2026-06-19 09:00","estacao":"P2","vazao_m3s":1.88,"salinidade_psu":4.433,"nivel_m":0.951,"od_mgL":5.411,"temperatura_C":26.91,"tipo":"observado"},{"timestamp":"2026-06-19 09:00","estacao":"P3","vazao_m3s":3.254,"salinidade_psu":0.454,"nivel_m":1.479,"od_mgL":7.406,"temperatura_C":24.95,"tipo":"observado"},{"timestamp":"2026-06-19 10:00","estacao":"P1","vazao_m3s":2.909,"salinidade_psu":7.605,"nivel_m":1.146,"od_mgL":7.184,"temperatura_C":25.18,"tipo":"observado"},{"timestamp":"2026-06-19 10:00","estacao":"P2","vazao_m3s":1.956,"salinidade_psu":3.14,"nivel_m":0.881,"od_mgL":5.378,"temperatura_C":26.55,"tipo":"observado"},{"timestamp":"2026-06-19 10:00","estacao":"P3","vazao_m3s":3.061,"salinidade_psu":0,"nivel_m":1.32,"od_mgL":7.532,"temperatura_C":24.12,"tipo":"observado"},{"timestamp":"2026-06-19 11:00","estacao":"P1","vazao_m3s":2.333,"salinidade_psu":6.679,"nivel_m":1.048,"od_mgL":7.105,"temperatura_C":24.9,"tipo":"observado"},{"timestamp":"2026-06-19 11:00","estacao":"P2","vazao_m3s":1.686,"salinidade_psu":2.19,"nivel_m":0.74,"od_mgL":5.367,"temperatura_C":26.0,"tipo":"observado"},{"timestamp":"2026-06-19 11:00","estacao":"P3","vazao_m3s":2.917,"salinidade_psu":0,"nivel_m":1.27,"od_mgL":7.821,"temperatura_C":24.35,"tipo":"observado"},{"timestamp":"2026-06-19 12:00","estacao":"P1","vazao_m3s":2.143,"salinidade_psu":6.815,"nivel_m":1.016,"od_mgL":7.046,"temperatura_C":24.55,"tipo":"observado"},{"timestamp":"2026-06-19 12:00","estacao":"P2","vazao_m3s":1.736,"salinidade_psu":1.737,"nivel_m":0.739,"od_mgL":5.878,"temperatura_C":26.0,"tipo":"observado"},{"timestamp":"2026-06-19 12:00","estacao":"P3","vazao_m3s":2.621,"salinidade_psu":0,"nivel_m":1.22,"od_mgL":7.705,"temperatura_C":23.68,"tipo":"observado"},{"timestamp":"2026-06-19 13:00","estacao":"P1","vazao_m3s":2.401,"salinidade_psu":6.493,"nivel_m":1.054,"od_mgL":7.261,"temperatura_C":24.26,"tipo":"observado"},{"timestamp":"2026-06-19 13:00","estacao":"P2","vazao_m3s":1.7,"salinidade_psu":2.283,"nivel_m":0.746,"od_mgL":6.05,"temperatura_C":25.26,"tipo":"observado"},{"timestamp":"2026-06-19 13:00","estacao":"P3","vazao_m3s":2.851,"salinidade_psu":0,"nivel_m":1.286,"od_mgL":8.351,"temperatura_C":23.32,"tipo":"observado"},{"timestamp":"2026-06-19 14:00","estacao":"P1","vazao_m3s":2.395,"salinidade_psu":7.074,"nivel_m":1.072,"od_mgL":7.266,"temperatura_C":23.57,"tipo":"observado"},{"timestamp":"2026-06-19 14:00","estacao":"P2","vazao_m3s":1.794,"salinidade_psu":2.472,"nivel_m":0.776,"od_mgL":6.323,"temperatura_C":24.99,"tipo":"observado"},{"timestamp":"2026-06-19 14:00","estacao":"P3","vazao_m3s":2.912,"salinidade_psu":0,"nivel_m":1.264,"od_mgL":8.451,"temperatura_C":22.54,"tipo":"observado"},{"timestamp":"2026-06-19 15:00","estacao":"P1","vazao_m3s":2.69,"salinidade_psu":7.77,"nivel_m":1.118,"od_mgL":7.247,"temperatura_C":23.37,"tipo":"observado"},{"timestamp":"2026-06-19 15:00","estacao":"P2","vazao_m3s":1.699,"salinidade_psu":3.522,"nivel_m":0.839,"od_mgL":5.888,"temperatura_C":24.64,"tipo":"observado"},{"timestamp":"2026-06-19 15:00","estacao":"P3","vazao_m3s":3.093,"salinidade_psu":0,"nivel_m":1.338,"od_mgL":8.45,"temperatura_C":22.52,"tipo":"observado"},{"timestamp":"2026-06-19 16:00","estacao":"P1","vazao_m3s":2.626,"salinidade_psu":8.849,"nivel_m":1.219,"od_mgL":8.31,"temperatura_C":23.17,"tipo":"observado"},{"timestamp":"2026-06-19 16:00","estacao":"P2","vazao_m3s":2.112,"salinidade_psu":4.459,"nivel_m":0.932,"od_mgL":6.37,"temperatura_C":24.37,"tipo":"observado"},{"timestamp":"2026-06-19 16:00","estacao":"P3","vazao_m3s":3.414,"salinidade_psu":0.474,"nivel_m":1.447,"od_mgL":8.846,"temperatura_C":22.26,"tipo":"observado"},{"timestamp":"2026-06-19 17:00","estacao":"P1","vazao_m3s":3.061,"salinidade_psu":9.848,"nivel_m":1.338,"od_mgL":7.562,"temperatura_C":23.08,"tipo":"observado"},{"timestamp":"2026-06-19 17:00","estacao":"P2","vazao_m3s":2.219,"salinidade_psu":4.749,"nivel_m":0.998,"od_mgL":6.623,"temperatura_C":24.59,"tipo":"observado"},{"timestamp":"2026-06-19 17:00","estacao":"P3","vazao_m3s":3.751,"salinidade_psu":1.456,"nivel_m":1.492,"od_mgL":8.486,"temperatura_C":22.39,"tipo":"observado"},{"timestamp":"2026-06-19 18:00","estacao":"P1","vazao_m3s":2.944,"salinidade_psu":10.093,"nivel_m":1.352,"od_mgL":8.15,"temperatura_C":22.85,"tipo":"observado"},{"timestamp":"2026-06-19 18:00","estacao":"P2","vazao_m3s":2.64,"salinidade_psu":5.882,"nivel_m":1.064,"od_mgL":6.493,"temperatura_C":24.07,"tipo":"observado"},{"timestamp":"2026-06-19 18:00","estacao":"P3","vazao_m3s":3.462,"salinidade_psu":1.923,"nivel_m":1.491,"od_mgL":8.783,"temperatura_C":22.15,"tipo":"observado"},{"timestamp":"2026-06-19 19:00","estacao":"P1","vazao_m3s":2.941,"salinidade_psu":9.856,"nivel_m":1.355,"od_mgL":7.674,"temperatura_C":23.01,"tipo":"observado"},{"timestamp":"2026-06-19 19:00","estacao":"P2","vazao_m3s":2.352,"salinidade_psu":5.277,"nivel_m":1.087,"od_mgL":6.285,"temperatura_C":24.34,"tipo":"observado"},{"timestamp":"2026-06-19 19:00","estacao":"P3","vazao_m3s":3.461,"salinidade_psu":2.216,"nivel_m":1.573,"od_mgL":8.852,"temperatura_C":22.17,"tipo":"observado"},{"timestamp":"2026-06-19 20:00","estacao":"P1","vazao_m3s":3.25,"salinidade_psu":10.298,"nivel_m":1.299,"od_mgL":7.904,"temperatura_C":23.47,"tipo":"observado"},{"timestamp":"2026-06-19 20:00","estacao":"P2","vazao_m3s":2.27,"salinidade_psu":5.214,"nivel_m":1.032,"od_mgL":6.408,"temperatura_C":24.58,"tipo":"observado"},{"timestamp":"2026-06-19 20:00","estacao":"P3","vazao_m3s":3.316,"salinidade_psu":2.117,"nivel_m":1.517,"od_mgL":8.592,"temperatura_C":22.45,"tipo":"observado"},{"timestamp":"2026-06-19 21:00","estacao":"P1","vazao_m3s":3.251,"salinidade_psu":9.056,"nivel_m":1.294,"od_mgL":7.668,"temperatura_C":23.2,"tipo":"observado"},{"timestamp":"2026-06-19 21:00","estacao":"P2","vazao_m3s":2.114,"salinidade_psu":4.148,"nivel_m":0.956,"od_mgL":6.141,"temperatura_C":24.74,"tipo":"observado"},{"timestamp":"2026-06-19 21:00","estacao":"P3","vazao_m3s":3.449,"salinidade_psu":1.137,"nivel_m":1.551,"od_mgL":8.476,"temperatura_C":22.66,"tipo":"observado"},{"timestamp":"2026-06-19 22:00","estacao":"P1","vazao_m3s":2.822,"salinidade_psu":8.77,"nivel_m":1.17,"od_mgL":7.669,"temperatura_C":23.99,"tipo":"observado"},{"timestamp":"2026-06-19 22:00","estacao":"P2","vazao_m3s":1.951,"salinidade_psu":3.595,"nivel_m":0.897,"od_mgL":6.013,"temperatura_C":24.92,"tipo":"observado"},{"timestamp":"2026-06-19 22:00","estacao":"P3","vazao_m3s":3.334,"salinidade_psu":0.049,"nivel_m":1.434,"od_mgL":8.298,"temperatura_C":22.82,"tipo":"observado"},{"timestamp":"2026-06-19 23:00","estacao":"P1","vazao_m3s":2.691,"salinidade_psu":7.41,"nivel_m":1.07,"od_mgL":7.211,"temperatura_C":24.15,"tipo":"observado"},{"timestamp":"2026-06-19 23:00","estacao":"P2","vazao_m3s":1.772,"salinidade_psu":2.798,"nivel_m":0.729,"od_mgL":5.844,"temperatura_C":25.38,"tipo":"observado"},{"timestamp":"2026-06-19 23:00","estacao":"P3","vazao_m3s":2.795,"salinidade_psu":0,"nivel_m":1.271,"od_mgL":8.269,"temperatura_C":23.43,"tipo":"observado"},{"timestamp":"2026-06-20 00:00","estacao":"P1","vazao_m3s":2.231,"salinidade_psu":6.801,"nivel_m":1.068,"od_mgL":7.267,"temperatura_C":24.49,"tipo":"observado"},{"timestamp":"2026-06-20 00:00","estacao":"P2","vazao_m3s":1.673,"salinidade_psu":2.188,"nivel_m":0.735,"od_mgL":5.363,"temperatura_C":25.69,"tipo":"observado"},{"timestamp":"2026-06-20 00:00","estacao":"P3","vazao_m3s":2.448,"salinidade_psu":0,"nivel_m":1.263,"od_mgL":7.942,"temperatura_C":23.72,"tipo":"observado"},{"timestamp":"2026-06-20 01:00","estacao":"P1","vazao_m3s":2.768,"salinidade_psu":6.515,"nivel_m":1.059,"od_mgL":7.117,"temperatura_C":24.85,"tipo":"observado"},{"timestamp":"2026-06-20 01:00","estacao":"P2","vazao_m3s":1.535,"salinidade_psu":1.836,"nivel_m":0.708,"od_mgL":5.182,"temperatura_C":26.27,"tipo":"observado"},{"timestamp":"2026-06-20 01:00","estacao":"P3","vazao_m3s":2.652,"salinidade_psu":0,"nivel_m":1.208,"od_mgL":8.544,"temperatura_C":23.74,"tipo":"observado"},{"timestamp":"2026-06-20 02:00","estacao":"P1","vazao_m3s":2.321,"salinidade_psu":7.184,"nivel_m":1.118,"od_mgL":6.702,"temperatura_C":25.52,"tipo":"observado"},{"timestamp":"2026-06-20 02:00","estacao":"P2","vazao_m3s":1.623,"salinidade_psu":2.66,"nivel_m":0.75,"od_mgL":5.946,"temperatura_C":26.82,"tipo":"observado"},{"timestamp":"2026-06-20 02:00","estacao":"P3","vazao_m3s":2.663,"salinidade_psu":0,"nivel_m":1.214,"od_mgL":7.737,"temperatura_C":24.62,"tipo":"observado"},{"timestamp":"2026-06-20 03:00","estacao":"P1","vazao_m3s":2.496,"salinidade_psu":7.434,"nivel_m":1.117,"od_mgL":6.866,"temperatura_C":25.62,"tipo":"observado"},{"timestamp":"2026-06-20 03:00","estacao":"P2","vazao_m3s":1.794,"salinidade_psu":2.986,"nivel_m":0.832,"od_mgL":5.677,"temperatura_C":26.91,"tipo":"observado"},{"timestamp":"2026-06-20 03:00","estacao":"P3","vazao_m3s":2.718,"salinidade_psu":0,"nivel_m":1.294,"od_mgL":7.94,"temperatura_C":24.41,"tipo":"observado"},{"timestamp":"2026-06-20 04:00","estacao":"P1","vazao_m3s":2.884,"salinidade_psu":8.18,"nivel_m":1.238,"od_mgL":6.835,"temperatura_C":25.83,"tipo":"observado"},{"timestamp":"2026-06-20 04:00","estacao":"P2","vazao_m3s":2.176,"salinidade_psu":3.699,"nivel_m":0.92,"od_mgL":5.27,"temperatura_C":27.21,"tipo":"observado"},{"timestamp":"2026-06-20 04:00","estacao":"P3","vazao_m3s":3.109,"salinidade_psu":0,"nivel_m":1.385,"od_mgL":7.884,"temperatura_C":25.12,"tipo":"observado"},{"timestamp":"2026-06-20 05:00","estacao":"P1","vazao_m3s":3.01,"salinidade_psu":9.336,"nivel_m":1.277,"od_mgL":6.747,"temperatura_C":26.04,"tipo":"observado"},{"timestamp":"2026-06-20 05:00","estacao":"P2","vazao_m3s":2.147,"salinidade_psu":4.872,"nivel_m":1.024,"od_mgL":5.029,"temperatura_C":27.22,"tipo":"observado"},{"timestamp":"2026-06-20 05:00","estacao":"P3","vazao_m3s":3.364,"salinidade_psu":1.39,"nivel_m":1.475,"od_mgL":7.415,"temperatura_C":24.98,"tipo":"observado"},{"timestamp":"2026-06-20 06:00","estacao":"P1","vazao_m3s":3.197,"salinidade_psu":10.156,"nivel_m":1.352,"od_mgL":6.327,"temperatura_C":25.84,"tipo":"observado"},{"timestamp":"2026-06-20 06:00","estacao":"P2","vazao_m3s":2.535,"salinidade_psu":4.961,"nivel_m":1.06,"od_mgL":5.128,"temperatura_C":27.21,"tipo":"observado"},{"timestamp":"2026-06-20 06:00","estacao":"P3","vazao_m3s":3.443,"salinidade_psu":2.33,"nivel_m":1.561,"od_mgL":7.441,"temperatura_C":24.88,"tipo":"observado"},{"timestamp":"2026-06-20 07:00","estacao":"P1","vazao_m3s":3.276,"salinidade_psu":10.639,"nivel_m":1.398,"od_mgL":6.854,"temperatura_C":26.02,"tipo":"observado"},{"timestamp":"2026-06-20 07:00","estacao":"P2","vazao_m3s":2.304,"salinidade_psu":5.584,"nivel_m":1.096,"od_mgL":5.365,"temperatura_C":27.17,"tipo":"observado"},{"timestamp":"2026-06-20 07:00","estacao":"P3","vazao_m3s":3.49,"salinidade_psu":2.207,"nivel_m":1.618,"od_mgL":7.721,"temperatura_C":25.15,"tipo":"observado"},{"timestamp":"2026-06-20 08:00","estacao":"P1","vazao_m3s":3.219,"salinidade_psu":9.808,"nivel_m":1.329,"od_mgL":6.662,"temperatura_C":25.96,"tipo":"observado"},{"timestamp":"2026-06-20 08:00","estacao":"P2","vazao_m3s":2.518,"salinidade_psu":5.584,"nivel_m":1.017,"od_mgL":4.988,"temperatura_C":27.27,"tipo":"observado"},{"timestamp":"2026-06-20 08:00","estacao":"P3","vazao_m3s":3.454,"salinidade_psu":1.522,"nivel_m":1.588,"od_mgL":7.632,"temperatura_C":25.34,"tipo":"observado"},{"timestamp":"2026-06-20 09:00","estacao":"P1","vazao_m3s":3.216,"salinidade_psu":9.632,"nivel_m":1.298,"od_mgL":6.822,"temperatura_C":25.55,"tipo":"observado"},{"timestamp":"2026-06-20 09:00","estacao":"P2","vazao_m3s":2.113,"salinidade_psu":5.107,"nivel_m":1.011,"od_mgL":4.825,"temperatura_C":26.77,"tipo":"observado"},{"timestamp":"2026-06-20 09:00","estacao":"P3","vazao_m3s":3.204,"salinidade_psu":1.623,"nivel_m":1.502,"od_mgL":7.973,"temperatura_C":24.42,"tipo":"observado"},{"timestamp":"2026-06-20 10:00","estacao":"P1","vazao_m3s":2.679,"salinidade_psu":9.002,"nivel_m":1.199,"od_mgL":6.688,"temperatura_C":25.17,"tipo":"observado"},{"timestamp":"2026-06-20 10:00","estacao":"P2","vazao_m3s":2.026,"salinidade_psu":4.144,"nivel_m":0.952,"od_mgL":5.183,"temperatura_C":26.51,"tipo":"observado"},{"timestamp":"2026-06-20 10:00","estacao":"P3","vazao_m3s":3.143,"salinidade_psu":0.507,"nivel_m":1.443,"od_mgL":7.824,"temperatura_C":24.26,"tipo":"observado"},{"timestamp":"2026-06-20 11:00","estacao":"P1","vazao_m3s":2.475,"salinidade_psu":7.243,"nivel_m":1.118,"od_mgL":7.048,"temperatura_C":25.03,"tipo":"observado"},{"timestamp":"2026-06-20 11:00","estacao":"P2","vazao_m3s":1.886,"salinidade_psu":3.787,"nivel_m":0.827,"od_mgL":5.548,"temperatura_C":26.25,"tipo":"observado"},{"timestamp":"2026-06-20 11:00","estacao":"P3","vazao_m3s":2.797,"salinidade_psu":0,"nivel_m":1.267,"od_mgL":8.08,"temperatura_C":24.0,"tipo":"observado"},{"timestamp":"2026-06-20 12:00","estacao":"P1","vazao_m3s":2.515,"salinidade_psu":7.123,"nivel_m":1.019,"od_mgL":7.02,"temperatura_C":24.73,"tipo":"observado"},{"timestamp":"2026-06-20 12:00","estacao":"P2","vazao_m3s":1.858,"salinidade_psu":2.197,"nivel_m":0.77,"od_mgL":5.882,"temperatura_C":26.09,"tipo":"observado"},{"timestamp":"2026-06-20 12:00","estacao":"P3","vazao_m3s":2.95,"salinidade_psu":0,"nivel_m":1.244,"od_mgL":8.457,"temperatura_C":23.58,"tipo":"observado"},{"timestamp":"2026-06-20 13:00","estacao":"P1","vazao_m3s":2.274,"salinidade_psu":6.355,"nivel_m":0.996,"od_mgL":7.282,"temperatura_C":24.23,"tipo":"observado"},{"timestamp":"2026-06-20 13:00","estacao":"P2","vazao_m3s":1.842,"salinidade_psu":2.366,"nivel_m":0.727,"od_mgL":6.122,"temperatura_C":25.75,"tipo":"observado"},{"timestamp":"2026-06-20 13:00","estacao":"P3","vazao_m3s":2.841,"salinidade_psu":0,"nivel_m":1.177,"od_mgL":8.107,"temperatura_C":23.1,"tipo":"observado"},{"timestamp":"2026-06-20 14:00","estacao":"P1","vazao_m3s":2.023,"salinidade_psu":6.834,"nivel_m":1.073,"od_mgL":7.393,"temperatura_C":23.78,"tipo":"observado"},{"timestamp":"2026-06-20 14:00","estacao":"P2","vazao_m3s":1.597,"salinidade_psu":1.965,"nivel_m":0.74,"od_mgL":5.861,"temperatura_C":25.23,"tipo":"observado"},{"timestamp":"2026-06-20 14:00","estacao":"P3","vazao_m3s":2.437,"salinidade_psu":0,"nivel_m":1.216,"od_mgL":8.698,"temperatura_C":22.96,"tipo":"observado"},{"timestamp":"2026-06-20 15:00","estacao":"P1","vazao_m3s":2.227,"salinidade_psu":6.601,"nivel_m":1.053,"od_mgL":7.524,"temperatura_C":23.41,"tipo":"observado"},{"timestamp":"2026-06-20 15:00","estacao":"P2","vazao_m3s":1.844,"salinidade_psu":2.83,"nivel_m":0.742,"od_mgL":5.864,"temperatura_C":24.78,"tipo":"observado"},{"timestamp":"2026-06-20 15:00","estacao":"P3","vazao_m3s":2.785,"salinidade_psu":0,"nivel_m":1.263,"od_mgL":8.49,"temperatura_C":22.76,"tipo":"observado"},{"timestamp":"2026-06-20 16:00","estacao":"P1","vazao_m3s":2.476,"salinidade_psu":7.77,"nivel_m":1.183,"od_mgL":8.033,"temperatura_C":23.17,"tipo":"observado"},{"timestamp":"2026-06-20 16:00","estacao":"P2","vazao_m3s":1.83,"salinidade_psu":2.837,"nivel_m":0.872,"od_mgL":6.07,"temperatura_C":24.83,"tipo":"observado"},{"timestamp":"2026-06-20 16:00","estacao":"P3","vazao_m3s":3.371,"salinidade_psu":0.006,"nivel_m":1.378,"od_mgL":8.596,"temperatura_C":22.47,"tipo":"observado"},{"timestamp":"2026-06-20 17:00","estacao":"P1","vazao_m3s":2.919,"salinidade_psu":9.058,"nivel_m":1.295,"od_mgL":7.905,"temperatura_C":23.37,"tipo":"observado"},{"timestamp":"2026-06-20 17:00","estacao":"P2","vazao_m3s":1.974,"salinidade_psu":4.172,"nivel_m":0.927,"od_mgL":6.548,"temperatura_C":24.28,"tipo":"observado"},{"timestamp":"2026-06-20 17:00","estacao":"P3","vazao_m3s":3.31,"salinidade_psu":0.488,"nivel_m":1.451,"od_mgL":9.139,"temperatura_C":22.4,"tipo":"observado"},{"timestamp":"2026-06-20 18:00","estacao":"P1","vazao_m3s":2.808,"salinidade_psu":9.914,"nivel_m":1.355,"od_mgL":7.701,"temperatura_C":22.83,"tipo":"observado"},{"timestamp":"2026-06-20 18:00","estacao":"P2","vazao_m3s":2.489,"salinidade_psu":5.135,"nivel_m":1.047,"od_mgL":6.368,"temperatura_C":24.65,"tipo":"observado"},{"timestamp":"2026-06-20 18:00","estacao":"P3","vazao_m3s":3.253,"salinidade_psu":1.456,"nivel_m":1.546,"od_mgL":8.846,"temperatura_C":21.89,"tipo":"observado"},{"timestamp":"2026-06-20 19:00","estacao":"P1","vazao_m3s":3.382,"salinidade_psu":9.805,"nivel_m":1.374,"od_mgL":7.718,"temperatura_C":22.94,"tipo":"observado"},{"timestamp":"2026-06-20 19:00","estacao":"P2","vazao_m3s":2.657,"salinidade_psu":4.838,"nivel_m":1.052,"od_mgL":6.199,"temperatura_C":24.48,"tipo":"observado"},{"timestamp":"2026-06-20 19:00","estacao":"P3","vazao_m3s":3.72,"salinidade_psu":2.275,"nivel_m":1.616,"od_mgL":8.235,"temperatura_C":22.18,"tipo":"observado"},{"timestamp":"2026-06-20 20:00","estacao":"P1","vazao_m3s":2.98,"salinidade_psu":10.13,"nivel_m":1.382,"od_mgL":7.739,"temperatura_C":23.41,"tipo":"observado"},{"timestamp":"2026-06-20 20:00","estacao":"P2","vazao_m3s":2.19,"salinidade_psu":5.292,"nivel_m":1.03,"od_mgL":5.992,"temperatura_C":24.65,"tipo":"observado"},{"timestamp":"2026-06-20 20:00","estacao":"P3","vazao_m3s":3.515,"salinidade_psu":2.51,"nivel_m":1.61,"od_mgL":8.633,"temperatura_C":22.16,"tipo":"observado"},{"timestamp":"2026-06-20 21:00","estacao":"P1","vazao_m3s":3.239,"salinidade_psu":9.597,"nivel_m":1.294,"od_mgL":7.394,"temperatura_C":23.46,"tipo":"observado"},{"timestamp":"2026-06-20 21:00","estacao":"P2","vazao_m3s":2.58,"salinidade_psu":5.12,"nivel_m":1.067,"od_mgL":6.243,"temperatura_C":24.68,"tipo":"observado"},{"timestamp":"2026-06-20 21:00","estacao":"P3","vazao_m3s":3.798,"salinidade_psu":2.151,"nivel_m":1.536,"od_mgL":8.358,"temperatura_C":22.3,"tipo":"observado"},{"timestamp":"2026-06-20 22:00","estacao":"P1","vazao_m3s":2.98,"salinidade_psu":8.962,"nivel_m":1.268,"od_mgL":7.565,"temperatura_C":23.82,"tipo":"observado"},{"timestamp":"2026-06-20 22:00","estacao":"P2","vazao_m3s":2.391,"salinidade_psu":4.433,"nivel_m":0.932,"od_mgL":5.946,"temperatura_C":25.14,"tipo":"observado"},{"timestamp":"2026-06-20 22:00","estacao":"P3","vazao_m3s":3.059,"salinidade_psu":1.054,"nivel_m":1.475,"od_mgL":8.391,"temperatura_C":22.73,"tipo":"observado"},{"timestamp":"2026-06-20 23:00","estacao":"P1","vazao_m3s":2.453,"salinidade_psu":7.8,"nivel_m":1.115,"od_mgL":7.361,"temperatura_C":24.05,"tipo":"observado"},{"timestamp":"2026-06-20 23:00","estacao":"P2","vazao_m3s":1.881,"salinidade_psu":3.699,"nivel_m":0.868,"od_mgL":5.965,"temperatura_C":25.5,"tipo":"observado"},{"timestamp":"2026-06-20 23:00","estacao":"P3","vazao_m3s":3.175,"salinidade_psu":0,"nivel_m":1.385,"od_mgL":7.894,"temperatura_C":23.09,"tipo":"observado"},{"timestamp":"2026-06-21 00:00","estacao":"P1","vazao_m3s":2.691,"salinidade_psu":7.535,"nivel_m":1.103,"od_mgL":7.236,"temperatura_C":24.71,"tipo":"observado"},{"timestamp":"2026-06-21 00:00","estacao":"P2","vazao_m3s":1.608,"salinidade_psu":2.536,"nivel_m":0.784,"od_mgL":6.207,"temperatura_C":25.95,"tipo":"observado"},{"timestamp":"2026-06-21 00:00","estacao":"P3","vazao_m3s":2.995,"salinidade_psu":0,"nivel_m":1.35,"od_mgL":8.194,"temperatura_C":23.45,"tipo":"observado"},{"timestamp":"2026-06-21 01:00","estacao":"P1","vazao_m3s":2.777,"salinidade_psu":6.384,"nivel_m":1.005,"od_mgL":6.998,"temperatura_C":24.74,"tipo":"observado"},{"timestamp":"2026-06-21 01:00","estacao":"P2","vazao_m3s":1.804,"salinidade_psu":2.195,"nivel_m":0.735,"od_mgL":6.023,"temperatura_C":25.94,"tipo":"observado"},{"timestamp":"2026-06-21 01:00","estacao":"P3","vazao_m3s":2.93,"salinidade_psu":0,"nivel_m":1.275,"od_mgL":8.326,"temperatura_C":24.33,"tipo":"observado"},{"timestamp":"2026-06-21 02:00","estacao":"P1","vazao_m3s":2.376,"salinidade_psu":6.372,"nivel_m":1.032,"od_mgL":6.889,"temperatura_C":24.99,"tipo":"observado"},{"timestamp":"2026-06-21 02:00","estacao":"P2","vazao_m3s":1.815,"salinidade_psu":1.744,"nivel_m":0.765,"od_mgL":5.693,"temperatura_C":26.51,"tipo":"observado"},{"timestamp":"2026-06-21 02:00","estacao":"P3","vazao_m3s":2.71,"salinidade_psu":0,"nivel_m":1.208,"od_mgL":8.42,"temperatura_C":24.21,"tipo":"observado"},{"timestamp":"2026-06-21 03:00","estacao":"P1","vazao_m3s":2.492,"salinidade_psu":7.374,"nivel_m":1.046,"od_mgL":6.65,"temperatura_C":25.36,"tipo":"observado"},{"timestamp":"2026-06-21 03:00","estacao":"P2","vazao_m3s":1.962,"salinidade_psu":2.59,"nivel_m":0.772,"od_mgL":5.074,"temperatura_C":26.94,"tipo":"observado"},{"timestamp":"2026-06-21 03:00","estacao":"P3","vazao_m3s":2.826,"salinidade_psu":0,"nivel_m":1.216,"od_mgL":7.664,"temperatura_C":24.53,"tipo":"observado"},{"timestamp":"2026-06-21 04:00","estacao":"P1","vazao_m3s":2.654,"salinidade_psu":7.809,"nivel_m":1.119,"od_mgL":6.857,"temperatura_C":25.79,"tipo":"observado"},{"timestamp":"2026-06-21 04:00","estacao":"P2","vazao_m3s":2.022,"salinidade_psu":3.216,"nivel_m":0.859,"od_mgL":5.088,"temperatura_C":27.05,"tipo":"observado"},{"timestamp":"2026-06-21 04:00","estacao":"P3","vazao_m3s":3.081,"salinidade_psu":0,"nivel_m":1.363,"od_mgL":7.729,"temperatura_C":24.83,"tipo":"observado"},{"timestamp":"2026-06-21 05:00","estacao":"P1","vazao_m3s":2.973,"salinidade_psu":8.605,"nivel_m":1.247,"od_mgL":6.991,"temperatura_C":26.11,"tipo":"observado"},{"timestamp":"2026-06-21 05:00","estacao":"P2","vazao_m3s":2.484,"salinidade_psu":3.517,"nivel_m":0.902,"od_mgL":5.167,"temperatura_C":27.19,"tipo":"observado"},{"timestamp":"2026-06-21 05:00","estacao":"P3","vazao_m3s":3.196,"salinidade_psu":0.372,"nivel_m":1.451,"od_mgL":7.717,"temperatura_C":25.11,"tipo":"observado"},{"timestamp":"2026-06-21 06:00","estacao":"P1","vazao_m3s":2.877,"salinidade_psu":9.692,"nivel_m":1.323,"od_mgL":6.671,"temperatura_C":26.0,"tipo":"observado"},{"timestamp":"2026-06-21 06:00","estacao":"P2","vazao_m3s":2.539,"salinidade_psu":4.664,"nivel_m":0.992,"od_mgL":5.333,"temperatura_C":27.38,"tipo":"observado"},{"timestamp":"2026-06-21 06:00","estacao":"P3","vazao_m3s":3.456,"salinidade_psu":1.243,"nivel_m":1.463,"od_mgL":7.252,"temperatura_C":25.04,"tipo":"observado"},{"timestamp":"2026-06-21 07:00","estacao":"P1","vazao_m3s":3.278,"salinidade_psu":10.354,"nivel_m":1.307,"od_mgL":6.727,"temperatura_C":25.94,"tipo":"observado"},{"timestamp":"2026-06-21 07:00","estacao":"P2","vazao_m3s":2.303,"salinidade_psu":6.073,"nivel_m":1.07,"od_mgL":5.386,"temperatura_C":27.63,"tipo":"observado"},{"timestamp":"2026-06-21 07:00","estacao":"P3","vazao_m3s":3.372,"salinidade_psu":1.797,"nivel_m":1.606,"od_mgL":7.259,"temperatura_C":25.06,"tipo":"observado"},{"timestamp":"2026-06-21 08:00","estacao":"P1","vazao_m3s":3.206,"salinidade_psu":10.589,"nivel_m":1.392,"od_mgL":6.498,"temperatura_C":25.94,"tipo":"observado"},{"timestamp":"2026-06-21 08:00","estacao":"P2","vazao_m3s":2.626,"salinidade_psu":5.282,"nivel_m":1.059,"od_mgL":5.175,"temperatura_C":26.93,"tipo":"observado"},{"timestamp":"2026-06-21 08:00","estacao":"P3","vazao_m3s":3.659,"salinidade_psu":2.001,"nivel_m":1.571,"od_mgL":7.373,"temperatura_C":24.84,"tipo":"observado"},{"timestamp":"2026-06-21 09:00","estacao":"P1","vazao_m3s":3.362,"salinidade_psu":10.252,"nivel_m":1.304,"od_mgL":6.578,"temperatura_C":25.66,"tipo":"observado"},{"timestamp":"2026-06-21 09:00","estacao":"P2","vazao_m3s":2.365,"salinidade_psu":5.162,"nivel_m":1.027,"od_mgL":5.11,"temperatura_C":26.87,"tipo":"observado"},{"timestamp":"2026-06-21 09:00","estacao":"P3","vazao_m3s":3.382,"salinidade_psu":2.17,"nivel_m":1.551,"od_mgL":7.483,"temperatura_C":24.76,"tipo":"observado"},{"timestamp":"2026-06-21 10:00","estacao":"P1","vazao_m3s":3.196,"salinidade_psu":9.153,"nivel_m":1.236,"od_mgL":6.804,"temperatura_C":25.05,"tipo":"observado"},{"timestamp":"2026-06-21 10:00","estacao":"P2","vazao_m3s":2.54,"salinidade_psu":4.257,"nivel_m":0.978,"od_mgL":5.795,"temperatura_C":26.68,"tipo":"observado"},{"timestamp":"2026-06-21 10:00","estacao":"P3","vazao_m3s":3.217,"salinidade_psu":0.939,"nivel_m":1.482,"od_mgL":7.752,"temperatura_C":24.57,"tipo":"observado"},{"timestamp":"2026-06-21 11:00","estacao":"P1","vazao_m3s":2.777,"salinidade_psu":8.095,"nivel_m":1.23,"od_mgL":7.252,"temperatura_C":24.85,"tipo":"observado"},{"timestamp":"2026-06-21 11:00","estacao":"P2","vazao_m3s":2.216,"salinidade_psu":3.815,"nivel_m":0.864,"od_mgL":5.628,"temperatura_C":26.02,"tipo":"observado"},{"timestamp":"2026-06-21 11:00","estacao":"P3","vazao_m3s":3.005,"salinidade_psu":0.018,"nivel_m":1.41,"od_mgL":7.982,"temperatura_C":23.79,"tipo":"observado"},{"timestamp":"2026-06-21 12:00","estacao":"P1","vazao_m3s":2.468,"salinidade_psu":7.626,"nivel_m":1.127,"od_mgL":7.214,"temperatura_C":24.17,"tipo":"observado"},{"timestamp":"2026-06-21 12:00","estacao":"P2","vazao_m3s":2.099,"salinidade_psu":3.458,"nivel_m":0.86,"od_mgL":5.909,"temperatura_C":25.9,"tipo":"observado"},{"timestamp":"2026-06-21 12:00","estacao":"P3","vazao_m3s":2.808,"salinidade_psu":0,"nivel_m":1.279,"od_mgL":8.124,"temperatura_C":23.39,"tipo":"observado"},{"timestamp":"2026-06-21 13:00","estacao":"P1","vazao_m3s":2.548,"salinidade_psu":6.866,"nivel_m":1.07,"od_mgL":7.392,"temperatura_C":24.04,"tipo":"observado"},{"timestamp":"2026-06-21 13:00","estacao":"P2","vazao_m3s":1.887,"salinidade_psu":1.92,"nivel_m":0.739,"od_mgL":5.848,"temperatura_C":25.52,"tipo":"observado"},{"timestamp":"2026-06-21 13:00","estacao":"P3","vazao_m3s":2.749,"salinidade_psu":0,"nivel_m":1.263,"od_mgL":7.786,"temperatura_C":23.07,"tipo":"observado"},{"timestamp":"2026-06-21 14:00","estacao":"P1","vazao_m3s":2.418,"salinidade_psu":7.006,"nivel_m":1.037,"od_mgL":7.762,"temperatura_C":23.72,"tipo":"observado"},{"timestamp":"2026-06-21 14:00","estacao":"P2","vazao_m3s":1.716,"salinidade_psu":1.852,"nivel_m":0.707,"od_mgL":5.934,"temperatura_C":24.97,"tipo":"observado"},{"timestamp":"2026-06-21 14:00","estacao":"P3","vazao_m3s":2.672,"salinidade_psu":0,"nivel_m":1.221,"od_mgL":8.036,"temperatura_C":22.91,"tipo":"observado"},{"timestamp":"2026-06-21 15:00","estacao":"P1","vazao_m3s":2.467,"salinidade_psu":7.018,"nivel_m":1.024,"od_mgL":7.523,"temperatura_C":23.59,"tipo":"observado"},{"timestamp":"2026-06-21 15:00","estacao":"P2","vazao_m3s":1.718,"salinidade_psu":2.78,"nivel_m":0.696,"od_mgL":6.175,"temperatura_C":24.57,"tipo":"observado"},{"timestamp":"2026-06-21 15:00","estacao":"P3","vazao_m3s":2.623,"salinidade_psu":0,"nivel_m":1.224,"od_mgL":8.681,"temperatura_C":22.37,"tipo":"observado"},{"timestamp":"2026-06-21 16:00","estacao":"P1","vazao_m3s":2.663,"salinidade_psu":7.039,"nivel_m":1.085,"od_mgL":7.984,"temperatura_C":23.27,"tipo":"observado"},{"timestamp":"2026-06-21 16:00","estacao":"P2","vazao_m3s":1.912,"salinidade_psu":2.961,"nivel_m":0.814,"od_mgL":6.445,"temperatura_C":24.71,"tipo":"observado"},{"timestamp":"2026-06-21 16:00","estacao":"P3","vazao_m3s":2.716,"salinidade_psu":0,"nivel_m":1.316,"od_mgL":8.77,"temperatura_C":22.38,"tipo":"observado"},{"timestamp":"2026-06-21 17:00","estacao":"P1","vazao_m3s":2.956,"salinidade_psu":8.168,"nivel_m":1.141,"od_mgL":8.034,"temperatura_C":23.05,"tipo":"observado"},{"timestamp":"2026-06-21 17:00","estacao":"P2","vazao_m3s":1.977,"salinidade_psu":3.629,"nivel_m":0.869,"od_mgL":6.581,"temperatura_C":24.48,"tipo":"observado"},{"timestamp":"2026-06-21 17:00","estacao":"P3","vazao_m3s":3.106,"salinidade_psu":0.28,"nivel_m":1.383,"od_mgL":8.885,"temperatura_C":21.8,"tipo":"observado"},{"timestamp":"2026-06-21 18:00","estacao":"P1","vazao_m3s":2.783,"salinidade_psu":9.198,"nivel_m":1.259,"od_mgL":7.61,"temperatura_C":23.09,"tipo":"observado"},{"timestamp":"2026-06-21 18:00","estacao":"P2","vazao_m3s":2.111,"salinidade_psu":4.575,"nivel_m":0.975,"od_mgL":6.412,"temperatura_C":24.18,"tipo":"observado"},{"timestamp":"2026-06-21 18:00","estacao":"P3","vazao_m3s":3.229,"salinidade_psu":1.378,"nivel_m":1.487,"od_mgL":8.893,"temperatura_C":22.09,"tipo":"observado"},{"timestamp":"2026-06-21 19:00","estacao":"P1","vazao_m3s":2.861,"salinidade_psu":9.783,"nivel_m":1.338,"od_mgL":8.04,"temperatura_C":23.22,"tipo":"observado"},{"timestamp":"2026-06-21 19:00","estacao":"P2","vazao_m3s":2.48,"salinidade_psu":4.966,"nivel_m":1.046,"od_mgL":6.327,"temperatura_C":24.31,"tipo":"observado"},{"timestamp":"2026-06-21 19:00","estacao":"P3","vazao_m3s":3.231,"salinidade_psu":1.863,"nivel_m":1.541,"od_mgL":8.84,"temperatura_C":21.93,"tipo":"observado"},{"timestamp":"2026-06-21 20:00","estacao":"P1","vazao_m3s":3.026,"salinidade_psu":11.373,"nivel_m":1.352,"od_mgL":7.777,"temperatura_C":23.27,"tipo":"observado"},{"timestamp":"2026-06-21 20:00","estacao":"P2","vazao_m3s":2.348,"salinidade_psu":6.098,"nivel_m":1.076,"od_mgL":6.35,"temperatura_C":24.77,"tipo":"observado"},{"timestamp":"2026-06-21 20:00","estacao":"P3","vazao_m3s":3.377,"salinidade_psu":1.933,"nivel_m":1.568,"od_mgL":8.345,"temperatura_C":22.34,"tipo":"observado"},{"timestamp":"2026-06-21 21:00","estacao":"P1","vazao_m3s":3.246,"salinidade_psu":10.243,"nivel_m":1.388,"od_mgL":7.797,"temperatura_C":23.49,"tipo":"observado"},{"timestamp":"2026-06-21 21:00","estacao":"P2","vazao_m3s":2.439,"salinidade_psu":5.854,"nivel_m":1.048,"od_mgL":6.504,"temperatura_C":24.71,"tipo":"observado"},{"timestamp":"2026-06-21 21:00","estacao":"P3","vazao_m3s":3.59,"salinidade_psu":2.536,"nivel_m":1.501,"od_mgL":8.486,"temperatura_C":22.48,"tipo":"observado"},{"timestamp":"2026-06-21 22:00","estacao":"P1","vazao_m3s":3.317,"salinidade_psu":9.55,"nivel_m":1.399,"od_mgL":7.194,"temperatura_C":23.8,"tipo":"observado"},{"timestamp":"2026-06-21 22:00","estacao":"P2","vazao_m3s":2.303,"salinidade_psu":5.124,"nivel_m":1.0,"od_mgL":6.01,"temperatura_C":24.78,"tipo":"observado"},{"timestamp":"2026-06-21 22:00","estacao":"P3","vazao_m3s":3.377,"salinidade_psu":1.023,"nivel_m":1.478,"od_mgL":8.417,"temperatura_C":22.83,"tipo":"observado"},{"timestamp":"2026-06-21 23:00","estacao":"P1","vazao_m3s":3.035,"salinidade_psu":8.456,"nivel_m":1.249,"od_mgL":7.42,"temperatura_C":24.07,"tipo":"observado"},{"timestamp":"2026-06-21 23:00","estacao":"P2","vazao_m3s":2.06,"salinidade_psu":4.139,"nivel_m":0.963,"od_mgL":5.881,"temperatura_C":25.54,"tipo":"observado"},{"timestamp":"2026-06-21 23:00","estacao":"P3","vazao_m3s":3.139,"salinidade_psu":1.18,"nivel_m":1.437,"od_mgL":8.22,"temperatura_C":22.97,"tipo":"observado"}];
ALL_DATA = DADOS;
DADOS_ORIGINAIS = JSON.parse(JSON.stringify(DADOS));
render(120);

(function () {
  const el = document.getElementById('viewersCount');
  if (!el) return;
  let count = 6 + Math.floor(Math.random() * 6); 
  el.textContent = count;
  setInterval(() => {
    const delta = Math.floor(Math.random() * 3) - 1; 
    count = Math.max(2, Math.min(24, count + delta));
    el.textContent = count;
  }, 4000); 
})();
