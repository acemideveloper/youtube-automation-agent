'use strict';

const state = { summary: null, videos: [], recommendations: [], upstream: null };
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const key = () => localStorage.getItem('yaa_api_key') || '';

async function api(url, options = {}, retry = true) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(key() ? { 'x-api-key': key() } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && retry) {
    const value = prompt('Dashboard API_KEY değerini girin. Sadece bu tarayıcıda saklanır.', key());
    if (value !== null) {
      localStorage.setItem('yaa_api_key', value.trim());
      return api(url, options, false);
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText || 'İstek başarısız');
  return data.result ?? data;
}

function toast(message, type = '') {
  const el = $('#toast'); el.textContent = message; el.className = `toast ${type}`.trim();
  setTimeout(() => el.classList.add('hidden'), 3500);
}

async function refresh() {
  try {
    const [summary, videos, recommendations, upstream] = await Promise.all([
      api('/api/analyst/summary'), api('/api/analyst/videos?limit=1000'), api('/api/analyst/recommendations?limit=100'), api('/api/analyst/upstream-update').catch(() => null)
    ]);
    state.summary = summary; state.videos = videos || []; state.recommendations = recommendations || []; state.upstream = upstream;
    render();
  } catch (error) {
    $('#notice').textContent = error.message; $('#notice').classList.remove('hidden');
  }
}

function render() {
  const s = state.summary || {};
  const channel = s.catalog?.channel;
  $('#channel-subtitle').textContent = channel ? `${channel.title} · read-only analysis` : 'Önce kanalı senkronize edin.';
  $('#stat-videos').textContent = s.measurementCoverage?.catalogVideos ?? state.videos.length;
  $('#stat-measured').textContent = s.measurementCoverage?.measuredVideos ?? 0;
  $('#stat-packaging').textContent = s.diagnoses?.packagingOpportunities?.length ?? 0;
  $('#stat-hook').textContent = s.diagnoses?.hookOpportunities?.length ?? 0;
  $('#stat-recs').textContent = s.recommendationSummary?.pending ?? 0;
  renderDiagnosis('#packaging-list', s.diagnoses?.packagingOpportunities || [], 'Başlık / thumbnail testine aday');
  renderDiagnosis('#hook-list', s.diagnoses?.hookOpportunities || [], 'Hook ve açılışı incele');
  renderDiagnosis('#strong-list', s.diagnoses?.strongPatterns || [], 'Pattern’i koru ve tekrar dene');
  renderSystem(); renderVideos(); renderRecommendations();
}

function renderDiagnosis(selector, items, label) {
  const el = $(selector);
  if (!items.length) { el.innerHTML = `<div class="item"><p>Henüz yeterli kanıt yok.</p></div>`; return; }
  el.innerHTML = items.slice(0,8).map(item => `
    <button class="item" data-video="${escapeHTML(item.videoId)}" style="text-align:left;color:inherit;cursor:pointer">
      <div class="item-row"><strong>${escapeHTML(item.title)}</strong><span class="status ${escapeHTML(item.confidence)}">${escapeHTML(item.confidence || '—')}</span></div>
      <p>${escapeHTML(label)} · ${escapeHTML(item.measurementWindow || '')} · cohort ${escapeHTML(item.benchmark?.cohortSize ?? '—')}</p>
    </button>`).join('');
}

function renderSystem() {
  const u = state.upstream;
  const coverage = state.summary?.measurementCoverage || {};
  $('#system-card').innerHTML = `
    <p><strong class="safe">● Analyst Mode</strong> — YouTube yazma işlemleri kapalı.</p>
    <p>Snapshot: <strong>${escapeHTML(coverage.snapshots ?? 0)}</strong> · Kanıt pencereleri: ${escapeHTML(Object.keys(coverage.byWindow || {}).join(', ') || 'henüz yok')}</p>
    <p>Upstream: ${u ? (u.updateAvailable ? `<strong>Yeni commit bulundu</strong>` : '<strong>Güncel</strong>') : 'henüz kontrol edilmedi'}.</p>
    <p class="muted">Upstream kontrolü kod indirmez veya otomatik merge yapmaz.</p>`;
}

function renderVideos() {
  const term = $('#video-search').value.trim().toLowerCase();
  const videos = state.videos.filter(v => !term || String(v.title).toLowerCase().includes(term));
  $('#video-table').innerHTML = videos.map(v => `
    <tr>
      <td class="video-title"><strong>${escapeHTML(v.title)}</strong><span class="meta">${escapeHTML(v.videoId)}</span></td>
      <td>${escapeHTML(v.creatorContentType || v.surfaceHint || '—')}</td>
      <td>${escapeHTML(v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : '—')}</td>
      <td>${escapeHTML(v.viewCount?.toLocaleString?.() ?? v.viewCount ?? '—')}</td>
      <td><button class="button small secondary" data-video="${escapeHTML(v.videoId)}">Analiz</button></td>
    </tr>`).join('');
}

function renderRecommendations() {
  const el = $('#recommendation-list');
  if (!state.recommendations.length) { el.innerHTML = '<div class="item"><p>Henüz öneri üretilmedi. Bir video analizinden “Gemini önerisi” çalıştırabilirsiniz.</p></div>'; return; }
  el.innerHTML = state.recommendations.map(rec => `
    <article class="item">
      <div class="item-row"><strong>${escapeHTML(rec.action)}</strong><span class="status ${escapeHTML(rec.status)}">${escapeHTML(rec.status)}</span></div>
      <p>${escapeHTML(rec.category)} · hedef: ${escapeHTML(rec.targetMetric || '—')}${rec.outcome?.status ? ` · outcome: ${escapeHTML(rec.outcome.status)}` : ''}</p>
      <div class="rec-actions">
        ${rec.status !== 'applied' ? `<button class="button small" data-rec-status="applied" data-rec="${escapeHTML(rec.id)}">Uyguladım</button>` : `<button class="button small secondary" data-evaluate="${escapeHTML(rec.id)}">Sonucu ölç</button>`}
        <button class="button small ghost" data-rec-status="deferred" data-rec="${escapeHTML(rec.id)}">Ertele</button>
        <button class="button small ghost" data-rec-status="rejected" data-rec="${escapeHTML(rec.id)}">Reddet</button>
      </div>
    </article>`).join('');
}

