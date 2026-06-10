/*
letmesee.you — tep-engine.js  v39
TEP integration layer — computes CR(h_t) and TEP state.

CR(h_t) = clip( (ln(RMSSD) - 2.0) / 2.5, 0, 1 )
  Source: TEPMat CzłowiekAI v1.1, verified on WESAD N=15.
  STRESS=0.596, BASELINE=0.751, AMUSEMENT=0.776.

TEP thresholds from K74 WhitePaper v3:
  low=0.40  → gradR=0.500 (chaotic history) → NOT YET
  high=0.65 → gradR=0.179 (stable history)  → NOW
  viability=96% at this configuration (best of 27 tested).

Remote compute: POST /compute-cr on TEP server (Render).
Falls back to local JS computation if server is unreachable.

Non-medical wellness guidance only. Not a clinical device.
*/

(function(){
  const clamp = (v, min=0, max=1) => Math.max(min, Math.min(max, v));

  // TEP server URL — update after Render deployment
  const TEP_SERVER = 'https://letmeseeyou-serwer.onrender.com';

  // ── Local compute fallback ──
  // Used when server is unreachable. Identical formula to server.

  function crFromRMSSD(rmssd){
    return clamp((Math.log(Math.max(rmssd, 1)) - 2.0) / 2.5);
  }

  function eyeContribution(eye){
    if(!eye || !eye.available) return 0.62;
    const load    = eye.load    ?? 0.35;
    const focus   = eye.focus   ?? 0.65;
    const fatigue = eye.fatigue ?? 0.15;
    const arousal = eye.arousal ?? 0.20;
    return clamp(
      focus   * 0.38 +
      (1-load)    * 0.28 +
      (1-fatigue) * 0.20 +
      (1-arousal) * 0.14
    );
  }

  function sleepContribution(hours){
    if(hours === null || hours === undefined || isNaN(hours)) return 0.65;
    return clamp((hours - 4) / 4);
  }

  function bodySignalContribution(signals){
    if(!Array.isArray(signals) || signals.includes('none')) return 0;
    return clamp(signals.filter(Boolean).length / 5);
  }

  function computeLocal(input){
    const rmssd   = Number(input.rmssd  ?? 48);
    const sleep   = Number(input.sleep  ?? 7);
    const eye     = input.eye    || {};
    const signals = Array.isArray(input.signals) ? input.signals : [];

    const crHRV    = crFromRMSSD(rmssd);
    const eyeC     = eyeContribution(eye);
    const sleepC   = sleepContribution(sleep);
    const bodyLoad = bodySignalContribution(signals);

    const cr = clamp(
      crHRV  * 0.42 +
      eyeC   * 0.30 +
      sleepC * 0.16 +
      (1 - bodyLoad) * 0.12
    );

    const bodyLoadPct = Math.round(clamp(
      (1 - crHRV)  * 0.34 +
      (eye.available ? (eye.load    ?? 0.25) * 0.24 : 0) +
      (eye.available ? (eye.fatigue ?? 0.10) * 0.16 : 0) +
      (1 - sleepC) * 0.16 +
      bodyLoad     * 0.10
    ) * 100);

    const state =
      cr >= 0.65 ? 'NOW' :
      cr >= 0.40 ? 'PARTIAL' :
      'NOT_YET';

    const contextNote =
      state === 'NOW'
        ? 'Regulation supports action. Full effort available across most disciplines.'
        : state === 'PARTIAL'
          ? 'System is stabilising. Smaller, reversible effort only.'
          : 'Regulation below threshold. Rest and recovery first.';

    return { cr, crHRV, eyeC, sleepC, bodyLoad, bodyLoadPct, state,
             now: state==='NOW', partial: state==='PARTIAL', notYet: state==='NOT_YET',
             contextNote, explanation: contextNote };
  }

  // ── Remote compute — calls TEP server ──
  // Falls back to local if server is unavailable or slow (>3s timeout).
  async function compute(input){
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 3000);
      const res  = await fetch(TEP_SERVER + '/compute-cr', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          rmssd:   input.rmssd   ?? 48,
          sleep:   input.sleep   ?? 7,
          signals: input.signals ?? [],
          eye:     input.eye     ?? {}
        }),
        signal: ctrl.signal
      });
      clearTimeout(tid);
      if(res.ok) return await res.json();
    } catch(e) {
      // Server unreachable — fall through to local
    }
    return computeLocal(input);
  }

  function trajectory(hist){
    if(!hist || hist.length < 8) return 'flat';
    const s = hist[hist.length-1] - hist[hist.length-8];
    return s > 0.05 ? 'up' : s < -0.05 ? 'down' : 'flat';
  }

  function readSessionSignals(){
    let sigs = [];
    try{ sigs = JSON.parse(sessionStorage.getItem('signals') || '[]'); }catch(e){}
    return sigs;
  }

  async function applyToDashboard(){
    if(!window.S) return null;

    const eye     = window.LMS_EYE ? window.LMS_EYE.getMetrics() : null;
    const signals = (S.signals && S.signals.length) ? S.signals : readSessionSignals();
    const sleep   = Number(S.sleep || sessionStorage.getItem('sleep') || 7);

    let rmssd, hrvSource, _rppg = null;
    const hasPolar = sessionStorage.getItem('polarOk') === '1' && sessionStorage.getItem('heartLive') === '1' && Number(S.rmssd) > 0;
    if(hasPolar){
      rmssd = Number(S.rmssd);
      hrvSource = "polar";
    } else {
      _rppg = (window.LMS_EYE && typeof window.LMS_EYE.getRPPG === 'function') ? window.LMS_EYE.getRPPG() : null;
      if(_rppg && _rppg.available && _rppg.confidence > 0.05){
        rmssd = Number(_rppg.rmssd) || 48;
        hrvSource = "camera-estimated";
      } else if(eye && eye.available && eye.irisAvailable !== false){
        const eyeC_hr = eyeContribution(eye);
        rmssd = Math.round(Math.exp(eyeC_hr * 2.5 + 2.0));
        const estHR = Math.round(68 + (eye.arousal || 0.2) * 30 + (eye.fatigue || 0.1) * 12);
        S.hr    = Math.min(120, Math.max(45, estHR));
        S.rmssd = rmssd;
        sessionStorage.setItem('eyeEstHeart', '1');
        sessionStorage.removeItem('rppgActive');
        hrvSource = "eye-estimated";
      } else {
        rmssd = Number(S.rmssd || 48);
        hrvSource = "fallback";
      }
    }

    const result = await compute({ rmssd, sleep, eye, signals });
    result.hrvSource = hrvSource;

    if(hrvSource === 'camera-estimated' && _rppg){
      S.rmssd = _rppg.rmssd;
      S.hr    = _rppg.hr;
      sessionStorage.setItem('rppgActive', '1');
      sessionStorage.removeItem('eyeEstHeart');
    } else if(hrvSource === 'polar'){
      sessionStorage.removeItem('rppgActive');
      sessionStorage.removeItem('eyeEstHeart');
    } else if(hrvSource !== 'eye-estimated'){
      sessionStorage.removeItem('rppgActive');
      sessionStorage.removeItem('eyeEstHeart');
    }

    S.cr  = result.cr;
    S.bl  = result.bodyLoadPct;
    S.sleep   = sleep;
    S.signals = signals;
    S.hist = Array.isArray(S.hist) ? S.hist : [];
    S.hist.push(S.cr);
    if(S.hist.length > 80) S.hist = S.hist.slice(-80);
    S.traj = trajectory(S.hist);
    S.tep  = result;

    if(eye && eye.available){
      S.el  = eye.load;
      S.ef  = eye.focus;
      S.eft = eye.fatigue;
      S.ea  = eye.arousal;
    }

    if(typeof updateEyeBar === 'function') updateEyeBar();

    const ctx = document.getElementById('agent-ctx');
    if(ctx) ctx.textContent = (S.mode || 'reading') + ' · ' + result.state.toLowerCase().replace('_',' ');

    window.dispatchEvent(new CustomEvent('letmesee:tep', { detail: result }));
    return result;
  }

  async function getAgentState(){
    if(window.S) await applyToDashboard();
    const eye = window.LMS_EYE ? window.LMS_EYE.getMetrics() : null;
    const s   = window.S || {};
    return {
      tep:         s.tep || null,
      cr:          s.cr,
      crHRV:       s.tep ? s.tep.crHRV : null,
      state:       s.tep ? s.tep.state : null,
      trajectory:  s.traj,
      bodyLoadPct: s.bl,
      rmssd:       s.rmssd,
      heartRate:   s.hr,
      sleep:       s.sleep,
      bodySignals: s.signals || readSessionSignals(),
      eye: eye ? {
        available:    eye.available,
        load:         eye.load,
        focus:        eye.focus,
        fatigue:      eye.fatigue,
        arousal:      eye.arousal,
        blinkRate:    eye.blinkRate,
        gazeStability:eye.gazeStability,
        note:         eye.note
      } : null,
      mode: s.mode,
      hrvSource:    s.tep ? s.tep.hrvSource : null,
      estimatedHRV: s.tep ? s.tep.hrvSource === "camera-estimated" : false,
    };
  }

  window.LMS_TEP = { compute, applyToDashboard, getAgentState };
  setInterval(applyToDashboard, 1500);
})();