async function openVideo(videoId) {
  try {
    const result = await api(`/api/analyst/videos/${encodeURIComponent(videoId)}/diagnosis?window=28d`);
    const d = result.diagnosis || {};
    const target = d.benchmark?.target || {};
    $('#dialog-title').textContent = result.video.title;
    $('#dialog-body').innerHTML = `
      ${result.video.thumbnailUrl ? `<img class="thumb" src="${escapeHTML(result.video.thumbnailUrl)}" alt="">` : ''}
      <div class="evidence">
        <div><small>CTR</small><strong>${fmt(target.ctr, '%')}</strong></div>
        <div><small>Retention</small><strong>${fmt(target.retention, '%')}</strong></div>
        <div><small>Impressions</small><strong>${escapeHTML(target.impressions?.toLocaleString?.() ?? '—')}</strong></div>
      </div>
      <div class="item"><div class="item-row"><strong>${escapeHTML(d.diagnosis || result.status || 'Kanıt bekleniyor')}</strong><span class="status ${escapeHTML(d.confidence || '')}">${escapeHTML(d.confidence || '')}</span></div><p>${escapeHTML((d.observations || d.reasons || []).join(' '))}</p></div>
      <div class="advice-section"><button id="generate-advice" class="button" data-video-id="${escapeHTML(videoId)}">Gemini: başlık + thumbnail önerisi</button><div id="advice-result"></div></div>`;
    $('#video-dialog').showModal();
  } catch (error) { toast(error.message, 'error'); }
}

async function generateAdvice(videoId) {
  const button = $('#generate-advice'); button.disabled = true; button.textContent = 'Analiz ediliyor…';
  try {
    const result = await api(`/api/analyst/videos/${encodeURIComponent(videoId)}/advice`, { method:'POST', body: JSON.stringify({ window:'28d' }) });
    const a = result.advice?.output || result.advice || {};
    $('#advice-result').innerHTML = `
      <div class="advice-section"><h3>Özet</h3><p class="meta">${escapeHTML(a.summary || '')}</p></div>
      <div class="advice-section"><h3>Başlık alternatifleri</h3><ul>${(a.title?.alternatives || []).map(x => `<li><strong>${escapeHTML(x.title)}</strong> — ${escapeHTML(x.rationale)}</li>`).join('')}</ul></div>
      <div class="advice-section"><h3>Thumbnail</h3><p class="meta">${escapeHTML(a.thumbnail?.assessment || '')}</p><ul>${(a.thumbnail?.issues || []).map(x => `<li>${escapeHTML(x)}</li>`).join('')}</ul></div>
      <div class="advice-section"><h3>Sonraki adım</h3><p class="meta">${escapeHTML(a.nextAction?.action || '')} — ${escapeHTML(a.nextAction?.reason || '')}</p></div>`;
    await refresh();
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Gemini: başlık + thumbnail önerisi'; }
}

function fmt(value, suffix='') { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}${suffix}` : '—'; }

async function mutateRecommendation(id, status) {
  try {
    const note = status === 'applied' ? prompt('Ne değiştirdiniz? (örn. başlık + thumbnail)', '') : '';
    await api(`/api/analyst/recommendations/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify({ status, note }) });
    toast('Öneri güncellendi.'); await refresh();
  } catch (error) { toast(error.message, 'error'); }
}

async function evaluate(id) {
  try { const r = await api(`/api/analyst/recommendations/${encodeURIComponent(id)}/evaluate`, { method:'POST', body:'{}' }); toast(`Outcome: ${r.status || 'kaydedildi'}`); await refresh(); }
  catch (error) { toast(error.message, 'error'); }
}

$('#api-key-button').addEventListener('click', () => { const v = prompt('API_KEY', key()); if (v !== null) localStorage.setItem('yaa_api_key', v.trim()); });
$('#sync-button').addEventListener('click', async e => { e.currentTarget.disabled=true; try { const r=await api('/api/analyst/sync',{method:'POST',body:JSON.stringify({maxVideos:500})}); toast(`${r.updatedCount} video senkronize edildi.`); await refresh(); } catch(err){toast(err.message,'error')} finally{e.currentTarget.disabled=false} });
$('#measure-button').addEventListener('click', async e => { e.currentTarget.disabled=true; try { const r=await api('/api/analyst/measure',{method:'POST',body:JSON.stringify({limit:10})}); toast(`${r.completed}/${r.attempted} ölçüm tamamlandı.`); await refresh(); } catch(err){toast(err.message,'error')} finally{e.currentTarget.disabled=false} });
$('#video-search').addEventListener('input', renderVideos);
$('#dialog-close').addEventListener('click', () => $('#video-dialog').close());
document.addEventListener('click', event => {
  const video = event.target.closest('[data-video]'); if (video) openVideo(video.dataset.video);
  const advice = event.target.closest('#generate-advice'); if (advice) generateAdvice(advice.dataset.videoId);
  const rec = event.target.closest('[data-rec-status]'); if (rec) mutateRecommendation(rec.dataset.rec, rec.dataset.recStatus);
  const evalButton = event.target.closest('[data-evaluate]'); if (evalButton) evaluate(evalButton.dataset.evaluate);
});

refresh();
setInterval(refresh, 60000);
