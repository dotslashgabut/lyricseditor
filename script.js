// Database (IndexedDB) for True Persistence
const DB_NAME = 'LyricsEditorDB', DB_STORE = 'files';
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function saveFileToDB(key, file) {
    try {
        const db = await openDB();
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(file, key);
        return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch(e) { console.error("DB Save Failed", e); }
}
async function getFileFromDB(key) {
    try {
        const db = await openDB();
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
    } catch(e) { return null; }
}
async function clearDB() {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
}
async function deleteFileFromDB(key) {
    try {
        const db = await openDB();
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
    } catch(e) { console.error("DB Delete Failed", e); }
}

// Global State
let audio = new Audio(), lines = [];
let currentTime = 0, duration = 0, rafId = null, activeLineId = null, lockedWord = null;
let isPlaying = false, isRepeat = false, isWordRepeat = false, isSongRepeat = false;
let isWaveformEnabled = true, isWordHighlightEnabled = true;
let audioFullname = '', lyricsFullname = '';
let lastAudioFile = null, lastLyricsFile = null;
let history = [{lines:[], audioFN:'', lyricsFN:'', audioFull:'', lyricsFull:'', origFN:'lyrics'}], histIdx = 0;
let lastImportFormat = 'lrc', audioFilename = '', lyricsFilename = '', originalFilename = 'lyrics', editingLine = null;
let audioBuffer = null, waveformCache = new Map(), waveformObserver = null;
let smartToolMode = 'merge'; // 'merge', 'replace', or 'combined'
let trackEls = {}; // lineId -> {tr, pi, wordEls} cache, rebuilt each render
let lastRenderedActiveId = null, lastRenderedPlaying = false;

const $ = id => document.getElementById(id);
const playBtn=$('btn-play-pause'), stopBtn=$('btn-stop'), repeatBtn=$('btn-repeat');
const timeDisp=$('time-display'), progFill=$('progress-fill'), volSlider=$('volume-slider');
const container=$('timeline-container'), statL=$('stat-lines'), statW=$('stat-words');

// ── Utilities ──
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Toast notifications (non-blocking replacement for alert())
const TOAST_ICONS = { info: 'fa-info-circle', success: 'fa-check-circle', warning: 'fa-exclamation-triangle', error: 'fa-times-circle' };
function showToast(msg, type = 'info', duration = 2800) {
  let box = $('toast-container');
  if (!box) { alert(msg); return; }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i class="fas ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i><span>${escapeHtml(msg)}</span>`;
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 260);
  }, duration);
}
window.showToast = showToast;

// Small persisted preferences (separate from session/history)
const PREFS_KEY = 'lyricseditor_prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch(e) { return {}; }
}
function savePrefs(patch) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); } catch(e) {}
}

// Modal helpers
function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
}

function fmt(s) {
  if(isNaN(s))return'00:00.000';
  const m=Math.floor(s/60),sc=Math.floor(s%60),ms=Math.floor((s%1)*1000);
  return`${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}

// History
function pushHistory() {
  const snap = {
    lines: JSON.parse(JSON.stringify(lines)),
    audioFN: audioFilename,
    lyricsFN: lyricsFilename,
    audioFull: audioFullname,
    lyricsFull: lyricsFullname,
    origFN: originalFilename
  };
  
  // Don't push if it's the same as the current head (to avoid redundant undo steps)
  const current = history[histIdx];
  // More robust check for changes
  if (current && JSON.stringify(current.lines) === JSON.stringify(snap.lines)) {
      // Still update filenames if they changed even if lines didn't
      if (current.audioFN === snap.audioFN && current.lyricsFN === snap.lyricsFN) {
        return;
      }
  }

  history = history.slice(0, histIdx + 1);
  history.push(snap);
  if (history.length > 50) history.shift();
  histIdx = history.length - 1;
  saveSession();
  updateUndoRedoUI();
}

function updateUndoRedoUI() {
  const u = $('btn-undo'), r = $('btn-redo');
  if (u) u.disabled = histIdx <= 0;
  if (r) r.disabled = histIdx >= history.length - 1;
}

function saveSession() {
    try {
        const session = {
            lines: lines,
            audioFN: audioFilename,
            lyricsFN: lyricsFilename,
            audioFull: audioFullname,
            lyricsFull: lyricsFullname,
            origFN: originalFilename,
            duration: duration,
            lastImportFormat: lastImportFormat,
            isWaveformEnabled: isWaveformEnabled
        };
        localStorage.setItem('lyricseditor_session', JSON.stringify(session));

        // Persist history stack and index as well
        const histSession = {
            history: history,
            histIdx: histIdx
        };
        localStorage.setItem('lyricseditor_history', JSON.stringify(histSession));
    } catch(e) { console.error("Auto-save failed", e); }
}

function loadSession() {
    const data = localStorage.getItem('lyricseditor_session');
    if (!data) return false;
    try {
        const snap = JSON.parse(data);
        lines = snap.lines || [];
        audioFilename = snap.audioFN || '';
        lyricsFilename = snap.lyricsFN || '';
        audioFullname = snap.audioFull || '';
        lyricsFullname = snap.lyricsFull || '';
        originalFilename = snap.origFN || 'lyrics';
        duration = snap.duration || 0;
        lastImportFormat = snap.lastImportFormat || 'lrc';
        if (snap.isWaveformEnabled !== undefined) {
            isWaveformEnabled = snap.isWaveformEnabled;
            const btn = $('btn-toggle-waveform');
            if (btn) btn.style.color = isWaveformEnabled ? 'var(--accent)' : 'var(--text-muted)';
        }
        
        // Restore history stack and current index if they exist
        const histData = localStorage.getItem('lyricseditor_history');
        if (histData) {
            try {
                const parsedHist = JSON.parse(histData);
                if (parsedHist && Array.isArray(parsedHist.history) && parsedHist.history.length > 0) {
                    history = parsedHist.history;
                    histIdx = typeof parsedHist.histIdx === 'number' ? parsedHist.histIdx : history.length - 1;
                } else {
                    initializeFallbackHistory();
                }
            } catch(e) {
                initializeFallbackHistory();
            }
        } else {
            initializeFallbackHistory();
        }

        function initializeFallbackHistory() {
            history = [{
                lines: JSON.parse(JSON.stringify(lines)),
                audioFN: audioFilename,
                lyricsFN: lyricsFilename,
                audioFull: audioFullname,
                lyricsFull: lyricsFullname,
                origFN: originalFilename
            }];
            histIdx = 0;
        }
        
        updateFileUI();
        renderTimeline();
        updateDisplay();
        return true;
    } catch(e) {
        console.error("Session load failed", e);
        return false;
    }
}

// Modal History (Local to Edit Modal)
let modalHistory = [];
let modalHistIdx = -1;

function pushModalHistory() {
  const val = $('edit-text-input').value;
  if (modalHistIdx >= 0 && modalHistory[modalHistIdx] === val) return;
  modalHistory = modalHistory.slice(0, modalHistIdx + 1);
  modalHistory.push(val);
  if (modalHistory.length > 100) modalHistory.shift();
  modalHistIdx = modalHistory.length - 1;
}

function modalUndo() {
  if (modalHistIdx > 0) {
    modalHistIdx--;
    $('edit-text-input').value = modalHistory[modalHistIdx];
    updateEditHighlighter();
  }
}

function modalRedo() {
  if (modalHistIdx < modalHistory.length - 1) {
    modalHistIdx++;
    $('edit-text-input').value = modalHistory[modalHistIdx];
    updateEditHighlighter();
  }
}

function applySnapshot(snap) {
  if (!snap) return;
  lines = JSON.parse(JSON.stringify(snap.lines));
  audioFilename = snap.audioFN;
  lyricsFilename = snap.lyricsFN;
  audioFullname = snap.audioFull;
  lyricsFullname = snap.lyricsFull;
  originalFilename = snap.origFN;
  
  // Clear waveform cache to ensure correct redrawing on undo/redo
  waveformCache.clear();
  
  updateFileUI();
  renderTimeline();
  updateDisplay();
  saveSession(); // Keep localStorage in sync with undo/redo
  updateUndoRedoUI();
}

function undo() { cancelNudgeHistory(); if(histIdx>0){histIdx--; applySnapshot(history[histIdx]);} }
function redo() { cancelNudgeHistory(); if(histIdx<history.length-1){histIdx++; applySnapshot(history[histIdx]);} }

function updateFileUI() {
    const adisp = $('audio-filename-display'), areload = $('audio-reload-display');
    if (audioFullname) {
        adisp.style.display = 'inline-flex';
        adisp.querySelector('.fname').textContent = audioFullname;
        adisp.title = `Audio: ${audioFullname}`;
        areload.style.display = 'none';
    } else {
        adisp.style.display = 'none';
        // Always show reload/load icon if slot is empty
        areload.style.display = 'inline-flex';
        areload.title = lastAudioFile ? "Reload Last Audio" : "Load Audio";
    }

    const ldisp = $('lyrics-filename-display'), lreload = $('lyrics-reload-display');
    if (lyricsFullname) {
        ldisp.style.display = 'inline-flex';
        ldisp.querySelector('.fname').textContent = lyricsFullname;
        ldisp.title = `Lyrics: ${lyricsFullname}`;
        lreload.style.display = 'none';
    } else {
        ldisp.style.display = 'none';
        // Always show reload/load icon if slot is empty
        lreload.style.display = 'inline-flex';
        lreload.title = lastLyricsFile ? "Reload Last Lyrics" : "Load Lyrics";
    }
}

// Render
function renderTimeline() {
  normalizeLines(lines);
  const oldScroll = container.scrollTop;
  // Capture currently selected IDs before clearing
  const previouslySelected = new Set();
  document.querySelectorAll('.line-checkbox:checked').forEach(cb => {
    const tr = cb.closest('.timeline-track');
    if (tr) previouslySelected.add(Number(tr.id.replace('tc-', '')));
  });

  container.innerHTML = '';
  trackEls = {};
  if(!lines.length){
    container.innerHTML=`
      <div class="placeholder-text">
        <i class="fas fa-cloud-upload-alt" style="font-size: 36px; margin-bottom: 14px; opacity: 0.5;"></i><br>
        <span style="font-size:17px; font-weight:500; color:var(--text-main); opacity:0.85;">Load audio and lyrics to start editing</span><br>
        <span style="font-size:12.5px; opacity:0.7;">or Drag &amp; Drop files anywhere</span>
        <div class="tips-grid">
            <span class="tip-chip"><i class="fas fa-hand-pointer"></i> Drag words or boundaries to adjust timings</span>
            <span class="tip-chip"><i class="fas fa-keyboard"></i> Press <kbd>K</kbd> for keyboard shortcuts</span>
            <span class="tip-chip"><i class="fas fa-bolt"></i> <kbd>[</kbd> <kbd>]</kbd> nudge all timings</span>
            <span class="tip-chip"><i class="fas fa-file-audio"></i> WAV / FLAC give sample-accurate sync</span>
        </div>
        <div style="margin-top: 28px; font-size: 11px;">
            <a href="https://github.com/dotslashgabut/lyricseditor" target="_blank" class="github-link">
                <i class="fab fa-github" style="font-size: 16px;"></i> github.com/dotslashgabut/lyricseditor
            </a>
        </div>
      </div>`;
    statL.textContent=0;statW.textContent=0;return;
  }
  let tw=0;
  
  container.appendChild(createAddLineBtn(0));
  
  lines.forEach((line,idx) => {
    if(!line.words)line.words=[];
    tw += line.words.length;
    const ld = Math.max(0.05, (line.endMs - line.startMs)/1000);
    const tr = document.createElement('div');
    const hasBgWords = line.words && line.words.some(w => w.isBackground || w.role === 'x-bg');
    // Check if any words overlap in timing
    function checkOverlap(words) {
      if (!words || words.length <= 1) return false;
      const sorted = [...words].sort((a,b) => a.startMs - b.startMs);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i+1].startMs < sorted[i].endMs - 1) return true;
      }
      return false;
    }
    const hasMainWords = line.words && line.words.some(w => !w.isBackground && w.role !== 'x-bg');
    const hasOverlaps = hasBgWords && (checkOverlap(line.words) || hasMainWords);
    const isBgLine = line.isBackground || line.role === 'x-bg' || hasBgWords;
    tr.className = 'timeline-track' + (isBgLine ? ' bg-line' : '') + (hasOverlaps ? ' has-overlapping-words' : '') + (line.agent ? ` agent-${line.agent}` : '');
    tr.id = `tc-${line.id}`;
    const isChecked = previouslySelected.has(line.id);
    let badgesHtml = '';
    if (line.agent || line.songPart) {
      badgesHtml += `<div class="track-badges" style="margin-top:3px; display:flex; gap:3px; flex-wrap:wrap; width:100%;">`;
      if (line.agent) {
        badgesHtml += `<span class="agent-badge badge-${escapeHtml(line.agent)}" style="margin-left:0;" title="Vocal Agent: ${escapeHtml(line.agent)}">${escapeHtml(line.agent)}</span>`;
      }
      if (line.songPart) {
        badgesHtml += `<span class="part-badge" style="margin-left:0;" title="Song Part: ${escapeHtml(line.songPart)}">${escapeHtml(line.songPart)}</span>`;
      }
      badgesHtml += `</div>`;
    }
    let rightBadgeHtml = '';
    if (isBgLine) {
      rightBadgeHtml = `<div class="bg-indicator-badge" title="Contains Background Vocals" style="margin-top:3px; font-size:9px; font-weight:700; padding:1px 3px; border-radius:3px; background:rgba(138, 96, 255, 0.15); color:#8a60ff; text-transform:uppercase; border:1px solid rgba(138, 96, 255, 0.35); text-align:center; max-width:fit-content; line-height:1;">BG</div>`;
    }
    tr.innerHTML=`<div class="track-controls"><input type="checkbox" class="line-checkbox" data-id="${line.id}" ${isChecked ? 'checked' : ''} style="cursor:pointer; margin-right:4px;" title="Select this line"><span style="color:var(--text-muted);font-size:11px;width:14px">${idx+1}</span><button class="track-play-btn" data-start="${line.startMs}" data-end="${line.endMs}"><i class="fas fa-play" style="font-size:9px;margin-left:1px"></i></button><div class="track-info" style="display:flex; flex-direction:column; align-items:flex-start; line-height:1.2;"><div>${fmt(line.startMs/1000)}</div>${badgesHtml}</div></div><div class="track-content" id="trk-${line.id}"><div class="playback-indicator" id="pi-${line.id}"></div></div><div class="track-end-time" style="display:flex; flex-direction:column; align-items:flex-start; line-height:1.2; justify-content:flex-start; min-width:48px;"><div>${fmt(line.endMs/1000)}</div>${rightBadgeHtml}</div><button class="icon-btn track-tag-btn" title="Edit Line Attributes"><i class="fas fa-tag"></i></button><button class="icon-btn track-edit-btn" title="Edit Line Text"><i class="fas fa-edit"></i></button><button class="icon-btn track-delete-btn" title="Delete Line"><i class="fas fa-trash"></i></button>`;
    
    // Observer for lazy-loading waveforms
    const tc = tr.querySelector('.track-content');
    tc.dataset.lineId = line.id;

    const ws = (line.words && line.words.length > 0) ? line.words : [{ id: `pl-${line.id}`, text: (line.text || "").trim() || "[Empty]", startMs: line.startMs, endMs: line.endMs, isPl: true }];
    ws.forEach(w => {
      const el = document.createElement('div');
      const isBgWord = w.isBackground || w.role === 'x-bg';
      el.className = 'word-block' + (isBgWord ? ' bg-word' : '');
      el.id = `w-${w.id}`;
      if(w.isPl) el.style.opacity = '0.7';
      const wText = (w.text || "").trim();
      const isActuallyBlank = !wText || wText === "\\" || wText === "[Empty]";
      if(isActuallyBlank) el.classList.add('blank-word');
      
      let confBadgeHtml = '';
      if (w.confidence !== undefined && w.confidence !== null) {
        const confVal = (w.confidence <= 1) ? Math.round(w.confidence * 100) : Math.round(w.confidence);
        if (confVal < 75) {
          el.classList.add('low-confidence');
          if (confVal < 50) el.classList.add('very-low-confidence');
        }
        confBadgeHtml = `<div class="word-confidence" title="Confidence: ${confVal}%">${confVal}%</div>`;
      }

      el.innerHTML=`<div class="resize-handle left"></div><div class="word-text">${escapeHtml(w.text || "")}</div>${confBadgeHtml}<div class="word-duration">${((w.endMs-w.startMs)/1000).toFixed(3)}s</div><div class="resize-handle right"></div>`;
      tc.appendChild(el);
      posWord(el, w, line);
      bindDrag(el, w, line, tc, w.isPl);
    });
    
    container.appendChild(tr);
    
    tr.querySelector('.track-play-btn').onclick = () => {
      if (activeLineId === line.id && isPlaying) {
        stopPlay();
      } else {
        seekMs(line.startMs);
        if(!isPlaying) togglePlay();
      }
    };
    tr.querySelector('.track-delete-btn').onclick = () => { lines=lines.filter(l=>l.id!==line.id); pushHistory(); renderTimeline(); };
    tr.querySelector('.track-tag-btn').onclick = () => { openLineAttrModal(line); };
    tr.querySelector('.track-edit-btn').onclick = () => {
      editingLine = line;
      // Show \ for blank words so users can preserve them, and format background vocals
      $('edit-text-input').value = formatWordsForEdit(line);
      $('edit-keep-structure').checked = false; // Default OFF
      updateEditHighlighter();
      
      // Initialize Local Modal History
      modalHistory = [];
      modalHistIdx = -1;
      pushModalHistory();

      $('edit-text-modal').style.display = 'flex';
      $('edit-text-input').focus();
      
      // Start active sync for scroll (fixes drag-drop scroll lag)
      startEditSync();
    };
    
    container.appendChild(createAddLineBtn(idx+1));
  });

  // Cache track elements for fast per-frame updates
  lines.forEach(line => {
    const tr = $(`tc-${line.id}`);
    if (!tr) return;
    const wordEls = {};
    (line.words || []).forEach(w => {
      const we = $(`w-${w.id}`);
      if (we) wordEls[w.id] = we;
    });
    trackEls[line.id] = { tr, pi: $(`pi-${line.id}`), wordEls };
  });

  // Lazy load waveforms
  if (audioBuffer && isWaveformEnabled) {
    observeWaveforms();
  }

  statL.textContent=lines.length; statW.textContent=tw;

  let flaggedCount = 0;
  lines.forEach(l => {
    if (l.words) {
      l.words.forEach(w => {
        if (w.confidence !== undefined && w.confidence !== null) {
          const confVal = (w.confidence <= 1) ? Math.round(w.confidence * 100) : Math.round(w.confidence);
          if (confVal < 75) flaggedCount++;
        }
      });
    }
  });
  const flagControls = $('confidence-flag-controls');
  const flagCountEl = $('confidence-flag-text');
  if (flagControls && flagCountEl) {
    if (flaggedCount > 0) {
      flagControls.style.display = 'inline-flex';
      flagCountEl.textContent = `${flaggedCount} Flagged`;
    } else {
      flagControls.style.display = 'none';
    }
  }

  applySearchFilter();
  updateDisplay();
  updateSelectionCount();
  container.scrollTop = oldScroll;
}

let lastJumpedFlaggedIdx = -1;

function jumpFlaggedWord(direction = 1) {
  const flagged = [];
  lines.forEach(l => {
    (l.words || []).forEach(w => {
      if (w.confidence !== undefined && w.confidence !== null) {
        const confVal = (w.confidence <= 1) ? Math.round(w.confidence * 100) : Math.round(w.confidence);
        if (confVal < 75) {
          flagged.push({ line: l, word: w, confVal });
        }
      }
    });
  });

  if (flagged.length === 0) {
    showToast("No low-confidence words found in project.", "info");
    return;
  }

  flagged.sort((a, b) => a.word.startMs - b.word.startMs);

  const currentMs = currentTime;
  let targetIdx = -1;

  // 1. Check if we are currently inside or right at one of the flagged words
  let activeFlaggedIdx = flagged.findIndex(f => 
    (currentMs >= f.word.startMs - 80 && currentMs <= Math.max(f.word.endMs, f.word.startMs + 400) + 80)
  );

  // If recently jumped and audio has only progressed slightly within the same region
  if (activeFlaggedIdx === -1 && lastJumpedFlaggedIdx >= 0 && lastJumpedFlaggedIdx < flagged.length) {
    const lastWord = flagged[lastJumpedFlaggedIdx].word;
    if (currentMs >= lastWord.startMs - 100 && currentMs <= lastWord.startMs + 3000) {
      activeFlaggedIdx = lastJumpedFlaggedIdx;
    }
  }

  if (activeFlaggedIdx !== -1) {
    targetIdx = (activeFlaggedIdx + direction + flagged.length) % flagged.length;
  } else {
    // Playhead is between flagged words (or in a non-flagged section)
    if (direction > 0) {
      targetIdx = flagged.findIndex(f => f.word.startMs > currentMs);
      if (targetIdx === -1) targetIdx = 0; // Wrap to first
    } else {
      for (let i = flagged.length - 1; i >= 0; i--) {
        if (flagged[i].word.endMs < currentMs || flagged[i].word.startMs < currentMs - 100) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) targetIdx = flagged.length - 1; // Wrap to last
    }
  }

  lastJumpedFlaggedIdx = targetIdx;

  const target = flagged[targetIdx];
  seekMs(target.word.startMs);

  const tr = $(`tc-${target.line.id}`);
  if (tr) {
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const we = $(`w-${target.word.id}`);
  if (we) {
    we.classList.add('pulse-focus');
    setTimeout(() => we.classList.remove('pulse-focus'), 1400);
  }

  showToast(`Flagged Word (${targetIdx + 1}/${flagged.length}): "${target.word.text.trim()}" (${target.confVal}% conf)`, 'warning', 2000);
}

function observeWaveforms() {
  if (waveformObserver) waveformObserver.disconnect();
  waveformObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const tc = entry.target;
        const lineId = Number(tc.dataset.lineId);
        const line = lines.find(l => l.id === lineId);
        if (line && audioBuffer && isWaveformEnabled) {
          const success = drawWaveformForLine(tc, line);
          if (success) {
            // Only stop observing if the drawing succeeded (i.e. size was > 0)
            waveformObserver.unobserve(tc);
          }
        }
      }
    });
  }, { 
    root: $('timeline-container'), 
    rootMargin: '200px' // Pre-load waveforms 200px before they enter view
  });

  document.querySelectorAll('.track-content').forEach(tc => {
    waveformObserver.observe(tc);
  });
}

// Global click listener for timeline tracks
container.onclick = (e) => {
    if (e.target.classList.contains('line-checkbox')) {
        updateSelectionCount();
    }
};

function createAddLineBtn(idx) {
  const wr = document.createElement('div');
  wr.className = 'add-line-wrapper';
  wr.innerHTML = `<button class="add-line-btn" title="Add new line here"><i class="fas fa-plus"></i></button>`;
  wr.querySelector('button').onclick = () => insertBlankLine(idx);
  return wr;
}

function insertBlankLine(idx) {
  let start = 0, end = 2000;
  if (idx === 0) {
    if (lines.length > 0) {
      end = lines[0].startMs;
      start = Math.max(0, end - 2000);
    }
  } else if (idx >= lines.length) {
    start = lines[lines.length-1].endMs;
    end = start + 2000;
    if (duration > 0 && end > duration) end = duration;
    if (end <= start) end = start + 2000;
  } else {
    start = lines[idx-1].endMs;
    end = lines[idx].startMs;
    if (end <= start) {
        return showToast("No space between these lines. Use Shift Time or adjust timestamps to create a gap first.", 'warning');
    }
  }
  const maxId = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
  const newLine = {
    id: maxId + 1,
    startMs: start,
    endMs: end,
    text: "",
    words: []
  };
  lines.splice(idx, 0, newLine);
  pushHistory();
  renderTimeline();
}

function posWord(el, w, line) {
  const ld = Math.max(1, line.endMs - line.startMs);
  const leftPercent = Math.max(0, (w.startMs - line.startMs) / ld * 100);
  const widthPercent = Math.max(1, Math.min(100 - leftPercent, (w.endMs - w.startMs) / ld * 100));
  
  el.style.left = leftPercent + '%';
  el.style.width = widthPercent + '%';
  
  const d = el.querySelector('.word-duration');
  if(d) d.textContent = ((w.endMs - w.startMs) / 1000).toFixed(3) + 's';
}

// Drag Logic
function bindDrag(el, word, line, tc, isPl = false) {
  const lh=el.querySelector('.resize-handle.left'), rh=el.querySelector('.resize-handle.right');
  let mode=null, sx=0, snap={}, hasDragged=false;
  const MIN=20; // 20ms min

  const isBg = !!(word.isBackground || word.role === 'x-bg');
  function getSiblings() {
    if (isPl) return [];
    return line.words
      .filter(w => !w.isPl && (!!(w.isBackground || w.role === 'x-bg') === isBg))
      .sort((a, b) => a.startMs - b.startMs);
  }
  function getIdx(siblings){return siblings.findIndex(w=>w.id===word.id);}
  function capture(){
    if (isPl) {
      snap = { i: -1, s: line.startMs, e: line.endMs, lineStartMs: line.startMs, lineEndMs: line.endMs };
      return;
    }
    const siblings = getSiblings();
    const i=getIdx(siblings);
    snap={i, s:word.startMs, e:word.endMs,
      lineStartMs: line.startMs, lineEndMs: line.endMs,
      ps:i>0?siblings[i-1].startMs:null, pe:i>0?siblings[i-1].endMs:null,
      ns:i<siblings.length-1?siblings[i+1].startMs:null, ne:i<siblings.length-1?siblings[i+1].endMs:null};
  }

  // Gesture-scoped listeners: attached on pointerdown, removed on pointerup.
  // (Previously bound permanently per word → thousands of stale document listeners.)
  function startGesture(e, m) {
    mode=m; sx=e.clientX; hasDragged=false; capture();
    try { el.setPointerCapture(e.pointerId); } catch(err) {}
    const tr=el.closest('.timeline-track'); if(tr)tr.classList.add('is-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    window.__dragListeners = (window.__dragListeners || 0) + 2;
  }

  lh.onpointerdown=e=>{e.stopPropagation();startGesture(e,'rl');};
  rh.onpointerdown=e=>{e.stopPropagation();startGesture(e,'rr');};
  el.onpointerdown=e=>{if(e.target.classList.contains('resize-handle'))return;el.classList.add('dragging');startGesture(e,'drag');};

  let wfRafPending = false;
  function scheduleWaveformRedraw() {
    if (wfRafPending) return;
    wfRafPending = true;
    requestAnimationFrame(() => {
      wfRafPending = false;
      const tr = document.getElementById(`tc-${line.id}`);
      if (tr) drawWaveformForLine(tr.querySelector('.track-content'), line);
    });
  }

  function onMove(e){
    if(!mode)return;
    if(Math.abs(e.clientX - sx) > 2) hasDragged = true;
    const tw=tc.getBoundingClientRect().width;
    if(!tw)return;
    const ld=snap.lineEndMs-snap.lineStartMs;
    let dt=Math.round((e.clientX-sx)/tw*ld);
    
    const siblings = getSiblings();
    const i=getIdx(siblings);
    const prev=i>0?siblings[i-1]:null;
    const next=i<siblings.length-1?siblings[i+1]:null;

    const lineIdx = lines.indexOf(line);
    const prevLine = lineIdx > 0 ? lines[lineIdx - 1] : null;
    const nextLine = lineIdx < lines.length - 1 ? lines[lineIdx + 1] : null;

    // Snapping: Find snap target times from the opposite channel words in the same line
    const oppositeWords = line.words.filter(w => !w.isPl && (!!(w.isBackground || w.role === 'x-bg') !== isBg));
    const snapTargets = [];
    oppositeWords.forEach(w => {
      snapTargets.push(w.startMs);
      snapTargets.push(w.endMs);
    });

    const isPrevAdjacent = prev && Math.abs(snap.s - snap.pe) <= 1;
    const isNextAdjacent = next && Math.abs(snap.ns - snap.e) <= 1;

    if(mode==='drag'){
      let mxL = prev ? (isPrevAdjacent ? -((snap.pe - snap.ps) - MIN) : -((snap.s - snap.pe) - MIN)) : -(snap.s - (prevLine ? prevLine.endMs : 0));
      let mxR = next ? (isNextAdjacent ? (snap.ne - snap.ns) - MIN : (snap.ns - snap.e) - MIN) : (nextLine ? nextLine.startMs - snap.e : (duration > 0 ? duration - snap.e : 9999999));
      dt=Math.max(mxL,Math.min(mxR,dt));

      // Apply snap to drag (checks start or end)
      let tempStart = snap.s + dt;
      let snapped = false;
      for (let target of snapTargets) {
        if (Math.abs(tempStart - target) < 30) {
          dt = target - snap.s;
          snapped = true;
          break;
        }
      }
      if (!snapped) {
        let tempEnd = snap.e + dt;
        for (let target of snapTargets) {
          if (Math.abs(tempEnd - target) < 30) {
            dt = target - snap.e;
            break;
          }
        }
      }
      dt=Math.max(mxL,Math.min(mxR,dt)); // Re-clamp

      word.startMs=snap.s+dt; word.endMs=snap.e+dt;
      if(prev && isPrevAdjacent){prev.endMs=snap.pe+dt;}
      if(next && isNextAdjacent){next.startMs=snap.ns+dt;}
    } else if(mode==='rr'){
      let mxL = -((snap.e - snap.s) - MIN);
      let mxR = next ? (isNextAdjacent ? (snap.ne - snap.ns) - MIN : (snap.ns - snap.e) - MIN) : (nextLine ? nextLine.startMs - snap.e : (duration > 0 ? duration - snap.e : 9999999));
      dt=Math.max(mxL,Math.min(mxR,dt));

      // Apply snap to resize right
      let tempEnd = snap.e + dt;
      for (let target of snapTargets) {
        if (Math.abs(tempEnd - target) < 30) {
          dt = target - snap.e;
          break;
        }
      }
      dt=Math.max(mxL,Math.min(mxR,dt)); // Re-clamp

      word.endMs=snap.e+dt;
      if(next && isNextAdjacent){next.startMs=snap.ns+dt;}
    } else if(mode==='rl'){
      let mxL = prev ? (isPrevAdjacent ? -((snap.pe - snap.ps) - MIN) : -((snap.s - snap.pe) - MIN)) : -(snap.s - (prevLine ? prevLine.endMs : 0));
      let mxR = (snap.e - snap.s) - MIN;
      dt=Math.max(mxL,Math.min(mxR,dt));

      // Apply snap to resize left
      let tempStart = snap.s + dt;
      for (let target of snapTargets) {
        if (Math.abs(tempStart - target) < 30) {
          dt = target - snap.s;
          break;
        }
      }
      dt=Math.max(mxL,Math.min(mxR,dt)); // Re-clamp

      word.startMs=snap.s+dt;
      if(prev && isPrevAdjacent){prev.endMs=snap.pe+dt;}
    }

    if(!isPl) {
      const allStarts = line.words.map(w => w.startMs);
      const allEnds = line.words.map(w => w.endMs);
      if (allStarts.length > 0) line.startMs = Math.min(...allStarts);
      if (allEnds.length > 0) line.endMs = Math.max(...allEnds);
      line.words.forEach(w => posWord(document.getElementById(`w-${w.id}`), w, line));
    } else {
      line.startMs = word.startMs;
      line.endMs = word.endMs;
      posWord(el, word, line);
    }
    
    // Live update waveform if it's a boundary change (rAF-throttled)
    if (audioBuffer && (!prev || !next)) {
        scheduleWaveformRedraw();
    }

    const tr = document.getElementById(`tc-${line.id}`);
    if (tr) {
      const timeStartDiv = tr.querySelector('.track-info > div:first-child');
      if (timeStartDiv) timeStartDiv.textContent = fmt(line.startMs/1000);
      else {
        const infoEl = tr.querySelector('.track-info');
        if (infoEl) infoEl.textContent = fmt(line.startMs/1000);
      }

      const timeEndDiv = tr.querySelector('.track-end-time > div:first-child');
      if (timeEndDiv) timeEndDiv.textContent = fmt(line.endMs/1000);
      else {
        const endTimeEl = tr.querySelector('.track-end-time');
        if (endTimeEl) endTimeEl.textContent = fmt(line.endMs/1000);
      }
    }
  }

  function onUp(){
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    window.__dragListeners = Math.max(0, (window.__dragListeners || 2) - 2);
    if(mode){
      el.classList.remove('dragging');
      const tr = el.closest('.timeline-track');
      if (tr) tr.classList.remove('is-dragging');
      if(hasDragged){
        pushHistory();
      }else{
        seekMs(word.startMs);
        if(!isPlaying)togglePlay();
      }
      mode=null;
    }
  }
}

// Playback
function togglePlay(){
  if(audio.src){audio.paused?audio.play():audio.pause();}
  else{isPlaying=!isPlaying;playBtn.innerHTML=isPlaying?'<i class="fas fa-pause"></i>':'<i class="fas fa-play"></i>';if(isPlaying){startTick();centerActiveLine();}else cancelAnimationFrame(rafId);}
}

let lastT=0;
function startTick(){lastT=performance.now();rafId=requestAnimationFrame(tick);}
function tick(now){
  if(!isPlaying)return;
  currentTime+=(now-lastT); lastT=now;
  // Repeat logic
  const currentLine = lines.find(l => currentTime >= l.startMs && currentTime < l.endMs);
  
  if (isWordRepeat && currentLine && currentLine.words) {
    if (!lockedWord || currentTime < lockedWord.startMs || currentTime > lockedWord.endMs + 50) {
      lockedWord = currentLine.words.find(word => currentTime >= word.startMs && currentTime < word.endMs);
    }
    if (lockedWord && currentTime >= lockedWord.endMs - 15) {
      currentTime = lockedWord.startMs;
    }
  } else if (isRepeat && currentLine) {
    if (currentTime >= currentLine.endMs - 15) {
      currentTime = currentLine.startMs;
    }
  } else if (isRepeat && activeLineId !== null) {
    // Fallback for line repeat if currentTime just jumped out of bounds
    const al = lines.find(l => l.id === activeLineId);
    if (al && currentTime >= al.endMs - 15) {
      currentTime = al.startMs;
    }
  }
  
  if (duration > 0 && currentTime >= duration) {
    if (isSongRepeat || isRepeat) {
      currentTime = 0;
    } else {
      isPlaying = false;
      currentTime = 0;
      playBtn.innerHTML = '<i class="fas fa-play"></i>';
      updateDisplay();
      return;
    }
  }
  updateDisplay();rafId=requestAnimationFrame(tick);
}

function stopPlay(){
  if(audio.src){audio.pause();audio.currentTime=0;}
  isPlaying=false;currentTime=0;cancelAnimationFrame(rafId);
  playBtn.innerHTML='<i class="fas fa-play"></i>';updateDisplay();
}

function seekMs(ms){
  if(audio.src)audio.currentTime=ms/1000;
  currentTime=ms;lastT=performance.now();
  lockedWord = null; // Reset lock on manual seek
  updateDisplay();
}

// Display Update
function updateDisplay(){
  const cs=currentTime/1000, ds=duration/1000;
  timeDisp.textContent=`${fmt(cs)} / ${fmt(ds)}`;
  const pct = duration>0 ? (currentTime/duration*100) : 0;
  progFill.style.width=pct+'%';
  const knob = $('progress-knob');
  if (knob) knob.style.left = pct+'%';

  // Find active line
  let newActiveLineId = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (currentTime>=line.startMs&&currentTime<line.endMs) { newActiveLineId=line.id; break; }
  }

  // Update tracks via cached elements (no per-frame getElementById storm)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const refs = trackEls[line.id];
    if (!refs) continue;
    const isActive = (line.id === newActiveLineId);

    if (isActive) {
      if (!refs.tr.classList.contains('active')) {
        refs.tr.classList.add('active');
        if (isPlaying) refs.tr.scrollIntoView({behavior:'smooth',block:'nearest'});
      }
      if (refs.pi) {
        refs.pi.style.display='block';
        refs.pi.style.left=((currentTime-line.startMs)/(line.endMs-line.startMs)*100)+'%';
      }
      if (line.words) {
        for (const w of line.words) {
          const we = refs.wordEls[w.id];
          if (!we) continue;
          const on = isWordHighlightEnabled && currentTime>=w.startMs&&currentTime<w.endMs;
          if (on) we.classList.add('active'); else we.classList.remove('active');
        }
      }
    } else if (refs.tr.classList.contains('active') || refs._wasActive) {
      refs.tr.classList.remove('active');
      if (refs.pi) refs.pi.style.display='none';
      for (const wid in refs.wordEls) refs.wordEls[wid].classList.remove('active');
    }
    refs._wasActive = isActive;
  }

  activeLineId = newActiveLineId;

  // Update track play buttons only when state actually changed
  if (activeLineId !== lastRenderedActiveId || isPlaying !== lastRenderedPlaying) {
    document.querySelectorAll('.track-play-btn').forEach(btn => {
      const tr = btn.closest('.timeline-track');
      const lineId = tr ? Number(tr.id.replace('tc-', '')) : null;
      const icon = btn.querySelector('i');
      if (!icon) return;

      if (lineId === activeLineId && isPlaying) {
        icon.className = 'fas fa-stop';
        icon.style.fontSize = '9px';
        icon.style.marginLeft = '0';
      } else {
        icon.className = 'fas fa-play';
        icon.style.fontSize = '9px';
        icon.style.marginLeft = '1px';
      }
    });
    lastRenderedActiveId = activeLineId;
    lastRenderedPlaying = isPlaying;
  }
}

// Audio Events
audio.addEventListener('timeupdate',()=>{currentTime=audio.currentTime*1000;updateDisplay();});
audio.addEventListener('play',()=>{isPlaying=true;playBtn.innerHTML='<i class="fas fa-pause"></i>';startAudioTick();centerActiveLine();});
audio.addEventListener('pause',()=>{isPlaying=false;playBtn.innerHTML='<i class="fas fa-play"></i>';cancelAnimationFrame(rafId);});
audio.addEventListener('loadedmetadata',()=>{duration=audio.duration*1000;updateDisplay();});
audio.addEventListener('ended',()=>{
    if(isSongRepeat || isRepeat){
        audio.currentTime=0;
        audio.play();
    }else{
        isPlaying=false;
        playBtn.innerHTML='<i class="fas fa-play"></i>';
        updateDisplay();
    }
});

// High-precision ticker for audio (for smooth indicator)
function startAudioTick(){
  const loop=()=>{
    if(!audio.paused){
      currentTime=audio.currentTime*1000;
      // Repeat logic with real audio
      const al = lines.find(l => currentTime >= l.startMs && currentTime < l.endMs);
      if (isWordRepeat && al && al.words) {
        if (!lockedWord || currentTime < lockedWord.startMs || currentTime > lockedWord.endMs + 50) {
          lockedWord = al.words.find(word => currentTime >= word.startMs && currentTime < word.endMs);
        }
        if (lockedWord && currentTime >= lockedWord.endMs - 15) audio.currentTime = lockedWord.startMs / 1000;
      } else if (isRepeat && al) {
        if (currentTime >= al.endMs - 15) audio.currentTime = al.startMs / 1000;
      } else if (isRepeat && activeLineId !== null) {
        const lastL = lines.find(l => l.id === activeLineId);
        if (lastL && currentTime >= lastL.endMs - 15) audio.currentTime = lastL.startMs / 1000;
      }
      updateDisplay();
      rafId=requestAnimationFrame(loop);
    }
  };
  cancelAnimationFrame(rafId);
  rafId=requestAnimationFrame(loop);
}

let lastVolume = 1;
volSlider.oninput=e=>{audio.volume=e.target.value; updateVolumeIcon();};

function updateVolumeIcon() {
    const icon = document.querySelector('.volume-control i');
    if (audio.volume === 0) icon.className = 'fas fa-volume-mute';
    else if (audio.volume < 0.5) icon.className = 'fas fa-volume-down';
    else icon.className = 'fas fa-volume-up';
}

function setVolume(v) {
    audio.volume = Math.max(0, Math.min(1, v));
    volSlider.value = audio.volume;
    updateVolumeIcon();
}

function toggleMute() {
    if (audio.volume > 0) {
        lastVolume = audio.volume;
        setVolume(0);
    } else {
        setVolume(lastVolume || 1);
    }
}

document.querySelector('.volume-control i').onclick = toggleMute;

function toggleRepeat() {
    isRepeat = !isRepeat;
    if(isRepeat) { isWordRepeat = false; isSongRepeat = false; }
    updateRepeatUI();
}
function toggleRepeatWord() {
    isWordRepeat = !isWordRepeat;
    if(isWordRepeat) { 
        isRepeat = false; 
        isSongRepeat = false; 
        lockedWord = null; // Reset to lock onto current position
    }
    updateRepeatUI();
}
function toggleRepeatSong() {
    isSongRepeat = !isSongRepeat;
    if(isSongRepeat) { isRepeat = false; isWordRepeat = false; }
    updateRepeatUI();
}
function updateRepeatUI() {
    $('btn-repeat').style.color = isRepeat ? 'var(--accent)' : '';
    $('btn-repeat-word').style.color = isWordRepeat ? 'var(--accent)' : '';
    $('btn-repeat-song').style.color = isSongRepeat ? 'var(--accent)' : '';
}

playBtn.onclick=togglePlay;
stopBtn.onclick=stopPlay;
$('btn-repeat').onclick=toggleRepeat;
$('btn-repeat-word').onclick=toggleRepeatWord;
$('btn-repeat-song').onclick=toggleRepeatSong;

// Progress bar: click + drag to seek, hover shows time tooltip
(function initProgressBar() {
  const bar = $('progress-bar'), box = $('progress-container'), tip = $('progress-tooltip');
  if (!bar || !box) return;
  let seeking = false;

  function seekAt(clientX) {
    if (!duration) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    seekMs(ratio * duration);
  }
  function updateTip(clientX) {
    if (!tip) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    tip.textContent = fmt(ratio * (duration || 0) / 1000);
    const boxR = box.getBoundingClientRect();
    tip.style.left = Math.max(24, Math.min(boxR.width - 24, clientX - boxR.left)) + 'px';
  }

  // Bind to the whole container for a generous hit area; ratio uses the bar rect
  box.addEventListener('pointerdown', e => {
    if (!duration) return;
    seeking = true;
    box.classList.add('seeking');
    try { box.setPointerCapture(e.pointerId); } catch(err) {}
    seekAt(e.clientX);
    e.preventDefault();
  });
  box.addEventListener('pointermove', e => {
    updateTip(e.clientX);
    if (seeking) seekAt(e.clientX);
  });
  box.addEventListener('pointerup', e => {
    if (seeking) { seekAt(e.clientX); seeking = false; box.classList.remove('seeking'); }
  });
  box.addEventListener('pointercancel', () => { seeking = false; box.classList.remove('seeking'); });
})();

// File Loading
$('btn-load-audio').onclick=()=>$('input-audio').click();

// Direct AIFF-to-WAV converter: parses the AIFF binary format manually
// and re-encodes as a WAV blob. No browser audio API needed.
function convertAiffToWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const textDec = (offset, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(offset + i));
    return s;
  };

  // Validate FORM header
  if (textDec(0, 4) !== 'FORM') throw new Error('Not a valid AIFF file (missing FORM header)');
  const formType = textDec(8, 4);
  if (formType !== 'AIFF' && formType !== 'AIFC') throw new Error('Not a valid AIFF file (expected AIFF or AIFC, got ' + formType + ')');

  let numChannels = 0, numFrames = 0, bitsPerSample = 0, sampleRate = 0;
  let ssndOffset = -1, ssndSize = 0, ssndDataOffset = 0;

  // Parse chunks
  let pos = 12;
  while (pos < arrayBuffer.byteLength - 8) {
    const chunkId = textDec(pos, 4);
    const chunkSize = dv.getUint32(pos + 4, false); // big-endian
    const chunkDataStart = pos + 8;

    if (chunkId === 'COMM') {
      numChannels = dv.getInt16(chunkDataStart, false);
      numFrames = dv.getUint32(chunkDataStart + 2, false);
      bitsPerSample = dv.getInt16(chunkDataStart + 6, false);
      // Sample rate is an 80-bit IEEE 754 extended float
      sampleRate = parseIeee754Extended(dv, chunkDataStart + 8);
    } else if (chunkId === 'SSND') {
      ssndDataOffset = dv.getUint32(chunkDataStart, false); // offset within SSND data
      // blockSize = dv.getUint32(chunkDataStart + 4, false); // not needed
      ssndOffset = chunkDataStart + 8 + ssndDataOffset;
      ssndSize = chunkSize - 8 - ssndDataOffset;
    }

    // Advance to next chunk (chunks are word-aligned)
    pos = chunkDataStart + chunkSize;
    if (chunkSize % 2 !== 0) pos++;
  }

  if (!numChannels || !sampleRate || ssndOffset < 0) {
    throw new Error('AIFF file is missing required COMM or SSND chunks');
  }

  // Build WAV output (always 16-bit PCM for broad compatibility)
  const outBitsPerSample = 16;
  const bytesPerOutSample = outBitsPerSample / 8;
  const totalSamples = numFrames * numChannels;
  const wavDataSize = totalSamples * bytesPerOutSample;
  const wavBuf = new ArrayBuffer(44 + wavDataSize);
  const wv = new DataView(wavBuf);

  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) wv.setUint8(off + i, str.charCodeAt(i)); };

  // RIFF header
  writeStr(0, 'RIFF');
  wv.setUint32(4, 36 + wavDataSize, true);
  writeStr(8, 'WAVE');
  // fmt
  writeStr(12, 'fmt ');
  wv.setUint32(16, 16, true);
  wv.setUint16(20, 1, true); // PCM
  wv.setUint16(22, numChannels, true);
  wv.setUint32(24, sampleRate, true);
  wv.setUint32(28, sampleRate * numChannels * bytesPerOutSample, true);
  wv.setUint16(32, numChannels * bytesPerOutSample, true);
  wv.setUint16(34, outBitsPerSample, true);
  // data
  writeStr(36, 'data');
  wv.setUint32(40, wavDataSize, true);

  // Convert samples: AIFF is big-endian, WAV is little-endian
  const srcBytesPerSample = bitsPerSample / 8;
  let writePos = 44;

  for (let i = 0; i < totalSamples; i++) {
    const srcPos = ssndOffset + i * srcBytesPerSample;
    let sample;

    if (bitsPerSample === 16) {
      sample = dv.getInt16(srcPos, false); // big-endian
    } else if (bitsPerSample === 24) {
      // Read 24-bit big-endian, convert to 16-bit
      const b0 = dv.getUint8(srcPos);
      const b1 = dv.getUint8(srcPos + 1);
      const b2 = dv.getUint8(srcPos + 2);
      let val = (b0 << 16) | (b1 << 8) | b2;
      if (val & 0x800000) val |= ~0xFFFFFF; // sign extend
      sample = val >> 8; // truncate to 16-bit
    } else if (bitsPerSample === 32) {
      // Read 32-bit big-endian, convert to 16-bit
      sample = dv.getInt32(srcPos, false) >> 16;
    } else if (bitsPerSample === 8) {
      // 8-bit AIFF is signed, scale to 16-bit
      sample = dv.getInt8(srcPos) << 8;
    } else {
      throw new Error('Unsupported AIFF bit depth: ' + bitsPerSample);
    }

    wv.setInt16(writePos, sample, true); // little-endian
    writePos += 2;
  }

  return new Blob([wavBuf], { type: 'audio/wav' });
}

// Parse 80-bit IEEE 754 extended precision float (used for AIFF sample rate)
function parseIeee754Extended(dv, offset) {
  const exponent = ((dv.getUint8(offset) & 0x7F) << 8) | dv.getUint8(offset + 1);
  const sign = dv.getUint8(offset) & 0x80 ? -1 : 1;
  let mantissa = 0;
  for (let i = 0; i < 8; i++) {
    mantissa = mantissa * 256 + dv.getUint8(offset + 2 + i);
  }
  if (exponent === 0 && mantissa === 0) return 0;
  if (exponent === 0x7FFF) return sign * Infinity;
  const f = sign * Math.pow(2, exponent - 16383 - 63) * mantissa;
  return Math.round(f);
}


function handleAudioFile(f, isRestore = false) {
  if(f){
    lastAudioFile = f;
    if (!isRestore) saveFileToDB('lastAudio', f);
    stopPlay();
    
    if (!isRestore) {
        audioFilename = f.name.replace(/\.[^/.]+$/, "");
        originalFilename = audioFilename; // Audio always takes priority for naming
        audioFullname = f.name;
    } else if (!audioFilename) {
        // Safety for restore if session string data was lost but DB file exists
        audioFilename = f.name.replace(/\.[^/.]+$/, "");
        originalFilename = audioFilename;
        audioFullname = f.name;
    }
    
    // Revoke old URL if it exists
    if(audio.src) URL.revokeObjectURL(audio.src);

    const reader = new FileReader();
    reader.onload = async (event) => {
      const arrayBuffer = event.target.result;
      // Clear cache and buffer immediately
      waveformCache.clear();
      audioBuffer = null;

      const ext = f.name.split('.').pop().toLowerCase();
      const isAiff = (ext === 'aif' || ext === 'aiff');

      if (isAiff) {
        // AIFF is not natively playable/decodable in most browsers.
        // We parse the binary format directly and convert to WAV.
        try {
          const wavBlob = convertAiffToWav(arrayBuffer);
          const url = URL.createObjectURL(wavBlob);
          audio.src = url;
          audio.load();
          updateFileUI();

          // Decode the converted WAV for waveform display
          const wavBuffer = await wavBlob.arrayBuffer();
          decodeAudioForWaveform(wavBuffer);
        } catch (e) {
          console.error("AIFF convert failed:", e);
          showToast("Failed to convert AIFF file: " + e.message + " — please convert the audio to MP3 or WAV.", 'error', 5000);
          stopPlay();
          audioFilename = "";
          audioFullname = "";
          updateFileUI();
        }
      } else {
        // Standard path for natively supported formats
        const blob = new Blob([arrayBuffer], { type: f.type || 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        audio.src = url;
        audio.load();
        updateFileUI();

        // Decode audio for waveform
        decodeAudioForWaveform(arrayBuffer);
      }
    };
    reader.onerror = () => console.error("Error reading audio file");
    reader.readAsArrayBuffer(f);
    
    if (!isRestore) pushHistory();
  }
}
$('input-audio').onchange=e=>{
  handleAudioFile(e.target.files[0]);
  e.target.value = ""; 
};

// Handle audio errors (Chromium PTS issues, corrupt FLAC, etc.)
audio.onerror = () => {
  if (!audio.src || audio.src === "" || audio.src === window.location.href) return; // Ignore intentional ejects
  const err = audio.error;
  let msg = "Audio error occurred";
  let details = "";
  if (err) {
    // If it's a blob URL and fails with code 4 or 2, it's likely expired.
    // Silently ignore instead of showing a confusing modal.
    if (audio.src.startsWith('blob:') && (err.code === 4 || err.code === 2)) {
        console.warn("Audio Blob URL expired or invalid. Ignoring error.");
        return;
    }

    switch (err.code) {
      case 1: msg = "Audio fetching process aborted."; break;
      case 2: msg = "Network error while loading audio."; break;
      case 3: 
        msg = "Audio error occurred: PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE: FFmpegDemuxer: PTS is not defined (Corrupt FLAC/Audio file)."; 
        break;
      case 4: msg = "Audio format not supported by this browser."; break;
    }
    details = err.message ? `\nBrowser Details: ${err.message}` : "";
    console.error("Audio Error Code:", err.code, "Message:", err.message);
  } else {
      return; 
  }
  
  showToast(`${msg} — please convert the audio to a standard MP3/WAV, or try Firefox.`, 'error', 6000);
  console.warn('Audio error details:', details);

  // Revert UI since audio failed
  stopPlay();
  audioFilename = "";
  audioFullname = "";
  updateFileUI();
  if(lines.length === 0) renderTimeline(); // restores empty-state placeholder
};
$('btn-load-lyrics').onclick=()=>$('input-lyrics').click();
function handleLyricsFile(f) {
  if(!f) return;
  stopPlay();

  const r=new FileReader();
  r.onload=ev=>{
    const content = ev.target.result;
    const fmt=detectFormat(f.name, content);
    lastImportFormat = fmt;
    
    const segments = detectSegments(content, fmt);
    if (segments.length > 1) {
        showImportSegmentsModal(segments, fmt, f);
        return;
    }
    
    processImportedContent(content, fmt, f);
  };
  r.readAsText(f);
}

let pendingSegments = [];
let pendingFormat = '';
let pendingFile = null;

function showImportSegmentsModal(segments, format, file) {
    pendingSegments = segments;
    pendingFormat = format;
    pendingFile = file;
    const list = $('import-segments-list');
    list.innerHTML = '';
    
    // Auto-select logic for initial state
    let maxLines = -1, primaryIdx = 0;
    let minLines = Infinity, refIdx = -1;
    const parsed = segments.map(seg => parseContent(seg, format));

    parsed.forEach((cues, i) => {
        if (cues.length > maxLines) { maxLines = cues.length; primaryIdx = i; }
    });
    parsed.forEach((cues, i) => {
        if (i !== primaryIdx && cues.length < minLines && cues.length > 0) { minLines = cues.length; refIdx = i; }
    });

    segments.forEach((seg, i) => {
        const cues = parsed[i];
        const div = document.createElement('div');
        div.className = 'segment-item';
        div.style = 'display:grid; grid-template-columns: 1fr 60px 60px 70px; gap:10px; align-items:center; padding:10px 12px; background:var(--bg-dark); border:1px solid var(--border); border-radius:8px;';
        
        div.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:2px; cursor:pointer; flex:1;" onclick="applyImportSegment(${i})">
                <span style="font-weight:600; font-size:13px; color:var(--text-main);">Segment ${i+1}</span>
                <span style="font-size:11px; color:var(--text-muted);">${cues.length} lines detected</span>
            </div>
            <div style="text-align:center;"><input type="radio" name="seg-primary" value="${i}" ${i===primaryIdx?'checked':''}></div>
            <div style="text-align:center;"><input type="radio" name="seg-ref" value="${i}" ${i===refIdx?'checked':''}></div>
            <div style="text-align:center; padding-left:10px;">
                <button class="btn btn-sm" style="padding: 4px 8px; font-size:10px;" onclick="applyImportSegment(${i})" title="Quick Load this segment only">Load</button>
            </div>
        `;
        list.appendChild(div);
    });
    
    $('import-segments-modal').style.display = 'flex';
}

function applyImportSegment(index) {
    const content = index === -1 ? pendingSegments.join('\n\n') : pendingSegments[index];
    processImportedContent(content, pendingFormat, pendingFile);
    $('import-segments-modal').style.display = 'none';
    pendingFile = null;
}

function processImportedContent(content, fmt, fileObj = null) {
    if (fileObj) {
        lastLyricsFile = fileObj;
        saveFileToDB('lastLyrics', fileObj);
        lyricsFullname = fileObj.name;
        lyricsFilename = fileObj.name.replace(/\.[^/.]+$/, "");
        
        // Update name if no audio is present or if we are using the default "lyrics" name
        if (!audioFilename || originalFilename === 'lyrics') {
            originalFilename = lyricsFilename;
        }
        updateFileUI();
    }

    lines=parseContent(content,fmt);
    const meta = parseMetadata(content, fmt);
    if (window.appMetadata) {
        const fields = ['title', 'artist', 'album', 'language', 'author', 'by', 'lyricist', 'offset', 'copyright', 'itunesTiming', 'leadingSilence', 'agents', 'songwriters'];
        fields.forEach(f => {
            if (meta[f] !== undefined && meta[f] !== null && meta[f] !== '') {
                window.appMetadata[f] = meta[f];
            }
        });
        if (typeof window.saveAppMetadata === 'function') {
            window.saveAppMetadata();
        }
    }
    autoFillWords(lines);
    normalizeLines(lines);
    let wid=1; lines.forEach(l=>{if(l.words)l.words.forEach(w=>w.id=wid++);});
    
    // Always calculate a reasonable project duration if no audio is loaded
    if(!audio.src){
      if(meta.durationMs > 0) duration = meta.durationMs;
      else if(lines.length) duration = lines[lines.length-1].endMs + 2000;
    }
    
    pushHistory();
    renderTimeline();
    updateDisplay();
}

$('import-segments-all').onclick = () => applyImportSegment(-1);
$('import-segments-close-top').onclick = () => {
    $('import-segments-modal').style.display = 'none';
    pendingFile = null;
};

$('import-segments-smart').onclick = () => {
    const pRadio = document.querySelector('input[name="seg-primary"]:checked');
    const rRadio = document.querySelector('input[name="seg-ref"]:checked');
    
    if (!pRadio || !rRadio) return showToast("Select both a Primary and a Reference segment.", 'warning');
    
    const pIdx = parseInt(pRadio.value);
    const rIdx = parseInt(rRadio.value);
    
    if (pIdx === rIdx) return showToast("Primary and Reference segments must be different.", 'warning');
    
    const primaryCues = parseContent(pendingSegments[pIdx], pendingFormat);
    const refCues = parseContent(pendingSegments[rIdx], pendingFormat);
    
    if (primaryCues.length <= refCues.length) {
        return showToast(`Primary segment (${primaryCues.length} lines) should have more lines than Reference (${refCues.length} lines) to merge correctly.`, 'warning', 4500);
    }

    // Similarity Check
    const getWords = (cs) => cs.map(c => c.text).join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const pWords = new Set(getWords(primaryCues));
    const rWords = getWords(refCues);
    if (pWords.size > 0 && rWords.length > 0) {
        const matches = rWords.filter(w => pWords.has(w)).length;
        const ratio = matches / rWords.length;
        if (ratio < 0.2) {
            if (!confirm(`Warning: Selected segments have very low text similarity (${Math.round(ratio*100)}%). They might be different languages or unrelated tracks. Continue anyway?`)) return;
        }
    }

    lines = primaryCues;
    autoFillWords(lines);
    if (smartToolMode === 'merge') {
        applySmartMergeFromCues(refCues, pendingFormat);
    } else if (smartToolMode === 'replace') {
        applySmartReplaceTextFromCues(refCues, pendingFormat);
    } else if (smartToolMode === 'combined') {
        applyCombinedSmartMergeFromCues(refCues, pendingFormat);
    }
    
    // Also apply the filename since this was a "Smart Import" (which replaces/initializes the timeline)
    if (pendingFile) {
        lastLyricsFile = pendingFile;
        saveFileToDB('lastLyrics', pendingFile);
        lyricsFullname = pendingFile.name;
        lyricsFilename = pendingFile.name.replace(/\.[^/.]+$/, "");
        if (!audioFilename || originalFilename === 'lyrics') {
            originalFilename = lyricsFilename;
        }
        updateFileUI();
    }

    $('import-segments-modal').style.display = 'none';
};

$('input-lyrics').onchange=e=>{
  handleLyricsFile(e.target.files[0]);
  e.target.value = "";
};

// Dropdown Menus
function setupDropdown(btnId, menuId){
  const btn=$(btnId), menu=$(menuId);
  btn.onclick=e=>{e.stopPropagation();document.querySelectorAll('.dropdown-menu.open').forEach(m=>{if(m!==menu)m.classList.remove('open');});menu.classList.toggle('open');};
}
setupDropdown('btn-tools','tools-menu');
setupDropdown('btn-export','export-menu');
document.addEventListener('click',()=>document.querySelectorAll('.dropdown-menu.open').forEach(m=>m.classList.remove('open')));

// Export
function performExport(f, isQuick = false) {
  if(!f) return;
  if(!lines.length) { showToast('Nothing to export — load or create lyrics first.', 'warning'); return; }
  
  // Prioritize word-level (karaoke) formats for Quick Export
  let targetFormat = f;
  if (isQuick) {
    if (f === 'lrc') targetFormat = 'lrc_enhanced';
    else if (f === 'vtt') targetFormat = 'vtt_karaoke';
    else if (f === 'ttml') targetFormat = 'ttml_karaoke';
    else if (['srv1', 'srv2', 'srv3'].includes(f)) targetFormat = 'srv3_karaoke';
    else if (f === 'json') targetFormat = 'json3';
    else if (f === 'txt') targetFormat = 'ttml_karaoke'; // Save work as TTML Karaoke if starting from TXT
  }

  // Only use autoEmpty if it's a manual export and the toggle is checked.
  // For Quick Export, we want it to match exactly what's in the editor.
  const autoEmpty = isQuick ? false : ($('toggle-auto-empty-lines') ? $('toggle-auto-empty-lines').checked : false);
  const ext={lrc:'lrc',lrc_enhanced:'lrc',srt:'srt',vtt:'vtt',vtt_karaoke:'vtt',ttml:'ttml',ttml_karaoke:'ttml',apple_ttml:'ttml',apple_ttml_karaoke:'ttml',srv1:'srv1',srv2:'srv2',srv3:'srv3',srv3_karaoke:'srv3',json:'json',json3:'json',lyricsfile:'lyricsfile',txt:'txt',audacity:'txt',audacity_karaoke:'txt'}[targetFormat]||'txt';
  
  let finalBaseName = originalFilename;
  if (audioFilename && lyricsFilename && audioFilename !== lyricsFilename) {
      finalBaseName = `${audioFilename} - ${lyricsFilename}`;
  } else {
      finalBaseName = audioFilename || lyricsFilename || "lyrics";
  }

  let name = `${finalBaseName} - lyricseditor.${ext}`;
  if (targetFormat === 'audacity') {
      name = `${finalBaseName} - Audacity Label.txt`;
  } else if (targetFormat === 'audacity_karaoke') {
      name = `${finalBaseName} - Audacity Label (Words).txt`;
  }
  downloadFile(exportAs(lines.map(l=>({
    startMs: l.startMs,
    endMs: l.endMs,
    text: l.text,
    words: l.words,
    isBackground: !!(l.isBackground || l.role === 'x-bg'),
    role: l.role || null,
    agent: l.agent || null,
    songPart: l.songPart || null
  })), targetFormat, duration, { autoEmptyLines: autoEmpty, metadata: window.appMetadata }), name);
  showToast(`Exported ${name}`, 'success');
}

$('export-menu').onclick=e=>{
  e.stopPropagation(); // Prevent closing when clicking non-item areas (like the toggle)
  const item=e.target.closest('.dropdown-item');if(!item)return;
  performExport(item.dataset.format, false); // Manual export: respect chosen format
  $('export-menu').classList.remove('open');
};

// Tools
$('tool-shift-time').onclick=()=>{$('tools-menu').classList.remove('open');$('shift-modal').style.display='flex';$('shift-amount').value=0;$('shift-amount').focus();};
$('tool-find-replace').onclick=()=>{$('tools-menu').classList.remove('open');$('find-replace-modal').style.display='flex';$('find-text').focus();};
$('tool-sort-rows').onclick=()=>{lines.sort((a,b)=>a.startMs-b.startMs);pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-remove-empty-lines').onclick=()=>{lines=lines.filter(l=>(l.words&&l.words.length>0)||l.text.trim());pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
// Gap Filling Logic
function fillGapToStart() {
  if (lines.length === 0) return false;
  lines.sort((a,b) => a.startMs - b.startMs);
  if (lines[0].startMs > 10) {
    const maxId = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
    lines.unshift({
      id: maxId + 1,
      startMs: 0,
      endMs: lines[0].startMs,
      text: "",
      words: []
    });
    return true;
  }
  return false;
}

function fillGapsBetweenLines() {
  if(lines.length < 1) return false;
  lines.sort((a,b)=>a.startMs-b.startMs);
  let changed = false;
  const newLines = [];
  let maxId = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
  for(let i=0; i<lines.length; i++){
    newLines.push(lines[i]);
    if(i < lines.length - 1){
      const currentEnd = lines[i].endMs;
      const nextStart = lines[i+1].startMs;
      if(nextStart - currentEnd > 10){
        maxId++;
        newLines.push({
          id: maxId,
          startMs: currentEnd,
          endMs: nextStart,
          text: "",
          words: []
        });
        changed = true;
      }
    }
  }
  if (changed) lines = newLines;
  return changed;
}

function fillGapToEnd() {
  if(!duration || duration <= 0) return false;
  lines.sort((a,b) => a.startMs - b.startMs);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
  const lastEnd = lastLine ? lastLine.endMs : 0;
  if(duration - lastEnd > 10){
    const maxId = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
    lines.push({
      id: maxId + 1,
      startMs: lastEnd,
      endMs: duration,
      text: "",
      words: []
    });
    return true;
  }
  return false;
}

$('tool-fill-gap-to-start').onclick=()=>{
  if (fillGapToStart()) { pushHistory(); renderTimeline(); }
  $('tools-menu').classList.remove('open');
};
$('tool-fill-gaps-with-lines').onclick=()=>{
  if (fillGapsBetweenLines()) { pushHistory(); renderTimeline(); }
  $('tools-menu').classList.remove('open');
};
$('tool-fill-gap-to-end').onclick=()=>{
  if (fillGapToEnd()) { pushHistory(); renderTimeline(); }
  $('tools-menu').classList.remove('open');
};
$('tool-fill-all-gaps').onclick=()=>{
  let c1 = fillGapToStart();
  let c2 = fillGapsBetweenLines();
  let c3 = fillGapToEnd();
  if (c1 || c2 || c3) { pushHistory(); renderTimeline(); }
  $('tools-menu').classList.remove('open');
};
$('tool-clear-all').onclick=()=>{
    if(confirm("Are you sure you want to clear all lines? This will reset the timeline.")) {
        lines = [];
        pushHistory();
        renderTimeline();
    }
    $('tools-menu').classList.remove('open');
};

$('tool-clear-session').onclick=()=>{
    if(confirm("Clear saved session and reset editor? This will refresh the page.")) {
        localStorage.removeItem('lyricseditor_session');
        localStorage.removeItem('lyricseditor_history');
        localStorage.removeItem('lyricseditor_metadata');
        clearDB().then(() => location.reload());
    }
};

function mergeSelectedLines() {
  const checks = Array.from(document.querySelectorAll('.line-checkbox:checked')).map(c => Number(c.dataset.id));
  if (checks.length > 1) {
    const selected = lines.filter(l => checks.includes(l.id));
    const first = selected[0], last = selected[selected.length - 1];
    first.endMs = last.endMs;
    first.text = selected.map(l => (l.text || "").trim()).filter(t => t).join(' ');

    // Collect words from all selected lines
    // Empty lines (no words, no text) become blank word blocks using line timestamps
    const allWords = [];
    selected.forEach(l => {
      if (l.words && l.words.length > 0) {
        l.words.forEach(w => {
          const newWord = { ...w };
          if (allWords.length > 0) {
            const prevWord = allWords[allWords.length - 1];
            if (prevWord.endMs < newWord.startMs) {
              prevWord.endMs = newWord.startMs;
            }
          }
          allWords.push(newWord);
        });
      } else {
        // Preserve empty lines as blank words during merge
        if (allWords.length > 0) {
          const prevWord = allWords[allWords.length - 1];
          if (prevWord.endMs < l.startMs) prevWord.endMs = l.startMs;
        }
        allWords.push({ id: Math.floor(Math.random() * 1000000), text: "", startMs: l.startMs, endMs: l.endMs });
      }
    });
    first.words = allWords;
    // Ensure the merged line's words cover the full duration without gaps
    autoFillWords([first]);
    // If the merged result is purely blank, revert to empty line placeholder
    normalizeLines([first]);

    lines = lines.filter(l => l.id === first.id || !checks.includes(l.id));
    pushHistory();
    renderTimeline();
  } else {
    showToast("Please select at least two lines to merge.", 'warning');
  }
}

function openSmartMergeModal(mode) {
  smartToolMode = mode;
  const modal = $('smart-merge-modal');
  const title = modal.querySelector('h3');
  const desc = modal.querySelector('p');
  const list = modal.querySelector('ul');
  
  if (mode === 'merge') {
      title.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Smart Merge Lines';
      desc.innerHTML = 'Smart Merge will re-organize your current line breaks to match a <b>reference lyric file</b> (LRC, TXT, etc.).';
      list.innerHTML = `
          <li>Keep your current word-level timestamps</li>
          <li>Automatic text alignment and grouping</li>
          <li>Ideal for fixing bad line splitting from AI models</li>
      `;
  } else if (mode === 'replace') {
      title.innerHTML = '<i class="fas fa-language"></i> Smart Replace Text';
      desc.innerHTML = 'Smart Replace Text will refine word text and join word-blocks to match a <b>reference lyric file</b> (LRC, TXT, etc.).';
      list.innerHTML = `
          <li>Keep your current line structure (no line splits or merges)</li>
          <li>Fuzzy word alignment to map text onto existing timestamps</li>
          <li>Refine typos and join fragmented word-blocks seamlessly</li>
      `;
  } else if (mode === 'combined') {
      title.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Smart Merge + Replace Text';
      desc.innerHTML = 'This combined tool will re-organize line breaks AND refine/join word-blocks using a <b>reference lyric file</b>.';
      list.innerHTML = `
          <li>Re-group lines to match reference phrasing</li>
          <li>Refine all word block text and merge/join word blocks</li>
          <li>Perfect for fully aligning low-quality timings to high-quality reference lyrics</li>
      `;
  }
  modal.style.display = 'flex';
}

function applySmartMerge(refContent, refFormat) {
  const refCues = parseContent(refContent, refFormat);
  if (smartToolMode === 'merge') {
      applySmartMergeFromCues(refCues, refFormat);
  } else if (smartToolMode === 'replace') {
      applySmartReplaceTextFromCues(refCues, refFormat);
  } else if (smartToolMode === 'combined') {
      applyCombinedSmartMergeFromCues(refCues, refFormat);
  }
}

function alignWordsWithReference(allWords, refWords) {
  function cleanStr(s) {
      return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function levenshtein(a, b) {
      const matrix = [];
      for (let i = 0; i <= b.length; i++) matrix[i] = [i];
      for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
      for (let i = 1; i <= b.length; i++) {
          for (let j = 1; j <= a.length; j++) {
              if (b.charAt(i - 1) === a.charAt(j - 1)) {
                  matrix[i][j] = matrix[i - 1][j - 1];
              } else {
                  matrix[i][j] = Math.min(
                      matrix[i - 1][j - 1] + 1,
                      matrix[i][j - 1] + 1,
                      matrix[i - 1][j] + 1
                  );
              }
          }
      }
      return matrix[b.length][a.length];
  }

  function getSimilarity(a, b) {
      const ca = cleanStr(a), cb = cleanStr(b);
      if (!ca && !cb) return 1;
      if (!ca || !cb) return 0;
      if (ca === cb) return 1;
      const maxLen = Math.max(ca.length, cb.length);
      return 1 - (levenshtein(ca, cb) / maxLen);
  }

  function allocateTimes(wSlice, rSlice) {
      const I = wSlice.length, J = rSlice.length;
      const result = [];
      if (J === I) {
          for (let k = 0; k < J; k++) {
              result.push({
                  startMs: wSlice[k].startMs,
                  endMs: wSlice[k].endMs,
                  text: rSlice[k].text,
                  refLineIdx: rSlice[k].refLineIdx,
                  origLineId: wSlice[k].origLineId
              });
          }
      } else if (J > I) {
          // Splitting: distribute J reference words evenly across the combined timing of I word-blocks
          const start = wSlice[0].startMs;
          const end = wSlice[I-1].endMs;
          const totalDur = end - start;
          const durPerWord = totalDur / J;
          for (let k = 0; k < J; k++) {
              result.push({
                  startMs: Math.round(start + durPerWord * k),
                  endMs: Math.round(start + durPerWord * (k + 1)),
                  text: rSlice[k].text,
                  refLineIdx: rSlice[k].refLineIdx,
                  origLineId: wSlice[0].origLineId
              });
          }
      } else { // J < I
          // Joining: Group I word-blocks into J chunks.
          for (let k = 0; k < J - 1; k++) {
              result.push({
                  startMs: wSlice[k].startMs,
                  endMs: wSlice[k].endMs,
                  text: rSlice[k].text,
                  refLineIdx: rSlice[k].refLineIdx,
                  origLineId: wSlice[k].origLineId
              });
          }
          const lastStart = wSlice[J-1].startMs;
          const lastEnd = wSlice[I-1].endMs;
          result.push({
              startMs: lastStart,
              endMs: lastEnd,
              text: rSlice[J-1].text,
              refLineIdx: rSlice[J-1].refLineIdx,
              origLineId: wSlice[J-1].origLineId
          });
      }
      return result;
  }

  const aligned = [];
  let allIdx = 0;
  let refIdx = 0;

  while (allIdx < allWords.length && refIdx < refWords.length) {
      const w = allWords[allIdx];
      const wText = (w.text || "").trim();
      const isTag = (wText.startsWith('[') && wText.endsWith(']')) || (wText.startsWith('(') && wText.endsWith(')'));
      
      if (isTag) {
          // Keep editor tag as a separate block with empty text, keeping its original timing
          aligned.push({
              startMs: w.startMs,
              endMs: w.endMs,
              text: "", // Becomes empty line in editor
              refLineIdx: refWords[refIdx].refLineIdx,
              origLineId: w.origLineId
          });
          allIdx++;
          continue;
      }

      let bestI = 1, bestJ = 1, bestScore = -1;

      // Lookahead window size up to 4 word-blocks and 4 reference words
      const maxLook = 4;
      for (let i = 1; i <= maxLook && allIdx + i <= allWords.length; i++) {
          for (let j = 1; j <= maxLook && refIdx + j <= refWords.length; j++) {
              const sliceAll = allWords.slice(allIdx, allIdx + i);
              const textAll = sliceAll.map(w => w.text).join("");
              const textRef = refWords.slice(refIdx, refIdx + j).map(w => w.text).join(" ");
              
              let score = getSimilarity(textAll, textRef);
              
              // Give priority to exact matches
              if (cleanStr(textAll) === cleanStr(refWords.slice(refIdx, refIdx + j).map(w => w.text).join(""))) {
                  score = 1.0;
              }
              
              if (score > bestScore) {
                  bestScore = score;
                  bestI = i;
                  bestJ = j;
              }
          }
      }

      // If we found a reasonable match (score > 0.4), consume it.
      // Otherwise, default to a 1-to-1 mapping.
      if (bestScore < 0.4) {
          bestI = 1;
          bestJ = 1;
      }

      const matchedAll = allWords.slice(allIdx, allIdx + bestI);
      const matchedRefSlice = refWords.slice(refIdx, refIdx + bestJ);

      const allocated = allocateTimes(matchedAll, matchedRefSlice);
      aligned.push(...allocated);

      allIdx += bestI;
      refIdx += bestJ;
  }

  // Consume any remaining word-blocks in allWords
  while (allIdx < allWords.length) {
      const w = allWords[allIdx];
      const wText = (w.text || "").trim();
      const isTag = (wText.startsWith('[') && wText.endsWith(']')) || (wText.startsWith('(') && wText.endsWith(')'));
      aligned.push({
          startMs: w.startMs,
          endMs: w.endMs,
          text: isTag ? "" : w.text,
          refLineIdx: refWords.length > 0 ? refWords[refWords.length - 1].refLineIdx : 0,
          origLineId: w.origLineId
      });
      allIdx++;
  }

  // If there are leftover reference words, split the last aligned word block evenly to fit all of them
  if (refIdx < refWords.length && aligned.length > 0) {
      const lastWord = aligned[aligned.length - 1];
      const remainingWords = refWords.slice(refIdx);
      const allRems = [lastWord, ...remainingWords];
      const start = lastWord.startMs;
      const end = lastWord.endMs;
      const totalDur = end - start;
      const durPerWord = totalDur / allRems.length;
      
      aligned.pop();
      allRems.forEach((rw, k) => {
          aligned.push({
              startMs: Math.round(start + durPerWord * k),
              endMs: Math.round(start + durPerWord * (k + 1)),
              text: rw.text,
              refLineIdx: rw.refLineIdx,
              origLineId: lastWord.origLineId
          });
      });
  }

  return aligned;
}

function applySmartReplaceTextFromCues(refCues, refFormat) {
  if (!lines.length) return;
  autoFillWords(lines);
  
  // Flatten all words and tag with original line ID, merging punctuation-only blocks into previous words
  const allWords = [];
  lines.forEach(l => {
      if (l.words) {
          l.words.forEach(w => {
              const text = (w.text || "").trim();
              const isPunctOnly = text !== "" && /^[\.,]+$/.test(text);
              if (isPunctOnly && allWords.length > 0) {
                  const prev = allWords[allWords.length - 1];
                  prev.text = (prev.text || "") + w.text;
                  prev.endMs = Math.max(prev.endMs, w.endMs);
              } else {
                  allWords.push({ ...w, origLineId: l.id });
              }
          });
      }
  });
  if (!allWords.length) return showToast("No words found to replace.", 'warning');

  if (!refCues.length) return showToast("No lines found in reference.", 'warning');

  // Flatten reference words while ignoring tags like [Verse 1], (verse), etc. and tracking refLineIdx
  const refWords = [];
  refCues.forEach((rc, lineIdx) => {
      const text = rc.text.trim();
      if (text.startsWith('[') && text.endsWith(']')) return;
      if (text.startsWith('(') && text.endsWith(')')) return;
      
      const words = text.split(/\s+/).filter(w => w);
      words.forEach(w => {
          const cleanW = w.trim();
          if (cleanW.startsWith('[') && cleanW.endsWith(']')) return;
          if (cleanW.startsWith('(') && cleanW.endsWith(')')) return;
          refWords.push({
              text: cleanW,
              refLineIdx: lineIdx
          });
      });
  });
  if (!refWords.length) return showToast("No words found in reference text.", 'warning');

  // Run the alignment
  const aligned = alignWordsWithReference(allWords, refWords);

  // Group back strictly into original line structures
  const lineMap = new Map();
  lines.forEach(l => {
      lineMap.set(l.id, {
          id: l.id,
          startMs: l.startMs,
          endMs: l.endMs,
          text: "",
          words: []
      });
  });

  let nextWordId = Math.max(0, ...allWords.map(w => Number(w.id) || 0)) + 1;
  aligned.forEach(aw => {
      const lineGroup = lineMap.get(aw.origLineId);
      if (lineGroup) {
          lineGroup.words.push({
              id: nextWordId++,
              startMs: aw.startMs,
              endMs: aw.endMs,
              text: aw.text
          });
      }
  });

  const newLines = [];
  lines.forEach(l => {
      const group = lineMap.get(l.id);
      if (group) {
          group.words.sort((a, b) => a.startMs - b.startMs);
          group.text = group.words.map(w => w.text).join(' ').trim();
          newLines.push({
              id: l.id,
              startMs: l.startMs,
              endMs: l.endMs,
              text: group.text,
              words: group.words.length > 0 ? group.words : null
          });
      }
  });

  resolveTimingOverlaps(newLines);
  autoFillWords(newLines);
  normalizeLines(newLines);
  lines = newLines;
  pushHistory();
  renderTimeline();
  updateDisplay();
}

function applyCombinedSmartMergeFromCues(refCues, refFormat) {
  if (!lines.length) return;
  autoFillWords(lines);
  
  // Flatten all words and tag with original line ID, merging punctuation-only blocks into previous words
  const allWords = [];
  lines.forEach(l => {
      if (l.words) {
          l.words.forEach(w => {
              const text = (w.text || "").trim();
              const isPunctOnly = text !== "" && /^[\.,]+$/.test(text);
              if (isPunctOnly && allWords.length > 0) {
                  const prev = allWords[allWords.length - 1];
                  prev.text = (prev.text || "") + w.text;
                  prev.endMs = Math.max(prev.endMs, w.endMs);
              } else {
                  allWords.push({ ...w, origLineId: l.id });
              }
          });
      }
  });
  if (!allWords.length) return showToast("No words found to merge.", 'warning');

  if (!refCues.length) return showToast("No lines found in reference.", 'warning');

  // Flatten reference words while ignoring tags like [Verse 1], (verse), etc. and tracking refLineIdx
  const refWords = [];
  refCues.forEach((rc, lineIdx) => {
      const text = rc.text.trim();
      if (text.startsWith('[') && text.endsWith(']')) return;
      if (text.startsWith('(') && text.endsWith(')')) return;
      
      const words = text.split(/\s+/).filter(w => w);
      words.forEach(w => {
          const cleanW = w.trim();
          if (cleanW.startsWith('[') && cleanW.endsWith(']')) return;
          if (cleanW.startsWith('(') && cleanW.endsWith(')')) return;
          refWords.push({
              text: cleanW,
              refLineIdx: lineIdx
          });
      });
  });
  if (!refWords.length) return showToast("No words found in reference text.", 'warning');

  // Run the alignment
  const aligned = alignWordsWithReference(allWords, refWords);

  // Re-group aligned words matching the reference cues exactly (Smart Merge style)
  let nextLineId = Math.max(0, ...lines.map(l => Number(l.id) || 0)) + 1;
  let nextWordId = Math.max(0, ...allWords.map(w => Number(w.id) || 0)) + 1;

  function getTagLength(startIdx) {
      if (startIdx >= aligned.length) return 0;
      const wText = aligned[startIdx].text.trim();
      if (!wText.startsWith('[') && !wText.startsWith('(')) return 0;
      const closeChar = wText.startsWith('[') ? ']' : ')';
      if (wText.endsWith(closeChar)) return 1;
      
      let tempIdx = startIdx + 1;
      while (tempIdx < aligned.length && tempIdx < startIdx + 5) {
          const tText = aligned[tempIdx].text.trim();
          if (tText.endsWith(closeChar)) return (tempIdx - startIdx) + 1;
          if (tText.startsWith('[') || tText.startsWith('(')) return 0;
          tempIdx++;
      }
      return 0;
  }

  const newLines = [];
  let wordIdx = 0;
  const isTimestampBased = refFormat !== 'txt';

  refCues.forEach((refCue, idx) => {
    while (wordIdx < aligned.length) {
        const tagLen = getTagLength(wordIdx);
        if (tagLen > 0) {
            const tagWords = aligned.slice(wordIdx, wordIdx + tagLen);
            newLines.push({
                id: nextLineId++,
                startMs: tagWords[0].startMs,
                endMs: tagWords[tagWords.length - 1].endMs,
                text: tagWords.map(tw => tw.text).join(' '),
                words: tagWords.map((tw) => ({ ...tw, id: nextWordId++ }))
            });
            wordIdx += tagLen;
        } else {
            break;
        }
    }

    let refText = refCue.text.trim();
    if (refText.match(/^\[.*?\]$/) || refText.match(/^\(.*?\)$/)) {
        refText = "";
    }
    
    let lineWords = [];

    const refWordsInCue = refText.split(/\s+/).filter(w => w);
    const refWordsCount = refWordsInCue.length;
    const refSignificantWordsCount = refWordsInCue.filter(w => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").length > 1).length;
    
    let mode = (isTimestampBased && refCue.text.trim() === "") ? 'time' : 'text';
    
    if (mode === 'text' && isTimestampBased && refWordsCount > 0) {
        const poolWord = aligned[wordIdx] ? aligned[wordIdx].text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"") : null;
        const firstRefWord = refWordsInCue[0].toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
        
        if (poolWord && poolWord !== firstRefWord) {
            mode = 'time';
        }
    }

    if (mode === 'time') {
      const nextStart = (idx < refCues.length - 1) ? refCues[idx + 1].startMs : Infinity;
      while (wordIdx < aligned.length && aligned[wordIdx].startMs < nextStart) {
        if (getTagLength(wordIdx) > 0) break;
        lineWords.push(aligned[wordIdx]);
        wordIdx++;
      }
    } else {
      let addedNonEmpty = 0;
      let addedSignificant = 0;
      
      let targetBreakIdx = -1; 
      let nextRefFirstWord = null;
      if (refWordsCount > 0) {
          for (let k = idx + 1; k < refCues.length; k++) {
              let nextRefText = refCues[k].text.trim();
              if (nextRefText.match(/^\[.*?\]$/) || nextRefText.match(/^\(.*?\)$/)) continue;
              
              const nextRefWords = nextRefText.split(/\s+/).filter(w => w);
              if (nextRefWords.length > 0) {
                  nextRefFirstWord = nextRefWords[0].toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
                  break;
              }
          }

          if (nextRefFirstWord) {
              let tempAdded = 0;
              let tempIdx = wordIdx;
              let matches = [];
              
              let maxWindow = Math.max(refWordsCount + 5, refWordsCount * 3);
              while (tempIdx < aligned.length && tempAdded <= maxWindow) {
                  if (getTagLength(tempIdx) > 0) break;
                  const w = aligned[tempIdx];
                  if (w.text && w.text.trim()) {
                      const clean = w.text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
                      const lowerBound = Math.max(1, Math.floor(refWordsCount / 2) - 1);
                      
                      let isMatch = clean === nextRefFirstWord;
                      if (!isMatch && clean.length >= 3 && nextRefFirstWord.length >= 3) {
                          if (clean.startsWith(nextRefFirstWord) || nextRefFirstWord.startsWith(clean) ||
                              clean.endsWith(nextRefFirstWord) || nextRefFirstWord.endsWith(clean)) {
                              isMatch = true;
                          }
                      }
                      
                      if (isMatch && tempAdded >= lowerBound) {
                          matches.push({ idx: tempIdx, added: tempAdded });
                      }
                      tempAdded++;
                  }
                  tempIdx++;
              }
              
              if (matches.length > 0) {
                  matches.sort((a, b) => {
                      const distA = Math.abs(a.added - refWordsCount);
                      const distB = Math.abs(b.added - refWordsCount);
                      if (distA === distB) return b.added - a.added;
                      return distA - distB;
                  });
                  targetBreakIdx = matches[0].idx;
              }
          }
      }

      while (wordIdx < aligned.length) {
        if (refWordsCount === 0) break;
        if (getTagLength(wordIdx) > 0) break;
        const w = aligned[wordIdx];
        const wIsNonEmpty = w.text && w.text.trim();
        
        if (targetBreakIdx !== -1) {
            if (wordIdx === targetBreakIdx) {
                break;
            }
        } else {
            if (idx < refCues.length - 1) {
                if (wIsNonEmpty && addedSignificant >= refSignificantWordsCount && addedNonEmpty >= refWordsCount) {
                    break;
                }
            }
        }
        
        lineWords.push(w);
        if (wIsNonEmpty) {
          addedNonEmpty++;
          if (w.text.trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").length > 1) {
              addedSignificant++;
          }
        }
        wordIdx++;
      }
      
      const nextRefStart = (idx < refCues.length - 1) ? refCues[idx + 1].startMs : Infinity;
      while (wordIdx < aligned.length && (!aligned[wordIdx].text || !aligned[wordIdx].text.trim())) {
        if (getTagLength(wordIdx) > 0) break;
        if (aligned[wordIdx].startMs >= nextRefStart) break; 
        lineWords.push(aligned[wordIdx]);
        wordIdx++;
      }
    }

    let shouldPreserveEmpty = false;

    if (lineWords.length > 0 || shouldPreserveEmpty) {
      const start = lineWords.length > 0 ? lineWords[0].startMs : (newLines.length > 0 ? Math.max(newLines[newLines.length - 1].endMs, refCue.startMs) : refCue.startMs);
      let end = lineWords.length > 0 ? lineWords[lineWords.length - 1].endMs : (isTimestampBased ? refCue.endMs : start + 500);
      
      if (lineWords.length === 0 && isTimestampBased && wordIdx < aligned.length) {
          end = Math.min(end, aligned[wordIdx].startMs);
      }

      newLines.push({
        id: idx + 1,
        startMs: start,
        endMs: Math.max(start, end),
        text: lineWords.map(w => w.text).join(' '),
        words: lineWords.length > 0 ? lineWords.map((w, widx) => ({ ...w, id: (idx + 1) * 1000 + widx + 1 })) : null
      });
    }
  });

  while (wordIdx < aligned.length) {
      const tagLen = getTagLength(wordIdx);
      if (tagLen > 0) {
          const tagWords = aligned.slice(wordIdx, wordIdx + tagLen);
          newLines.push({
              id: nextLineId++,
              startMs: tagWords[0].startMs,
              endMs: tagWords[tagWords.length - 1].endMs,
              text: tagWords.map(tw => tw.text).join(' '),
              words: tagWords.map((tw) => ({ ...tw, id: nextWordId++ }))
          });
          wordIdx += tagLen;
      } else {
          let tempIdx = wordIdx;
          while (tempIdx < aligned.length && getTagLength(tempIdx) === 0) {
              tempIdx++;
          }
          const rem = aligned.slice(wordIdx, tempIdx);
          newLines.push({
              id: nextLineId++,
              startMs: rem[0].startMs,
              endMs: rem[rem.length - 1].endMs,
              text: rem.map(w => w.text).join(' '),
              words: rem.map((w) => ({ ...w, id: nextWordId++ }))
          });
          wordIdx = tempIdx;
      }
  }
  
  resolveTimingOverlaps(newLines);
  autoFillWords(newLines);
  normalizeLines(newLines);
  lines = newLines;
  pushHistory();
  renderTimeline();
  updateDisplay();
}

function applySmartMergeFromCues(refCues, refFormat) {
  if (!lines.length) return;
  autoFillWords(lines);
  const allWords = [];
  lines.forEach(l => {
      if (l.words) {
          l.words.forEach(w => {
              const text = (w.text || "").trim();
              const isPunctOnly = text !== "" && /^[\.,]+$/.test(text);
              if (isPunctOnly && allWords.length > 0) {
                  const prev = allWords[allWords.length - 1];
                  prev.text = (prev.text || "") + w.text;
                  prev.endMs = Math.max(prev.endMs, w.endMs);
              } else {
                  allWords.push({ ...w, origLineId: l.id });
              }
          });
      }
  });
  if (!allWords.length) return showToast("No words found to merge.", 'warning');

  if (!refCues.length) return showToast("No lines found in reference.", 'warning');

  let nextLineId = Math.max(0, ...lines.map(l => Number(l.id) || 0)) + 1;
  let nextWordId = Math.max(0, ...allWords.map(w => Number(w.id) || 0)) + 1;

  function getTagLength(startIdx) {
      if (startIdx >= allWords.length) return 0;
      const wText = allWords[startIdx].text.trim();
      if (!wText.startsWith('[') && !wText.startsWith('(')) return 0;
      const closeChar = wText.startsWith('[') ? ']' : ')';
      if (wText.endsWith(closeChar)) return 1;
      
      let tempIdx = startIdx + 1;
      while (tempIdx < allWords.length && tempIdx < startIdx + 5) {
          const tText = allWords[tempIdx].text.trim();
          if (tText.endsWith(closeChar)) return (tempIdx - startIdx) + 1;
          if (tText.startsWith('[') || tText.startsWith('(')) return 0;
          tempIdx++;
      }
      return 0;
  }

  const newLines = [];
  let wordIdx = 0;
  const isTimestampBased = refFormat !== 'txt';

  refCues.forEach((refCue, idx) => {
    while (wordIdx < allWords.length) {
        const tagLen = getTagLength(wordIdx);
        if (tagLen > 0) {
            const tagWords = allWords.slice(wordIdx, wordIdx + tagLen);
            newLines.push({
                id: nextLineId++,
                startMs: tagWords[0].startMs,
                endMs: tagWords[tagWords.length - 1].endMs,
                text: tagWords.map(tw => tw.text).join(' '),
                words: tagWords.map((tw) => ({ ...tw, id: nextWordId++ }))
            });
            wordIdx += tagLen;
        } else {
            break;
        }
    }

    let refText = refCue.text.trim();
    if (refText.match(/^\[.*?\]$/) || refText.match(/^\(.*?\)$/)) {
        refText = "";
    }
    
    let lineWords = [];

    // Smart logic: prioritize text phrasing if the reference cue has text.
    // This avoids loose line-level timestamps from "sucking in" words from the next phrase.
    const refWords = refText.split(/\s+/).filter(w => w);
    const refWordsCount = refWords.length;
    const refSignificantWordsCount = refWords.filter(w => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").length > 1).length;
    
    let mode = (isTimestampBased && refCue.text.trim() === "") ? 'time' : 'text';
    
    // If we have timestamps but the text also exists, check if the text matches the pool.
    // If it doesn't match, we assume it's a translation/different track and use temporal logic.
    if (mode === 'text' && isTimestampBased && refWordsCount > 0) {
        const poolWord = allWords[wordIdx] ? allWords[wordIdx].text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"") : null;
        const firstRefWord = refWords[0].toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
        
        // If the first word doesn't match, fall back to time-based grouping.
        if (poolWord && poolWord !== firstRefWord) {
            mode = 'time';
        }
    }

    if (mode === 'time') {
      const nextStart = (idx < refCues.length - 1) ? refCues[idx + 1].startMs : Infinity;
      while (wordIdx < allWords.length && allWords[wordIdx].startMs < nextStart) {
        if (getTagLength(wordIdx) > 0) break;
        lineWords.push(allWords[wordIdx]);
        wordIdx++;
      }
    } else {
      let addedNonEmpty = 0;
      let addedSignificant = 0;
      
      let targetBreakIdx = -1; 
      let nextRefFirstWord = null;
      if (refWordsCount > 0) {
          for (let k = idx + 1; k < refCues.length; k++) {
              let nextRefText = refCues[k].text.trim();
              if (nextRefText.match(/^\[.*?\]$/) || nextRefText.match(/^\(.*?\)$/)) continue;
              
              const nextRefWords = nextRefText.split(/\s+/).filter(w => w);
              if (nextRefWords.length > 0) {
                  nextRefFirstWord = nextRefWords[0].toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
                  break;
              }
          }

          if (nextRefFirstWord) {
              let tempAdded = 0;
              let tempIdx = wordIdx;
              let matches = [];
              
              let maxWindow = Math.max(refWordsCount + 5, refWordsCount * 3);
              while (tempIdx < allWords.length && tempAdded <= maxWindow) {
                  if (getTagLength(tempIdx) > 0) break;
                  const w = allWords[tempIdx];
                  if (w.text && w.text.trim()) {
                      const clean = w.text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
                      const lowerBound = Math.max(1, Math.floor(refWordsCount / 2) - 1);
                      
                      let isMatch = clean === nextRefFirstWord;
                      if (!isMatch && clean.length >= 3 && nextRefFirstWord.length >= 3) {
                          if (clean.startsWith(nextRefFirstWord) || nextRefFirstWord.startsWith(clean) ||
                              clean.endsWith(nextRefFirstWord) || nextRefFirstWord.endsWith(clean)) {
                              isMatch = true;
                          }
                      }
                      
                      if (isMatch && tempAdded >= lowerBound) {
                          matches.push({ idx: tempIdx, added: tempAdded });
                      }
                      tempAdded++;
                  }
                  tempIdx++;
              }
              
              if (matches.length > 0) {
                  matches.sort((a, b) => {
                      const distA = Math.abs(a.added - refWordsCount);
                      const distB = Math.abs(b.added - refWordsCount);
                      if (distA === distB) return b.added - a.added;
                      return distA - distB;
                  });
                  targetBreakIdx = matches[0].idx;
              }
          }
      }

      while (wordIdx < allWords.length) {
        if (refWordsCount === 0) break;
        if (getTagLength(wordIdx) > 0) break;
        const w = allWords[wordIdx];
        const wIsNonEmpty = w.text && w.text.trim();
        
        if (targetBreakIdx !== -1) {
            if (wordIdx === targetBreakIdx) {
                break;
            }
        } else {
            if (idx < refCues.length - 1) {
                if (wIsNonEmpty && addedSignificant >= refSignificantWordsCount && addedNonEmpty >= refWordsCount) {
                    break;
                }
            }
        }
        
        lineWords.push(w);
        if (wIsNonEmpty) {
          addedNonEmpty++;
          if (w.text.trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").length > 1) {
              addedSignificant++;
          }
        }
        wordIdx++;
      }
      // Peek ahead: if there are trailing blank words before the next non-empty word, 
      // include them in the current line to preserve the silence/timing gap.
      // CRITICAL: We stop if we hit the start of the next reference cue to avoid stealing words from it.
      const nextRefStart = (idx < refCues.length - 1) ? refCues[idx + 1].startMs : Infinity;
      while (wordIdx < allWords.length && (!allWords[wordIdx].text || !allWords[wordIdx].text.trim())) {
        if (getTagLength(wordIdx) > 0) break;
        if (allWords[wordIdx].startMs >= nextRefStart) break; 
        lineWords.push(allWords[wordIdx]);
        wordIdx++;
      }
    }

    let shouldPreserveEmpty = false;

    // Preserve the line if it has words OR if it's a valid empty line
    if (lineWords.length > 0 || shouldPreserveEmpty) {
      const start = lineWords.length > 0 ? lineWords[0].startMs : (newLines.length > 0 ? Math.max(newLines[newLines.length - 1].endMs, refCue.startMs) : refCue.startMs);
      let end = lineWords.length > 0 ? lineWords[lineWords.length - 1].endMs : (isTimestampBased ? refCue.endMs : start + 500);
      
      // For timestamp based empty lines, ensure they don't overlap with the next word's start
      if (lineWords.length === 0 && isTimestampBased && wordIdx < allWords.length) {
          end = Math.min(end, allWords[wordIdx].startMs);
      }

      newLines.push({
        id: idx + 1,
        startMs: start,
        endMs: Math.max(start, end),
        text: lineWords.map(w => w.text).join(' '),
        words: lineWords.length > 0 ? lineWords.map((w, widx) => ({ ...w, id: (idx + 1) * 1000 + widx + 1 })) : null
      });
    }
  });

  while (wordIdx < allWords.length) {
      const tagLen = getTagLength(wordIdx);
      if (tagLen > 0) {
          const tagWords = allWords.slice(wordIdx, wordIdx + tagLen);
          newLines.push({
              id: nextLineId++,
              startMs: tagWords[0].startMs,
              endMs: tagWords[tagWords.length - 1].endMs,
              text: tagWords.map(tw => tw.text).join(' '),
              words: tagWords.map((tw) => ({ ...tw, id: nextWordId++ }))
          });
          wordIdx += tagLen;
      } else {
          let tempIdx = wordIdx;
          while (tempIdx < allWords.length && getTagLength(tempIdx) === 0) {
              tempIdx++;
          }
          const rem = allWords.slice(wordIdx, tempIdx);
          newLines.push({
              id: nextLineId++,
              startMs: rem[0].startMs,
              endMs: rem[rem.length - 1].endMs,
              text: rem.map(w => w.text).join(' '),
              words: rem.map((w) => ({ ...w, id: nextWordId++ }))
          });
          wordIdx = tempIdx;
      }
  }
  
  resolveTimingOverlaps(newLines);
  autoFillWords(newLines);
  normalizeLines(newLines);
  lines = newLines;
  pushHistory();
  renderTimeline();
  updateDisplay();
}

$('tool-remove-overlaps').onclick=()=>{
    const minD = 20;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].endMs > lines[i + 1].startMs) {
            // Fix line overlap
            lines[i].endMs = lines[i + 1].startMs;
            // Fix word overlaps within that line
            if (lines[i].words && lines[i].words.length > 0) {
                lines[i].words.forEach(w => {
                    if (w.startMs > lines[i].endMs) w.startMs = Math.max(lines[i].startMs, lines[i].endMs - minD);
                    if (w.endMs > lines[i].endMs) w.endMs = lines[i].endMs;
                });
                for (let j = 0; j < lines[i].words.length - 1; j++) {
                    if (lines[i].words[j].endMs > lines[i].words[j + 1].startMs) {
                        lines[i].words[j + 1].startMs = lines[i].words[j].endMs;
                        if (lines[i].words[j + 1].endMs < lines[i].words[j + 1].startMs + minD) {
                            lines[i].words[j + 1].endMs = lines[i].words[j + 1].startMs + minD;
                        }
                    }
                }
            }
        }
    }
    pushHistory(); renderTimeline(); $('tools-menu').classList.remove('open');
};

$('tool-sequentialize-cascade').onclick = () => {
    let changed = false;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].endMs > lines[i + 1].startMs) {
            const diff = lines[i].endMs - lines[i + 1].startMs;
            // Push this line and all subsequent lines forward
            for (let k = i + 1; k < lines.length; k++) {
                lines[k].startMs += diff;
                lines[k].endMs += diff;
                if (lines[k].words) {
                    lines[k].words.forEach(w => {
                        w.startMs += diff;
                        w.endMs += diff;
                    });
                }
            }
            changed = true;
        }
    }
    if (changed) {
        pushHistory();
        renderTimeline();
    }
    $('tools-menu').classList.remove('open');
};
$('tool-merge-lines').onclick = () => { mergeSelectedLines(); $('tools-menu').classList.remove('open'); };
$('btn-merge-header').onclick = mergeSelectedLines;

$('btn-smart-merge-header').onclick = () => openSmartMergeModal('merge');
$('btn-smart-replace-header').onclick = () => openSmartMergeModal('replace');
$('tool-smart-merge').onclick = () => { $('tools-menu').classList.remove('open'); openSmartMergeModal('merge'); };
$('tool-smart-replace').onclick = () => { $('tools-menu').classList.remove('open'); openSmartMergeModal('replace'); };
$('tool-smart-combined').onclick = () => { $('tools-menu').classList.remove('open'); openSmartMergeModal('combined'); };

$('smart-merge-cancel').onclick = () => $('smart-merge-modal').style.display = 'none';
$('smart-merge-close-top').onclick = () => $('smart-merge-modal').style.display = 'none';
$('smart-merge-select-file').onclick = () => {
    $('smart-merge-modal').style.display = 'none';
    $('input-smart-merge').click();
};

$('input-smart-merge').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    const content = ev.target.result;
    applySmartMerge(content, detectFormat(f.name, content));
  };
  r.readAsText(f);
  e.target.value = '';
};

let linesToSplit = [];
function openSplitModal() {
  const checks=Array.from(document.querySelectorAll('.line-checkbox:checked')).map(c=>Number(c.dataset.id));
  if(checks.length === 0) return showToast("Please select at least one line to split.", 'warning');
  linesToSplit = lines.filter(l=>checks.includes(l.id));
  
  if (linesToSplit.length === 1) {
    const l = linesToSplit[0];
    const maxW = (l.words && l.words.length > 0) ? l.words.length - 1 : (l.text.trim().split(/\s+/).length - 1);
    if(maxW < 1) return showToast("Line only has 1 word — cannot split.", 'warning');
    $('split-word-container').style.opacity = '1';
    $('split-method-word').disabled = false;
    $('split-word-index').max = maxW;
    $('split-word-index').value = Math.max(1, Math.floor((maxW+1)/2));
    updateSplitPreview();
  } else {
    $('split-method-word').disabled = true;
    $('split-word-container').style.opacity = '0.5';
    document.querySelector('input[name="split-method"][value="auto"]').checked = true;
    $('split-word-index').disabled = true;
    $('split-word-preview').textContent = "Auto only for multiple lines";
  }
  $('split-line-modal').style.display='flex';
}

$('btn-split-header').onclick = openSplitModal;
$('tool-split-lines').onclick = () => {
  $('tools-menu').classList.remove('open');
  openSplitModal();
};

$('split-cancel').onclick = () => $('split-line-modal').style.display='none';
function updateSplitPreview() {
    if (linesToSplit.length !== 1) return;
    const idx = parseInt($('split-word-index').value);
    const l = linesToSplit[0];
    const ws = (l.words && l.words.length > 0) ? l.words.map(w=>w.text) : l.text.trim().split(/\s+/);
    if(idx > 0 && idx < ws.length) $('split-word-preview').textContent = `... ${ws[idx-1]} | ${ws[idx]} ...`;
    else $('split-word-preview').textContent = "";
}
$('split-word-index').oninput = updateSplitPreview;
document.querySelectorAll('input[name="split-method"]').forEach(r => {
    r.onchange = () => {
        if(r.value === 'word') { $('split-word-index').disabled = false; updateSplitPreview(); }
        else { $('split-word-index').disabled = true; $('split-word-preview').textContent = ""; }
    };
});

$('split-apply').onclick=()=>{
  const method = document.querySelector('input[name="split-method"]:checked').value;
  const splitWordIdx = parseInt($('split-word-index').value);
  const newLines=[];
  let maxId = lines.reduce((m, l) => {
    const idNum = Number(l.id);
    return isNaN(idNum) ? m : Math.max(m, idNum);
  }, 0);
  maxId = Math.floor(maxId);
  const checks = linesToSplit.map(l=>l.id);
  
  lines.forEach(l=>{
    if(checks.includes(l.id)){
      let splitIdx=0;
      if (method === 'word' && linesToSplit.length === 1) splitIdx = splitWordIdx;
      else {
          if(l.words&&l.words.length>1){
              let maxGap=-1;for(let i=0;i<l.words.length-1;i++){let gap=l.words[i+1].startMs-l.words[i].endMs;if(gap>maxGap){maxGap=gap;splitIdx=i+1;}}
          }else{
              const ws=l.text.trim().split(/\s+/);if(ws.length>1)splitIdx=Math.floor(ws.length/2);
          }
      }
      if(splitIdx>0 && splitIdx < ((l.words && l.words.length > 0) ? l.words.length : l.text.trim().split(/\s+/).length)){
          let words1=(l.words && l.words.length > 0)?l.words.slice(0,splitIdx):[];
          let words2=(l.words && l.words.length > 0)?l.words.slice(splitIdx):[];
          let text1=(l.words && l.words.length > 0)?words1.map(w=>w.text).join(' '):l.text.trim().split(/\s+/).slice(0,splitIdx).join(' ');
          let text2=(l.words && l.words.length > 0)?words2.map(w=>w.text).join(' '):l.text.trim().split(/\s+/).slice(splitIdx).join(' ');
          let end1=words1.length?words1[words1.length-1].endMs:l.startMs+(l.endMs-l.startMs)/2;
          let start2=words2.length?words2[0].startMs:end1;
          newLines.push({id:l.id,startMs:l.startMs,endMs:end1,text:text1,words:words1});
          maxId++;
          newLines.push({id:maxId,startMs:start2,endMs:l.endMs,text:text2,words:words2});
      }else newLines.push(l);
    }else newLines.push(l);
  });
  lines=newLines;
  pushHistory();renderTimeline();
  $('split-line-modal').style.display='none';
};

$('tool-sync-line-words').onclick=()=>{lines.forEach(l=>{if(l.words&&l.words.length){l.startMs=l.words[0].startMs;l.endMs=l.words[l.words.length-1].endMs;}});pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};

$('tool-format-text').onclick=()=>{$('tools-menu').classList.remove('open');$('format-text-modal').style.display='flex';};
$('format-cancel').onclick=()=>$('format-text-modal').style.display='none';
const applyFormat=(type)=>{const checks=document.querySelectorAll('.line-checkbox:checked');const sIds=Array.from(checks).map(c=>parseInt(c.dataset.id));const tgts=sIds.length?lines.filter(l=>sIds.includes(l.id)):lines;tgts.forEach(l=>{if(type==='upper')l.text=l.text.toUpperCase();else if(type==='lower')l.text=l.text.toLowerCase();else if(type==='title')l.text=l.text.split(' ').map(w=>w?w[0].toUpperCase()+w.slice(1).toLowerCase():'').join(' ');else if(type==='sentence')l.text=l.text?l.text[0].toUpperCase()+l.text.slice(1).toLowerCase():'';if(l.words&&l.words.length===l.text.split(' ').length){const ws=l.text.split(' ');l.words.forEach((w,i)=>w.text=ws[i]);}});pushHistory();renderTimeline();$('format-text-modal').style.display='none';};
$('format-title-case').onclick=()=>applyFormat('title');$('format-sentence-case').onclick=()=>applyFormat('sentence');$('format-uppercase').onclick=()=>applyFormat('upper');$('format-lowercase').onclick=()=>applyFormat('lower');

$('tool-remove-punct').onclick=()=>{lines.forEach(l=>{l.text=l.text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()â™ª]/g,"");if(l.words)l.words.forEach(w=>w.text=w.text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()â™ª]/g,""));});pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-clear-words').onclick=()=>{lines.forEach(l=>l.words=[]);pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-distribute-words').onclick=()=>{const checks=document.querySelectorAll('.line-checkbox:checked');const sIds=Array.from(checks).map(c=>parseInt(c.dataset.id));const tgts=sIds.length?lines.filter(l=>sIds.includes(l.id)):lines;tgts.forEach(l=>{if(l.words&&l.words.length){const p=(l.endMs-l.startMs)/l.words.length;l.words.forEach((w,i)=>{w.startMs=Math.round(l.startMs+p*i);w.endMs=Math.round(l.startMs+p*(i+1));});}});pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-merge-words-in-lines').onclick=()=>{
  const checks=document.querySelectorAll('.line-checkbox:checked');
  const sIds=Array.from(checks).map(c=>Number(c.dataset.id));
  const tgts=sIds.length?lines.filter(l=>sIds.includes(l.id)):lines;
  tgts.forEach(l=>{
    if(l.words && l.words.length > 0){
      const startMs = l.words[0].startMs;
      const endMs = l.words[l.words.length - 1].endMs;
      l.words = [{ id: Math.floor(Math.random() * 1000000), text: l.text.trim(), startMs, endMs }];
    }
  });
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};

$('tool-join-words').onclick=()=>{
  const checks=document.querySelectorAll('.line-checkbox:checked');
  const sIds=Array.from(checks).map(c=>Number(c.dataset.id));
  const tgts=sIds.length?lines.filter(l=>sIds.includes(l.id)):lines;
  tgts.forEach(l=>{
    l.text = l.text.replace(/\s+/g, '');
    if(l.words && l.words.length > 0){
        const startMs = l.words[0].startMs;
        const endMs = l.words[l.words.length - 1].endMs;
        l.words = [{ id: Math.floor(Math.random() * 1000000), text: l.text, startMs, endMs }];
    }
  });
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};

$('tool-auto-karaoke').onclick=()=>{autoFillWords(lines);let wid=1;lines.forEach(l=>{if(l.words)l.words.forEach(w=>w.id=wid++);});pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-fill-gaps').onclick=()=>{
  lines.forEach(c=>{if(c.words&&c.words.length){c.words[0].startMs=c.startMs;for(let i=0;i<c.words.length-1;i++)c.words[i].endMs=c.words[i+1].startMs;c.words[c.words.length-1].endMs=c.endMs;}});
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};
$('tool-remove-word-overlaps').onclick=()=>{
  lines.forEach(l=>{
    if(l.words && l.words.length > 0){
      const minD = 20;
      // First pass: ensure all words have min duration
      l.words.forEach(w => {
        if(w.endMs < w.startMs + minD) w.endMs = w.startMs + minD;
      });
      // Second pass: resolve overlaps sequentially
      for(let i=0; i<l.words.length-1; i++){
        if(l.words[i].endMs > l.words[i+1].startMs){
          l.words[i+1].startMs = l.words[i].endMs;
          if(l.words[i+1].endMs < l.words[i+1].startMs + minD){
            l.words[i+1].endMs = l.words[i+1].startMs + minD;
          }
        }
      }
      // Final check: clamp to line end if possible, but respect min duration
      if(l.words[l.words.length-1].endMs > l.endMs) {
          // Try to fit the words back into the line if they were pushed out
          if (l.words[0].startMs >= l.startMs) {
              // Only pull back if it doesn't break min duration
              // But for simplicity, we just let it exceed if it must, or clamp if it can.
              l.words[l.words.length-1].endMs = Math.max(l.words[l.words.length-1].startMs + minD, l.endMs);
          }
      }
    }
  });
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};
function mergeEmptyWordsInLine(l) {
  if(!l.words || !l.words.length) return;
  
  // 1. Initial cleanup: remove truly invalid blocks (zero duration or zero timestamps)
  l.words = l.words.filter(w => {
      const t = (w.text || "").trim();
      if (t && t !== "\\" && t !== "\"") return true; // Keep real words
      if (w.endMs <= w.startMs) return false;
      if (w.startMs === 0 && w.endMs === 0) return false;
      return true; // Keep valid blank durations for merging
  });

  if(l.words.length < 2) return;

  // 2. Pass 1: Merge blanks into previous word
  const pass1 = [];
  l.words.forEach(w => {
    const t = (w.text || "").trim();
    const isBlank = !t || t === "\\";
    if(!isBlank) {
      pass1.push({...w});
    } else {
      if(pass1.length > 0) {
        pass1[pass1.length - 1].endMs = w.endMs;
      } else {
        pass1.push({...w, text: ""});
      }
    }
  });

  // 3. Pass 2: Merge leading blanks into the first real word
  let finalWs = pass1;
  const firstRealIdx = pass1.findIndex(w => (w.text || "").trim());
  if (firstRealIdx !== -1 && firstRealIdx > 0) {
      const startMs = pass1[0].startMs;
      finalWs = pass1.slice(firstRealIdx);
      finalWs[0].startMs = startMs;
  }
  
  l.words = finalWs;
  // Sync the line text to the remaining words
  l.text = l.words.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
}

$('tool-remove-empty').onclick=()=>{
  lines.forEach(l=>mergeEmptyWordsInLine(l));
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};
$('tool-compact-ws').onclick=()=>{
  lines.forEach(l=>{l.text=l.text.replace(/\s+/g,' ').trim();if(l.words)l.words.forEach(w=>w.text=w.text.trim());});
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};

// Hot Fix (one-click combo)
function performHotFix() {
  waveformCache.clear();
  
  // 1. Text & Basic cleanup
  lines.forEach(l => {
    l.text = (l.text || "").replace(/\s+/g,' ').trim();
    if(l.words) {
      l.words.forEach(w => w.text = (w.text || "").trim());
      // 2. Advanced Word-level merging (Remove Blanks & Merge Duration)
      mergeEmptyWordsInLine(l);
    }
  });
  
  // 3. Resolve Line-Level Overlaps & Word Jumps
  const minD = 20;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].endMs > lines[i + 1].startMs) {
      lines[i].endMs = lines[i + 1].startMs;
      // Sync words to line boundary
      if (lines[i].words && lines[i].words.length > 0) {
        lines[i].words.forEach(w => {
          if (w.startMs > lines[i].endMs) w.startMs = Math.max(lines[i].startMs, lines[i].endMs - minD);
          if (w.endMs > lines[i].endMs) w.endMs = lines[i].endMs;
        });
        for (let j = 0; j < lines[i].words.length - 1; j++) {
          if (lines[i].words[j].endMs > lines[i].words[j + 1].startMs) {
              lines[i].words[j + 1].startMs = lines[i].words[j].endMs;
              if (lines[i].words[j + 1].endMs < lines[i].words[j + 1].startMs + minD) {
                  lines[i].words[j + 1].endMs = lines[i].words[j + 1].startMs + minD;
              }
          }
        }
      }
    }
  }

  // 4. Final Gap Fill (Ensure full word coverage within lines)
  lines.forEach(l => {
    if (l.words && l.words.length > 0) {
      l.words[0].startMs = l.startMs;
      for (let i = 0; i < l.words.length - 1; i++) {
        l.words[i].endMs = l.words[i + 1].startMs;
      }
      l.words[l.words.length - 1].endMs = l.endMs;
    }
  });
  
  pushHistory();
  renderTimeline();
}

$('btn-hotfix').onclick = performHotFix;
$('tool-hotfix').onclick = () => { performHotFix(); $('tools-menu').classList.remove('open'); };

// Shift Time Modal
$('shift-minus-500').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)-500;
$('shift-minus-100').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)-100;
$('shift-plus-100').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)+100;
$('shift-plus-500').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)+500;
$('shift-cancel').onclick=()=>$('shift-modal').style.display='none';
$('shift-apply').onclick=()=>{
const ms=parseInt($('shift-amount').value)||0;
  const checks = document.querySelectorAll('.line-checkbox:checked');
  const selectedIds = Array.from(checks).map(c => Number(c.dataset.id));
  const targetLines = selectedIds.length ? lines.filter(l => selectedIds.includes(l.id)) : lines;
  targetLines.forEach(l=>{l.startMs=Math.max(0,l.startMs+ms);l.endMs=Math.max(0,l.endMs+ms);if(l.words)l.words.forEach(w=>{w.startMs=Math.max(0,w.startMs+ms);w.endMs=Math.max(0,w.endMs+ms);});});
  pushHistory();renderTimeline();$('shift-modal').style.display='none';
};

// Selection Logic
$('check-all-lines').onclick = (e) => {
    const cbs = document.querySelectorAll('.line-checkbox');
    const checkedCount = document.querySelectorAll('.line-checkbox:checked').length;
    
    // If some or all lines are selected, the next state should be "none" (unchecked).
    // If no lines are selected, the next state should be "all" (checked).
    const nextState = checkedCount === 0;
    
    cbs.forEach(cb => cb.checked = nextState);
    updateSelectionCount();
};

function updateSelectionCount() {
    const cbs = document.querySelectorAll('.line-checkbox');
    const checked = document.querySelectorAll('.line-checkbox:checked');
    const master = $('check-all-lines');
    const label = $('check-all-label');
    const delLabel = $('delete-selected-label');

    // Reflect selection on track cards
    cbs.forEach(cb => {
        const tr = cb.closest('.timeline-track');
        if (tr) tr.classList.toggle('selected', cb.checked);
    });

    if (label) {
        label.textContent = checked.length === 0 ? "Select All / None" : `Select All / None (${checked.length})`;
    }
    if (delLabel) {
        delLabel.textContent = checked.length === 0 ? "Delete Selected" : `Delete Selected (${checked.length})`;
    }

    if (checked.length === 0) {
        master.checked = false;
        master.indeterminate = false;
    } else if (checked.length === cbs.length) {
        master.checked = true;
        master.indeterminate = false;
    } else {
        master.checked = false;
        master.indeterminate = true;
    }
}

// Find & Replace Modal
$('fr-cancel').onclick=()=>$('find-replace-modal').style.display='none';
$('fr-apply').onclick=()=>{
  const f=$('find-text').value, r=$('replace-text').value;
  if(!f)return;
  const checks = document.querySelectorAll('.line-checkbox:checked');
  const selectedIds = Array.from(checks).map(c => Number(c.dataset.id));
  const targetLines = selectedIds.length ? lines.filter(l => selectedIds.includes(l.id)) : lines;
  targetLines.forEach(l=>{l.text=l.text.split(f).join(r);if(l.words)l.words.forEach(w=>w.text=w.text.split(f).join(r));});
  pushHistory();renderTimeline();$('find-replace-modal').style.display='none';
};

// Edit Text Modal
$('et-cancel').onclick = () => $('edit-text-modal').style.display = 'none';

function updateEditHighlighter() {
    const text = $('edit-text-input').value;
    const highlighted = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\/g, (m, offset, str) => {
            const prev = str[offset - 1];
            const next = str[offset + 1];
            const isStandalone = (!prev || /\s/.test(prev)) && (!next || /\s/.test(next));
            return isStandalone ? `<span class="marker-highlight">\\</span>` : '\\';
        });
    $('edit-text-backdrop').innerHTML = highlighted + (text.endsWith('\n') ? ' ' : '');
}

let editSyncInterval = null;
function startEditSync() {
    if (editSyncInterval) clearInterval(editSyncInterval);
    editSyncInterval = setInterval(() => {
        const input = $('edit-text-input');
        const backdrop = $('edit-text-backdrop');
        if (!input || !backdrop) return;
        if (backdrop.scrollTop !== input.scrollTop) backdrop.scrollTop = input.scrollTop;
        if (backdrop.scrollLeft !== input.scrollLeft) backdrop.scrollLeft = input.scrollLeft;
        
        // If modal closed, stop sync
        if ($('edit-text-modal').style.display === 'none') {
            clearInterval(editSyncInterval);
            editSyncInterval = null;
        }
    }, 32); 
}

$('edit-text-input').oninput = () => {
    updateEditHighlighter();
    // Debounce pushing to history or push on significant changes?
    // For now, push on every input but maybe debounced is better.
    pushModalHistory(); 
};
$('edit-text-input').onscroll = () => {
    $('edit-text-backdrop').scrollTop = $('edit-text-input').scrollTop;
    $('edit-text-backdrop').scrollLeft = $('edit-text-input').scrollLeft;
};

// Local Shortcuts
$('edit-text-input').onkeydown = (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        modalUndo();
    }
    if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        e.stopPropagation();
        modalRedo();
    }
};

// Mouse-based text drag-and-drop for edit textarea
(function() {
    const input = $('edit-text-input');
    const dropCursor = $('edit-drop-cursor');
    let drag = null;

    // Get character index + visual position at a given screen coordinate
    function charPosAt(cx, cy) {
        const text = input.value;
        if (!text) return { idx: 0, x: 0, y: 0 };
        const cs = getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        const padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop);
        const bdrL = parseFloat(cs.borderLeftWidth), bdrT = parseFloat(cs.borderTopWidth);
        const relX = cx - rect.left - padL - bdrL + input.scrollLeft;
        const relY = cy - rect.top - padT - bdrT + input.scrollTop;

        const m = document.createElement('div');
        ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
         'wordSpacing','whiteSpace','wordWrap','overflowWrap','boxSizing'].forEach(p => m.style[p] = cs[p]);
        m.style.width = (input.clientWidth - padL - parseFloat(cs.paddingRight)) + 'px';
        m.style.position = 'fixed'; m.style.left = '-9999px'; m.style.top = '0';
        m.style.visibility = 'hidden'; m.style.height = 'auto';
        m.style.padding = '0'; m.style.border = 'none';
        document.body.appendChild(m);

        let best = 0, bestD = Infinity, bestX = 0, bestY = 0;
        for (let i = 0; i <= text.length; i++) {
            m.textContent = '';
            const sp = document.createElement('span');
            sp.textContent = text.substring(0, i);
            const mk = document.createElement('span');
            mk.textContent = '\u200b';
            m.appendChild(sp); m.appendChild(mk);
            m.appendChild(document.createTextNode(text.substring(i)));
            const mr = m.getBoundingClientRect(), mkr = mk.getBoundingClientRect();
            const charX = mkr.left - mr.left, charY = mkr.top - mr.top;
            const dx = charX - relX, dy = charY - relY;
            const d = Math.abs(dy) * 10000 + Math.abs(dx);
            if (d < bestD) { bestD = d; best = i; bestX = charX; bestY = charY; }
        }
        document.body.removeChild(m);
        // Convert back to screen-relative coords within the wrapper
        return { idx: best, x: padL + bdrL + bestX - input.scrollLeft, y: padT + bdrT + bestY - input.scrollTop };
    }

    function showDropCursor(x, y) {
        dropCursor.style.display = 'block';
        dropCursor.style.left = x + 'px';
        dropCursor.style.top = y + 'px';
    }

    function hideDropCursor() {
        dropCursor.style.display = 'none';
    }

    input.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const s = input.selectionStart, ed = input.selectionEnd;
        if (s === ed) return;
        const { idx } = charPosAt(e.clientX, e.clientY);
        if (idx >= s && idx <= ed) {
            e.preventDefault();
            drag = { text: input.value.substring(s, ed), start: s, end: ed,
                     sx: e.clientX, sy: e.clientY, active: false };
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        if (!drag.active && (Math.abs(e.clientX - drag.sx) > 3 || Math.abs(e.clientY - drag.sy) > 3)) {
            drag.active = true;
            input.style.cursor = 'grabbing';
        }
        if (drag.active) {
            const { idx, x, y } = charPosAt(e.clientX, e.clientY);
            if (idx < drag.start || idx > drag.end) {
                showDropCursor(x, y);
            } else {
                hideDropCursor();
            }
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (!drag) return;
        input.style.cursor = '';
        hideDropCursor();
        if (drag.active) {
            const { idx: dropPos } = charPosAt(e.clientX, e.clientY);
            const { text: dragged, start: os, end: oe } = drag;
            if (dropPos < os || dropPos > oe) {
                const val = input.value;
                let nv, cur;
                if (dropPos < os) {
                    nv = val.substring(0, dropPos) + dragged + val.substring(dropPos, os) + val.substring(oe);
                    cur = dropPos + dragged.length;
                } else {
                    nv = val.substring(0, os) + val.substring(oe, dropPos) + dragged + val.substring(dropPos);
                    cur = dropPos - (oe - os) + dragged.length;
                }
                input.value = nv;
                input.setSelectionRange(cur - dragged.length, cur);
                updateEditHighlighter();
                pushModalHistory();
            }
        } else {
            const { idx } = charPosAt(e.clientX, e.clientY);
            input.setSelectionRange(idx, idx);
        }
        drag = null;
    });
})();

// Sync highlighter on other interactions
['change', 'blur'].forEach(evt => {
    $('edit-text-input').addEventListener(evt, () => {
        setTimeout(() => { updateEditHighlighter(); }, 10);
    });
});

$('btn-edit-undo').onclick = modalUndo;
$('btn-edit-redo').onclick = modalRedo;

$('btn-insert-blank').onclick = () => {
    const input = $('edit-text-input');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = input.value;
    const insert = " \\ ";
    input.value = text.substring(0, start) + insert + text.substring(end);
    updateEditHighlighter();
    pushModalHistory();
    input.focus();
    input.selectionStart = input.selectionEnd = start + insert.length;
};

$('btn-remove-blank').onclick = () => {
    const input = $('edit-text-input');
    // Remove \ and up to one space on each side to cleanly rejoin split words like "ente \ rpr \ ise"
    input.value = input.value.replace(/\s?[\\]\s?/g, '').replace(/\s+/g, ' ').trim();
    updateEditHighlighter();
    pushModalHistory();
    input.focus();
};

$('btn-join-words').onclick = () => {
    const input = $('edit-text-input');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    
    if (start !== end) {
        // Join only selected text
        const selectedText = input.value.substring(start, end);
        const joined = selectedText.replace(/\s+/g, '');
        input.value = input.value.substring(0, start) + joined + input.value.substring(end);
        // Restore selection to the joined part
        input.setSelectionRange(start, start + joined.length);
    } else {
        // Join all text (existing behavior)
        input.value = input.value.replace(/\s+/g, '');
    }
    
    updateEditHighlighter();
    pushModalHistory();
    input.focus();
};


$('sw-inc').onclick = () => {
    const el = $('split-word-index');
    if (el.disabled) return;
    const val = parseInt(el.value) || 1;
    const max = parseInt(el.max) || 999;
    if (val < max) {
        el.value = val + 1;
        updateSplitPreview();
    }
};
$('sw-dec').onclick = () => {
    const el = $('split-word-index');
    if (el.disabled) return;
    const val = parseInt(el.value) || 1;
    if (val > 1) {
        el.value = val - 1;
        updateSplitPreview();
    }
};

function formatWordsForEdit(line) {
  if (!line.words || line.words.length === 0) {
    let txt = line.text ? line.text.replace(/\s+/g, ' ').trim() : "";
    if (line.isBackground || line.role === 'x-bg') {
      if (!txt.startsWith('(') && !txt.endsWith(')')) txt = `(${txt})`;
    }
    return txt;
  }
  
  const isLineBg = !!(line.isBackground || line.role === 'x-bg');
  let formatted = [];
  let inBgGroup = false;

  for (let i = 0; i < line.words.length; i++) {
    const w = line.words[i];
    let wText = (w.text !== undefined && w.text !== null && w.text !== "") ? w.text : "\\";
    const isBg = !!(w.isBackground || w.role === 'x-bg' || isLineBg);
    
    const hasOpen = wText.startsWith('(');
    const hasClose = wText.endsWith(')');

    if (isBg && !inBgGroup && !hasOpen) {
      formatted.push('(' + wText);
      inBgGroup = true;
    } else if (!isBg && inBgGroup) {
      if (formatted.length > 0 && !formatted[formatted.length - 1].endsWith(')')) {
        formatted[formatted.length - 1] += ')';
      }
      inBgGroup = false;
      formatted.push(wText);
    } else {
      formatted.push(wText);
    }

    if (hasClose && inBgGroup) {
      inBgGroup = false;
    }
  }

  if (inBgGroup && formatted.length > 0 && !formatted[formatted.length - 1].endsWith(')')) {
    formatted[formatted.length - 1] += ')';
  }

  return formatted.join(' ');
}

function parseEditTokens(inputVal, lineIsBg = false) {
  const rawParts = inputVal.replace(/([\\])/g, ' $1 ').split(/\s+/).filter(t => t);
  const tokens = [];
  let inParenthesis = false;

  for (let i = 0; i < rawParts.length; i++) {
    let t = rawParts[i];
    
    let openCount = 0;
    while (t.startsWith('(')) {
      openCount++;
      t = t.slice(1);
    }
    
    let closeCount = 0;
    while (t.endsWith(')')) {
      closeCount++;
      t = t.slice(0, -1);
    }

    if (openCount > 0) {
      inParenthesis = true;
    }

    const currentBg = inParenthesis || lineIsBg;

    if (t !== '') {
      tokens.push({
        text: (t === '\\') ? '' : t,
        rawText: t,
        isBackground: currentBg,
        tokenIdx: tokens.length
      });
    }

    if (closeCount > 0) {
      inParenthesis = false;
    }
  }

  return tokens;
}

$('et-apply').onclick = () => {
  const inputVal = $('edit-text-input').value.trim();
  if (editingLine) {
    const isLineBg = !!(editingLine.isBackground || editingLine.role === 'x-bg');
    const newTokens = parseEditTokens(inputVal, isLineBg);
    
    if (newTokens.length === 0) {
      editingLine.words = [];
      editingLine.text = "";
      pushHistory(); renderTimeline();
      $('edit-text-modal').style.display = 'none';
      editingLine = null;
      return;
    }

    const oldWords = (editingLine.words && editingLine.words.length > 0)
        ? editingLine.words
        : editingLine.text.trim().split(/\s+/).filter(t => t).map((t, i, arr) => {
            const p = (editingLine.endMs - editingLine.startMs) / arr.length;
            const tClean = t.replace(/[\(\)]/g, '');
            return {
                id: `tmp-${Date.now()}-${i}`,
                text: tClean,
                startMs: Math.round(editingLine.startMs + p * i),
                endMs: Math.round(editingLine.startMs + p * (i + 1)),
                isBackground: isLineBg || (t.startsWith('(') && t.endsWith(')'))
            };
        });

    const keepStructure = $('edit-keep-structure').checked;

    // 1-to-1 bypass if word counts match exactly AND Keep Word Timings is checked
    if (newTokens.length === oldWords.length && keepStructure) {
      const resultWords = oldWords.map((w, i) => {
        const isBg = newTokens[i].isBackground;
        return {
          ...w,
          text: (newTokens[i].text === '\\') ? "" : newTokens[i].text,
          isBackground: isBg,
          role: isBg ? 'x-bg' : null,
          tokenIdx: i
        };
      });

      editingLine.words = resultWords;
      editingLine.text = resultWords.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
      pushHistory(); renderTimeline();
      $('edit-text-modal').style.display = 'none';
      editingLine = null;
      return;
    }

    // Compute default sequential timings for newly introduced channels/words
    const defaultP = (editingLine.endMs - editingLine.startMs) / newTokens.length;
    const defaultTimings = newTokens.map((t, i) => ({
      startMs: Math.round(editingLine.startMs + defaultP * i),
      endMs: Math.round(editingLine.startMs + defaultP * (i + 1))
    }));

    // Classify new tokens into Main and Background channels with default timing fallbacks
    const mainTokens = [];
    const bgTokens = [];
    newTokens.forEach((t, i) => {
      const tObj = {
        text: t.text,
        rawText: t.rawText,
        isBackground: t.isBackground,
        tokenIdx: i,
        defaultStartMs: defaultTimings[i].startMs,
        defaultEndMs: defaultTimings[i].endMs
      };
      if (t.isBackground) {
        bgTokens.push(tObj);
      } else {
        mainTokens.push(tObj);
      }
    });

    // Clean text helper for matching words between channels
    function cleanTextForMatch(txt) {
      return (txt || "").replace(/[\(\)]/g, '').toLowerCase().trim();
    }

    // Classify old words by matching them to the new tokens' target channels
    const oldMainWords = [];
    const oldBgWords = [];
    const usedTokenIdxs = new Set();

    oldWords.forEach(w => {
      const wClean = cleanTextForMatch(w.text);
      const isOldBg = !!(w.isBackground || w.role === 'x-bg');

      let matchedIdx = -1;
      for (let j = 0; j < newTokens.length; j++) {
        if (!usedTokenIdxs.has(j) && newTokens[j].isBackground === isOldBg && cleanTextForMatch(newTokens[j].text) === wClean) {
          matchedIdx = j;
          break;
        }
      }
      if (matchedIdx === -1) {
        for (let j = 0; j < newTokens.length; j++) {
          if (!usedTokenIdxs.has(j) && cleanTextForMatch(newTokens[j].text) === wClean) {
            matchedIdx = j;
            break;
          }
        }
      }

      if (matchedIdx !== -1) {
        usedTokenIdxs.add(matchedIdx);
        if (newTokens[matchedIdx].isBackground) {
          oldBgWords.push(w);
        } else {
          oldMainWords.push(w);
        }
      } else {
        // Fallback for deleted words: place in their original channel
        if (isOldBg) {
          oldBgWords.push(w);
        } else {
          oldMainWords.push(w);
        }
      }
    });

    // keepStructure defined at top of handler

    function alignChannel(tokens, channelOldWords, isBgChannel) {
      if (tokens.length === 0) return [];
      if (channelOldWords.length === 0) {
        return tokens.map((tObj, i) => {
          return {
            id: `tmp-${Date.now()}-${isBgChannel ? 'bg' : 'main'}-${i}-${Math.random()}`,
            text: (tObj.text === '\\') ? "" : tObj.text,
            startMs: tObj.defaultStartMs,
            endMs: tObj.defaultEndMs,
            isBackground: isBgChannel,
            role: isBgChannel ? 'x-bg' : null,
            agent: editingLine.agent,
            tokenIdx: tObj.tokenIdx
          };
        });
      }

      // If lengths match
      if (tokens.length === channelOldWords.length) {
        if (keepStructure) {
          return channelOldWords.map((w, i) => {
            return {
              ...w,
              text: (tokens[i].text === '\\') ? "" : tokens[i].text,
              isBackground: isBgChannel,
              role: isBgChannel ? 'x-bg' : null,
              tokenIdx: tokens[i].tokenIdx
            };
          });
        } else {
          const usedOld = new Set();
          const matched = new Array(tokens.length).fill(null);

          tokens.forEach((tObj, i) => {
            const text = (tObj.text === '\\') ? "" : tObj.text;
            const matchIdx = channelOldWords.findIndex((ow, idx) =>
              !usedOld.has(idx) && ow.text.toLowerCase() === text.toLowerCase()
            );
            if (matchIdx !== -1) {
              matched[i] = {
                text: text,
                duration: channelOldWords[matchIdx].endMs - channelOldWords[matchIdx].startMs,
                id: channelOldWords[matchIdx].id,
                agent: channelOldWords[matchIdx].agent,
                tokenIdx: tObj.tokenIdx
              };
              usedOld.add(matchIdx);
            }
          });

          const remainingOld = channelOldWords.filter((_, idx) => !usedOld.has(idx));
          let remIdx = 0;
          tokens.forEach((tObj, i) => {
            if (!matched[i]) {
              const text = (tObj.text === '\\') ? "" : tObj.text;
              if (remIdx < remainingOld.length) {
                matched[i] = {
                  text: text,
                  duration: remainingOld[remIdx].endMs - remainingOld[remIdx].startMs,
                  id: remainingOld[remIdx].id,
                  agent: remainingOld[remIdx].agent,
                  tokenIdx: tObj.tokenIdx
                };
                remIdx++;
              } else {
                matched[i] = {
                  text: text,
                  duration: 50,
                  id: Date.now() + i + Math.random(),
                  agent: editingLine.agent,
                  tokenIdx: tObj.tokenIdx
                };
              }
            }
          });

          // Calculate original gaps in this channel
          const gaps = [];
          for (let k = 0; k < channelOldWords.length - 1; k++) {
            gaps.push(Math.max(0, channelOldWords[k+1].startMs - channelOldWords[k].endMs));
          }

          // Place matched words sequentially within this channel's span, preserving original gaps
          const channelStart = channelOldWords[0].startMs;
          const channelEnd = channelOldWords[channelOldWords.length - 1].endMs;
          const totalSpan = channelEnd - channelStart;
          const totalDur = matched.reduce((sum, m) => sum + m.duration, 0);
          const totalGaps = gaps.reduce((sum, g) => sum + g, 0);

          let cursor = channelStart;
          const resultWords = matched.map((m, i) => {
            const scale = (totalSpan - totalGaps > 0 && totalDur > 0) ? (totalSpan - totalGaps) / totalDur : 1;
            const dur = m.duration * scale;
            const word = {
              id: m.id,
              text: m.text,
              startMs: Math.round(cursor),
              endMs: Math.round(cursor + dur),
              isBackground: isBgChannel,
              role: isBgChannel ? 'x-bg' : null,
              agent: m.agent,
              tokenIdx: m.tokenIdx
            };
            cursor = word.endMs;
            if (i < gaps.length) {
              cursor += gaps[i];
            }
            return word;
          });
          resultWords[resultWords.length - 1].endMs = channelEnd;
          return resultWords;
        }
      }

      // If keepStructure is true but lengths differ
      if (keepStructure) {
        const resultWords = [];
        tokens.forEach((tObj, i) => {
          const text = (tObj.text === '\\') ? "" : tObj.text;
          if (i < channelOldWords.length) {
            resultWords.push({ 
              ...channelOldWords[i], 
              text: text,
              isBackground: isBgChannel,
              role: isBgChannel ? 'x-bg' : null,
              tokenIdx: tObj.tokenIdx
            });
          } else {
            const last = resultWords[resultWords.length - 1];
            const start = last ? last.endMs : (channelOldWords.length ? channelOldWords[channelOldWords.length-1].endMs : editingLine.startMs);
            resultWords.push({ 
              id: Date.now() + i + Math.random(), 
              text: text, 
              startMs: start, 
              endMs: Math.max(start + 100, editingLine.endMs),
              isBackground: isBgChannel,
              role: isBgChannel ? 'x-bg' : null,
              agent: editingLine.agent,
              tokenIdx: tObj.tokenIdx
            });
          }
        });
        for (let i = tokens.length; i < channelOldWords.length; i++) {
          resultWords.push({ 
            ...channelOldWords[i], 
            text: "",
            isBackground: isBgChannel,
            role: isBgChannel ? 'x-bg' : null,
            tokenIdx: tokens[tokens.length - 1] ? tokens[tokens.length - 1].tokenIdx + 0.1 * (i - tokens.length + 1) : i
          });
        }
        return resultWords;
      }

      // Smart Alignment (LCS)
      function getLCS(arr1, arr2) {
        const n = arr1.length, m = arr2.length;
        const dp = Array.from({length: n+1}, () => Array(m+1).fill(0));
        for (let i=1; i<=n; i++) {
          for (let j=1; j<=m; j++) {
            const w1 = cleanTextForMatch(arr1[i-1].text);
            const w2 = cleanTextForMatch(arr2[j-1].text);
            const isMatch = (w1 === w2) || (w1 === "" && (w2 === "" || w2 === "\\"));
            if (isMatch) dp[i][j] = dp[i-1][j-1] + 1;
            else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
          }
        }
        const res = []; let i=n, j=m;
        while (i>0 && j>0) {
          const w1 = cleanTextForMatch(arr1[i-1].text);
          const w2 = cleanTextForMatch(arr2[j-1].text);
          const isMatch = (w1 === w2) || (w1 === "" && (w2 === "" || w2 === "\\"));
          if (isMatch) {
            res.unshift({oldIdx: i-1, newIdx: j-1}); i--; j--;
          } else if (dp[i-1][j] > dp[i][j-1]) i--; else j--;
        }
        return res;
      }

      const anchors = getLCS(channelOldWords, tokens);
      const resultWords = [];

      const channelStart = channelOldWords[0].startMs;
      const channelEnd = channelOldWords[channelOldWords.length - 1].endMs;

      const fullAnchors = [
        {oldIdx: -1, newIdx: -1, endMs: channelStart},
        ...anchors.map(a => ({...a, startMs: channelOldWords[a.oldIdx].startMs, endMs: channelOldWords[a.oldIdx].endMs})),
        {oldIdx: channelOldWords.length, newIdx: tokens.length, startMs: channelEnd}
      ];

      for (let i = 0; i < fullAnchors.length - 1; i++) {
        const curr = fullAnchors[i], next = fullAnchors[i+1];

        if (curr.oldIdx !== -1) {
          resultWords.push({
            ...channelOldWords[curr.oldIdx],
            text: (tokens[curr.newIdx].text === "\\") ? "" : tokens[curr.newIdx].text,
            isBackground: isBgChannel,
            role: isBgChannel ? 'x-bg' : null,
            tokenIdx: tokens[curr.newIdx].tokenIdx
          });
        }

        const oldGapStart = curr.oldIdx === -1 ? curr.endMs : channelOldWords[curr.oldIdx].endMs;
        const oldGapEnd = next.oldIdx === channelOldWords.length ? next.startMs : channelOldWords[next.oldIdx].startMs;

        const oldInGap = channelOldWords.slice(curr.oldIdx + 1, next.oldIdx);
        const newInGap = tokens.slice(curr.newIdx + 1, next.newIdx);

        if (newInGap.length > 0) {
          if (oldInGap.length > 0) {
            const spanStart = oldInGap[0].startMs;
            const spanEnd = oldInGap[oldInGap.length - 1].endMs;
            const dur = spanEnd - spanStart;
            const perW = dur / newInGap.length;
            newInGap.forEach((tObj, idx) => {
              const isBlank = (tObj.text === "\\");
              resultWords.push({
                id: oldInGap[idx] ? oldInGap[idx].id : (Date.now() + Math.random()),
                text: isBlank ? "" : tObj.text,
                startMs: Math.round(spanStart + perW * idx),
                endMs: Math.round(spanStart + perW * (idx + 1)),
                isBackground: isBgChannel,
                role: isBgChannel ? 'x-bg' : null,
                agent: oldInGap[idx] ? oldInGap[idx].agent : editingLine.agent,
                tokenIdx: tObj.tokenIdx
              });
            });
          } else {
            const newWordMin = 50;
            const existingWordMin = 20;

            const minNeeded = newWordMin * newInGap.length;
            let insertStart = oldGapStart;
            let insertEnd = oldGapEnd;
            let available = insertEnd - insertStart;

            if (available < minNeeded) {
              const toSteal = minNeeded - available;
              const prevWord = resultWords.length > 0 ? resultWords[resultWords.length - 1] : null;
              const nWord = next.oldIdx < channelOldWords.length ? channelOldWords[next.oldIdx] : null;

              const prevCap = prevWord ? Math.max(0, (prevWord.endMs - prevWord.startMs) - existingWordMin) : 0;
              const nextCap = nWord ? Math.max(0, (nWord.endMs - nWord.startMs) - existingWordMin) : 0;
              const totalCap = prevCap + nextCap;

              if (totalCap > 0) {
                const prevSteal = (prevCap / totalCap) * toSteal;
                const nextSteal = (nextCap / totalCap) * toSteal;

                if (prevWord) {
                  prevWord.endMs -= prevSteal;
                  insertStart = prevWord.endMs;
                }
                if (nWord) {
                  nWord.startMs += nextSteal;
                  insertEnd = nWord.startMs;
                  fullAnchors[i+1].startMs = nWord.startMs;
                }
              }
            }

            available = Math.max(minNeeded, insertEnd - insertStart);
            const perW = available / newInGap.length;
            newInGap.forEach((tObj, idx) => {
              const isBlank = (tObj.text === "\\");
              resultWords.push({
                id: Date.now() + Math.random(),
                text: isBlank ? "" : tObj.text,
                startMs: Math.round(insertStart + perW * idx),
                endMs: Math.round(insertStart + perW * (idx + 1)),
                isBackground: isBgChannel,
                role: isBgChannel ? 'x-bg' : null,
                agent: editingLine.agent,
                tokenIdx: tObj.tokenIdx
              });
            });
          }
        } else if (oldInGap.length > 0) {
          const lastWord = resultWords.length > 0 ? resultWords[resultWords.length - 1] : null;
          if (lastWord) {
            lastWord.endMs = oldInGap[oldInGap.length - 1].endMs;
          } else if (next.oldIdx < channelOldWords.length) {
            channelOldWords[next.oldIdx].startMs = oldGapStart;
            fullAnchors[i+1].startMs = oldGapStart;
          }
        }
      }

      return resultWords;
    }

    const alignedMain = alignChannel(mainTokens, oldMainWords, false);
    const alignedBg = alignChannel(bgTokens, oldBgWords, true);

    const resultWords = [...alignedMain, ...alignedBg].sort((a, b) => {
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      return a.tokenIdx - b.tokenIdx;
    });

    if (resultWords.length > 0) {
      const allStarts = resultWords.map(w => w.startMs);
      const allEnds = resultWords.map(w => w.endMs);
      editingLine.startMs = Math.min(...allStarts);
      editingLine.endMs = Math.max(...allEnds);
    }

    editingLine.words = resultWords;
    editingLine.text = resultWords.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    pushHistory(); renderTimeline();
  }
  $('edit-text-modal').style.display = 'none';
  editingLine = null;
};

// Undo/Redo Buttons
$('btn-undo').onclick=undo;
$('btn-redo').onclick=redo;

// View Mode Toggle
function setViewMode(mode) {
    const container = document.querySelector('.editor-container');
    if (mode === 'compact') {
        container.classList.add('compact-mode');
        $('view-compact').classList.add('active');
        $('view-one-line').classList.remove('active');
    } else {
        container.classList.remove('compact-mode');
        $('view-one-line').classList.add('active');
        $('view-compact').classList.remove('active');
    }
    savePrefs({ viewMode: mode });
}

$('view-one-line').onclick = () => setViewMode('default');
$('view-compact').onclick = () => setViewMode('compact');

// Highlight Toggle
$('btn-toggle-waveform').onclick = () => {
    isWaveformEnabled = !isWaveformEnabled;
    const btn = $('btn-toggle-waveform');
    btn.style.color = isWaveformEnabled ? 'var(--accent)' : 'var(--text-muted)';
    waveformCache.clear(); // Clear cache to force redraw or hide
    renderTimeline();
    saveSession();
};

$('btn-toggle-highlight').onclick = () => {
    isWordHighlightEnabled = !isWordHighlightEnabled;
    $('btn-toggle-highlight').style.color = isWordHighlightEnabled ? 'var(--accent)' : 'var(--text-muted)';
    savePrefs({ wordHighlight: isWordHighlightEnabled });
    updateDisplay();
};

// Prev/Next Line
function centerActiveLine() {
    const active = document.querySelector('.timeline-track.active');
    if (active) {
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

$('btn-prev-line').onclick=()=> jumpLines(-1);
$('btn-next-line').onclick=()=> jumpLines(1);
if ($('btn-prev-flagged')) $('btn-prev-flagged').onclick = (e) => { e.stopPropagation(); jumpFlaggedWord(-1); };
if ($('btn-next-flagged')) $('btn-next-flagged').onclick = (e) => { e.stopPropagation(); jumpFlaggedWord(1); };
if ($('confidence-flag-controls')) {
  $('confidence-flag-controls').style.cursor = 'pointer';
  $('confidence-flag-controls').onclick = (e) => {
    if (e.target.closest('#btn-prev-flagged')) return;
    if (e.target.closest('#btn-next-flagged')) return;
    jumpFlaggedWord(1);
  };
}

function jumpLines(delta) {
    if(!lines.length) return;
    let activeIdx = -1;
    for(let i=0; i<lines.length; i++) {
        if(lines[i].startMs <= currentTime + 50) activeIdx = i;
        else break;
    }
    let targetIdx = activeIdx + delta;
    if(targetIdx < 0) targetIdx = 0;
    if(targetIdx >= lines.length) targetIdx = lines.length - 1;
    
    // For single line jumps from a state where no line is "active" yet (currentTime < first line)
    // and we press "Next", it should go to index 0.
    if (activeIdx === -1 && delta > 0) targetIdx = delta - 1;

    seekMs(lines[targetIdx].startMs);
    setTimeout(centerActiveLine, 50);
}

// Keyboard Shortcuts
window.addEventListener('keydown', e => {
  const isMod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    closeAllModals();
    document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
    if (document.activeElement === $('search-input')) {
      $('search-input').blur();
    }
    return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Handle Alt key combinations (e.g. Alt+N / Alt+P for flagged low-confidence words)
  if (e.altKey && !isMod) {
    const key = (e.key || '').toLowerCase();
    if (key === 'n' || e.code === 'KeyN') { e.preventDefault(); jumpFlaggedWord(1); return; }
    if (key === 'p' || e.code === 'KeyP') { e.preventDefault(); jumpFlaggedWord(-1); return; }
  }

  // 1. Handle specific Mod-key combinations first
  if (isMod) {
    // History
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    
    // Volume
    if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(audio.volume + 0.1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(audio.volume - 0.1); return; }

    // Nudge Time (Ctrl + [ / ])
    if (e.key === '[' || e.key === '{') { e.preventDefault(); nudgeTime(-500); return; }
    if (e.key === ']' || e.key === '}') { e.preventDefault(); nudgeTime(500); return; }

    // IF NOT HANDLED ABOVE, EXIT AND LET BROWSER HANDLE IT (e.g. Ctrl+1, Ctrl+T, Ctrl+S)
    return;
  }

  // 2. Single-key shortcuts (No Mod keys pressed)
  if (!e.shiftKey) {
    // Playback
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 'x' || e.key === 'X') { e.preventDefault(); stopPlay(); }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRepeat(); }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); toggleRepeatWord(); }
    if (e.key === 'o' || e.key === 'O') { e.preventDefault(); toggleRepeatSong(); }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); $('btn-fullscreen').click(); }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMute(); }
    if (e.key === '1') { $('btn-load-audio').click(); }
    if (e.key === '2') { $('btn-load-lyrics').click(); }
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); performExport(lastImportFormat, true); }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); $('search-input').focus(); }
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); $('tool-find-replace').click(); }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); $('tool-shift-time').click(); }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); $('btn-hotfix').click(); }
    if (e.key === 'g' || e.key === 'G') { 
        e.preventDefault(); 
        $('jump-line-input').value = '';
        if (lines.length > 0) {
            $('jl-info').textContent = `RANGE: 1 - ${lines.length}`;
            $('jump-line-input').placeholder = `1-${lines.length}`;
        }
        $('jump-line-modal').style.display = 'flex'; 
        $('jump-line-input').focus(); 
    }
    if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        $('jump-word-input').value = '';
        let tw = 0; lines.forEach(l => tw += (l.words ? l.words.length : 0));
        if (tw > 0) {
            $('jw-info').textContent = `RANGE: 1 - ${tw}`;
            $('jump-word-input').placeholder = `1-${tw}`;
        }
        $('jump-word-modal').style.display = 'flex';
        $('jump-word-input').focus();
    }
    if (e.key === 'd' || e.key === 'D') { e.preventDefault(); setViewMode('default'); }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setViewMode('compact'); }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); $('btn-shortcuts').click(); }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); insertBlankLine(lines.length); }
    if (e.key === 'Delete') { e.preventDefault(); $('btn-delete-selected').click(); }

    // Navigation & Seeking
    if (e.key === 'ArrowUp') { e.preventDefault(); jumpLines(-1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); jumpLines(1); }
    if (e.key === 'Home') { e.preventDefault(); jumpLines(-lines.length); }
    if (e.key === 'End') { e.preventDefault(); jumpLines(lines.length); }
    if (e.key === 'PageUp') { e.preventDefault(); jumpLines(-5); }
    if (e.key === 'PageDown') { e.preventDefault(); jumpLines(5); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seekMs(Math.max(0, currentTime - 2000)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); seekMs(Math.min(duration, currentTime + 2000)); }
    
    // Nudge Time (Single key [ / ])
    if (e.key === '[' || e.key === '{') { e.preventDefault(); nudgeTime(-100); }
    if (e.key === ']' || e.key === '}') { e.preventDefault(); nudgeTime(100); }
  }
});

$('btn-nudge-back').onclick = () => {
    const amt = parseInt($('nudge-amount').value) || 100;
    nudgeTime(-amt);
};
$('btn-nudge-forward').onclick = () => {
    const amt = parseInt($('nudge-amount').value) || 100;
    nudgeTime(amt);
};


let nudgeHistTimer = null;
function cancelNudgeHistory() {
    if (nudgeHistTimer) { clearTimeout(nudgeHistTimer); nudgeHistTimer = null; }
}

function nudgeTime(ms) {
    if (!lines.length) return;

    // Check if there are any selected lines
    const selectedIds = new Set();
    document.querySelectorAll('.line-checkbox:checked').forEach(cb => {
        const id = Number(cb.closest('.timeline-track').id.replace('tc-', ''));
        selectedIds.add(id);
    });

    const targetLines = selectedIds.size > 0
        ? lines.filter(l => selectedIds.has(l.id))
        : lines;

    targetLines.forEach(l => {
        l.startMs = Math.max(0, l.startMs + ms);
        l.endMs = Math.max(0, l.endMs + ms);
        if (l.words) l.words.forEach(w => {
            w.startMs = Math.max(0, w.startMs + ms);
            w.endMs = Math.max(0, w.endMs + ms);
        });
    });

    renderTimeline();
    // Coalesce rapid consecutive nudges into a single undo step
    cancelNudgeHistory();
    nudgeHistTimer = setTimeout(() => { nudgeHistTimer = null; pushHistory(); }, 550);
}

// Search
function applySearchFilter() {
  const input = $('search-input');
  const q = (input ? input.value : '').toLowerCase().trim();
  $('search-clear').style.display = q ? 'block' : 'none';
  if (q) container.classList.add('searching');
  else container.classList.remove('searching');

  let matches = 0;
  document.querySelectorAll('.timeline-track').forEach(t => { t.style.display=''; });
  if (q) {
    lines.forEach(l => {
      const el = $(`tc-${l.id}`);
      if (el) {
        const text = (l.text || "").toLowerCase();
        const wordMatch = l.words ? l.words.some(w => (w.text || "").toLowerCase().includes(q)) : false;
        if (!text.includes(q) && !wordMatch) el.style.display='none';
        else matches++;
      }
    });
  }
  const countEl = $('search-count');
  if (countEl) {
    countEl.style.display = q ? 'block' : 'none';
    countEl.textContent = q ? `${matches}/${lines.length}` : '';
    countEl.style.color = matches === 0 && q ? '#ff4d4f' : 'var(--accent)';
  }
}

$('search-input').oninput = applySearchFilter;

$('search-clear').onclick = () => {
    $('search-input').value = '';
    applySearchFilter();
    $('search-input').focus();
};

// Fullscreen
$('btn-fullscreen').onclick = () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable fullscreen: ${err.message}`);
        });
        $('btn-fullscreen').innerHTML = '<i class="fas fa-compress"></i>';
    } else {
        document.exitFullscreen();
        $('btn-fullscreen').innerHTML = '<i class="fas fa-expand"></i>';
    }
};

// Shortcuts Modal
$('btn-shortcuts').onclick = () => $('shortcuts-modal').style.display = 'flex';
$('shortcuts-close').onclick = () => $('shortcuts-modal').style.display = 'none';
$('shortcuts-close-top').onclick = () => $('shortcuts-modal').style.display = 'none';

$('btn-remove-audio').onclick = (e) => {
    e.stopPropagation();
    if (confirm("Remove current audio source?")) {
        stopPlay();
        audio.removeAttribute('src');
        audio.load();
        audioFilename = "";
        audioFullname = "";
        // Keep lastAudioFile in memory and DB so the reload button works
        originalFilename = lyricsFilename || "lyrics";
        $('input-audio').value = "";
        updateFileUI();
        if(!lines.length) duration = 0;
        pushHistory();
        updateDisplay();
    }
};

$('audio-reload-display').onclick = () => {
    if (lastAudioFile) handleAudioFile(lastAudioFile);
    else $('input-audio').click();
};
$('lyrics-reload-display').onclick = () => {
    if (lastLyricsFile) handleLyricsFile(lastLyricsFile);
    else $('input-lyrics').click();
};

$('btn-remove-lyrics').onclick = (e) => {
    e.stopPropagation();
    if (confirm("Clear all lyrics and reset editor?")) {
        lines = [];
        lyricsFilename = "";
        lyricsFullname = "";
        // Keep lastLyricsFile in memory and DB so the reload button works
        originalFilename = audioFilename || "lyrics";
        $('input-lyrics').value = "";
        updateFileUI();
        pushHistory();
        renderTimeline();
    }
};

$('btn-add-line-header').onclick = () => {
    insertBlankLine(lines.length);
};

$('btn-clear-all-header').onclick = () => {
    if(confirm("Are you sure you want to clear all lines?")) {
        lines = [];
        pushHistory();
        renderTimeline();
    }
};

$('btn-reset-session-header').onclick = () => {
    if(confirm("Clear saved session and reset editor? This will refresh the page.")) {
        localStorage.removeItem('lyricseditor_session');
        localStorage.removeItem('lyricseditor_history');
        localStorage.removeItem('lyricseditor_metadata');
        clearDB().then(() => location.reload());
    }
};

$('btn-delete-selected').onclick = () => {
    const checks = document.querySelectorAll('.line-checkbox:checked');
    if (!checks.length) return;
    if (confirm(`Are you sure you want to delete ${checks.length} selected lines?`)) {
        const selectedIds = Array.from(checks).map(c => Number(c.dataset.id));
        lines = lines.filter(l => !selectedIds.includes(l.id));
        pushHistory();
        renderTimeline();
    }
};

// Jump to Line
$('jl-cancel').onclick = () => $('jump-line-modal').style.display = 'none';
$('jl-dec').onclick = () => {
    const input = $('jump-line-input');
    const val = parseInt(input.value) || 1;
    if (val > 1) input.value = val - 1;
};
$('jl-inc').onclick = () => {
    const input = $('jump-line-input');
    const val = parseInt(input.value) || 0;
    if (val < lines.length) input.value = val + 1;
};
$('jl-apply').onclick = () => {
    const val = parseInt($('jump-line-input').value);
    if (!isNaN(val) && val > 0 && val <= lines.length) {
        seekMs(lines[val - 1].startMs);
        setTimeout(centerActiveLine, 50);
        $('jump-line-modal').style.display = 'none';
        $('jump-line-input').value = '';
    } else if ($('jump-line-input').value === '') {
        $('jump-line-modal').style.display = 'none';
    } else {
        showToast(`Invalid line number — enter 1 to ${lines.length}.`, 'warning');
    }
};
$('jump-line-input').onkeydown = (e) => {
    if (e.key === 'Enter') $('jl-apply').click();
};

// Click on any modal backdrop closes it (consistent across all modals)
document.addEventListener('mousedown', (e) => {
    if (e.target.classList && e.target.classList.contains('modal-overlay')) {
        e.target.style.display = 'none';
    }
});

// Jump to Word
$('jw-cancel').onclick = () => $('jump-word-modal').style.display = 'none';
$('jw-dec').onclick = () => {
    const input = $('jump-word-input');
    const val = parseInt(input.value) || 1;
    if (val > 1) input.value = val - 1;
};
$('jw-inc').onclick = () => {
    const input = $('jump-word-input');
    const val = parseInt(input.value) || 0;
    let tw = 0; lines.forEach(l => tw += (l.words ? l.words.length : 0));
    if (val < tw) input.value = val + 1;
};
$('jw-apply').onclick = () => {
    const val = parseInt($('jump-word-input').value);
    if (!isNaN(val) && val > 0) {
        let count = 0;
        let found = false;
        for (const line of lines) {
            const wordCount = line.words ? line.words.length : 0;
            if (count + wordCount >= val) {
                const wordIdx = val - count - 1;
                const word = line.words[wordIdx];
                if (word) {
                    seekMs(word.startMs);
                    setTimeout(centerActiveLine, 50);
                    $('jump-word-modal').style.display = 'none';
                    $('jump-word-input').value = '';
                    found = true;
                }
                break;
            }
            count += wordCount;
        }
        if (!found) showToast("Word index out of range", 'warning');
    } else if ($('jump-word-input').value === '') {
        $('jump-word-modal').style.display = 'none';
    }
};
$('jump-word-input').onkeydown = (e) => {
    if (e.key === 'Enter') $('jw-apply').click();
};

// Handle Esc key or other fullscreen exits
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        $('btn-fullscreen').innerHTML = '<i class="fas fa-expand"></i>';
    } else {
        $('btn-fullscreen').innerHTML = '<i class="fas fa-compress"></i>';
    }
});

// Drag & Drop
let dragDepth = 0;
function setDropOverlay(on) {
    document.body.classList.toggle('show-drop-overlay', on);
    if (!lines.length) container.classList.toggle('drag-over', on);
}
document.addEventListener('dragenter', e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        dragDepth++;
        setDropOverlay(true);
    }
});
document.addEventListener('dragover', e => {
    e.preventDefault();
});
document.addEventListener('dragleave', e => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropOverlay(false);
});
document.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    setDropOverlay(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;

    let audioToLoad = null, audioCount = 0;
    let lyricsToLoad = null, lyricsCount = 0;

    const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm', 'mp4', 'aif', 'aiff'];
    const lyricsExts = ['lrc', 'srt', 'vtt', 'txt', 'json', 'xml', 'ttml', 'lyricsfile', 'yaml', 'yml', 'srv1', 'srv2', 'srv3'];

    for (const f of files) {
        const ext = f.name.split('.').pop().toLowerCase();
        if (f.type.startsWith('audio/') || f.type.startsWith('video/') || audioExts.includes(ext)) {
            audioCount++; audioToLoad = f;
        } else if (lyricsExts.includes(ext)) {
            lyricsCount++; lyricsToLoad = f;
        }
    }

    if (audioCount > 1 || lyricsCount > 1) {
        showToast("Too many files — drop only 1 audio and/or 1 lyrics file at a time.", 'warning');
        return;
    }

    if (audioToLoad) {
        if (audioFullname && !confirm(`An audio file (${audioFullname}) is already loaded. Replace it?`)) {
            // User cancelled
        } else {
            handleAudioFile(audioToLoad);
        }
    }

    if (lyricsToLoad) {
        if (lyricsFullname && !confirm(`A lyrics file (${lyricsFullname}) is already loaded. Replace it?`)) {
            // User cancelled
        } else {
            handleLyricsFile(lyricsToLoad);
        }
    }
});

// Init
(async function init() {
    loadSession(); // Load text/metadata (very fast)
    updateFileUI();
    renderTimeline();
    updateDisplay();
    
    // Sync initial waveform button state
    const wfBtn = $('btn-toggle-waveform');
    if (wfBtn) wfBtn.style.color = isWaveformEnabled ? 'var(--accent)' : 'var(--text-muted)';

    // Load file references from DB to keep the Reload button functional
    getFileFromDB('lastLyrics').then(file => {
        if (file) {
            lastLyricsFile = file;
            updateFileUI(); // Show reload icon if lyrics are missing in UI
        }
    });

    getFileFromDB('lastAudio').then(file => {
        if (file) {
            lastAudioFile = file;
            // ONLY auto-load if the session says it was active
            if (audioFullname) {
                // Delay heavy audio loading to ensure initial UI is responsive
                setTimeout(() => handleAudioFile(file, true), 100); 
            } else {
                updateFileUI(); // Show reload icon
            }
        }
    });
})();

function normalizeLines(tgts) {
    if (!tgts) return;
    tgts.forEach(l => {
        if (l.words && l.words.length > 0) {
            const hasRealText = l.words.some(w => {
                const t = (w.text || "").trim();
                return t !== "" && t !== "\\" && t !== "\"";
            });
            if (!hasRealText) {
                l.words = null;
                l.text = "";
            }
        }
    });
}

function resolveTimingOverlaps(newLines) {
  if (!newLines || newLines.length === 0) return;

  // 1. Resolve word-level overlaps within each line
  newLines.forEach(l => {
      if (l.words && l.words.length > 0) {
          // Sort words chronologically
          l.words.sort((a, b) => a.startMs - b.startMs);
          
          // Enforce non-overlapping words
          for (let k = 0; k < l.words.length - 1; k++) {
              const curr = l.words[k];
              const next = l.words[k+1];
              if (curr.endMs > next.startMs) {
                  const mid = Math.round((curr.startMs + next.endMs) / 2);
                  if (mid > curr.startMs && mid < next.endMs) {
                      curr.endMs = mid;
                      next.startMs = mid;
                  } else {
                      curr.endMs = next.startMs;
                  }
              }
              if (curr.endMs - curr.startMs < 50) {
                  curr.endMs = curr.startMs + 50;
              }
          }
          const lastW = l.words[l.words.length - 1];
          if (lastW.endMs - lastW.startMs < 50) {
              lastW.endMs = lastW.startMs + 50;
          }

          // Bound the line times tightly around its resolved word-blocks
          l.startMs = l.words[0].startMs;
          l.endMs = l.words[l.words.length - 1].endMs;
      }
  });

  // 2. Resolve line-level overlaps chronologically
  for (let i = 0; i < newLines.length - 1; i++) {
      const currLine = newLines[i];
      const nextLine = newLines[i+1];
      
      if (currLine.endMs > nextLine.startMs) {
          if (currLine.words && currLine.words.length > 0 && nextLine.words && nextLine.words.length > 0) {
              const lastWordEnd = currLine.words[currLine.words.length - 1].endMs;
              const firstWordStart = nextLine.words[0].startMs;
              
              if (lastWordEnd > firstWordStart) {
                  const midWord = Math.round((lastWordEnd + firstWordStart) / 2);
                  currLine.words[currLine.words.length - 1].endMs = midWord;
                  nextLine.words[0].startMs = midWord;
                  
                  // Cascade adjustments backwards inside current line
                  for (let k = currLine.words.length - 1; k > 0; k--) {
                      if (currLine.words[k].startMs < currLine.words[k-1].endMs) {
                          currLine.words[k-1].endMs = currLine.words[k].startMs;
                      }
                  }
                  // Cascade adjustments forwards inside next line
                  for (let k = 0; k < nextLine.words.length - 1; k++) {
                      if (nextLine.words[k].endMs > nextLine.words[k+1].startMs) {
                          nextLine.words[k+1].startMs = nextLine.words[k].endMs;
                      }
                  }
                  
                  currLine.endMs = midWord;
                  nextLine.startMs = midWord;
              } else {
                  currLine.endMs = lastWordEnd;
                  nextLine.startMs = firstWordStart;
              }
          } else {
              currLine.endMs = nextLine.startMs;
          }
      }
      if (currLine.endMs - currLine.startMs < 100) {
          currLine.endMs = currLine.startMs + 100;
      }
  }
}

async function decodeAudioForWaveform(arrayBuffer) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    try {
        // We use a copy of the buffer because decodeAudioData detaches the original buffer
        const bufferCopy = arrayBuffer.slice(0);
        audioBuffer = await ctx.decodeAudioData(bufferCopy);
        waveformCache.clear();
        renderTimeline();
    } catch (e) {
        console.error("Waveform decoding failed", e);
    } finally {
        ctx.close();
    }
}

function drawWaveformForLine(container, line) {
    if (!audioBuffer || !isWaveformEnabled) {
        container.style.backgroundImage = 'none';
        return false;
    }
    
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    if (width <= 0 || height <= 0) return false;
    
    // Check cache to avoid re-rendering same segments
    const cacheKey = `${line.id}-${line.startMs}-${line.endMs}-${width}-${height}`;
    if (waveformCache.has(cacheKey)) {
        container.style.backgroundImage = `url(${waveformCache.get(cacheKey)})`;
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d');
    const data = audioBuffer.getChannelData(0);
    const startIdx = Math.floor((line.startMs / 1000) * audioBuffer.sampleRate);
    const endIdx = Math.floor((line.endMs / 1000) * audioBuffer.sampleRate);
    const sampleDuration = endIdx - startIdx;
    
    if (sampleDuration <= 0) return;
    
    const amp = height / 2;
    
    // Find local max for normalization within this line
    let localMax = 0.01;
    for (let i = 0; i < width; i++) {
        const idx = startIdx + Math.floor(i * (sampleDuration / width));
        if (idx >= data.length) break;
        const v = Math.abs(data[idx]);
        if (v > localMax) localMax = v;
    }

    // Modern Waveform Style
    ctx.fillStyle = 'rgba(255, 107, 0, 0.45)'; // Much clearer opacity
    
    const step = sampleDuration / width;
    for (let i = 0; i < width; i++) {
        let min = 1.0, max = -1.0;
        const bucketStart = startIdx + Math.floor(i * step);
        const bucketEnd = startIdx + Math.floor((i + 1) * step);
        
        for (let j = bucketStart; j < bucketEnd; j++) {
            if (j >= data.length) break;
            const datum = data[j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        
        // Normalization and Symmetric Drawing
        const peak = Math.max(Math.abs(min), Math.abs(max));
        const normPeak = peak / localMax;
        
        // Draw bars with 2px width for better visibility
        const h = Math.max(2, normPeak * height);
        const y = (height - h) / 2; // Perfectly centered
        
        // Draw slightly wider bars for clarity
        if (i % 2 === 0) {
            ctx.fillRect(i, y, 2, h);
        }
    }
    
    // Add a subtle center line
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(0, amp, width, 1);
    
    const dataUrl = canvas.toDataURL();
    waveformCache.set(cacheKey, dataUrl);
    container.style.backgroundImage = `url(${dataUrl})`;
    container.style.backgroundSize = '100% 100%';
    container.style.backgroundRepeat = 'no-repeat';
    container.style.backgroundPosition = '0 0';
    return true;
}

// Global getters for Metadata Editor access
window.getLastAudioFile = () => lastAudioFile;
window.getLastLyricsFile = () => lastLyricsFile;

// Line Attributes Modal Controller
let attrEditingLine = null;

function openLineAttrModal(line) {
  attrEditingLine = line;
  
  const selectPart = $('line-attr-song-part');
  const customWrapper = $('line-attr-custom-part-wrapper');
  const customInput = $('line-attr-custom-part');
  
  const partVal = line.songPart || '';
  const standardParts = ['Verse', 'Chorus', 'Bridge', 'Intro', 'Outro', 'Pre-Chorus', 'Hook', 'Solo'];
  if (partVal === '') {
    selectPart.value = '';
    customWrapper.style.display = 'none';
  } else if (standardParts.includes(partVal)) {
    selectPart.value = partVal;
    customWrapper.style.display = 'none';
  } else {
    selectPart.value = 'custom';
    customInput.value = partVal;
    customWrapper.style.display = 'flex';
  }
  
  const selectAgent = $('line-attr-agent');
  selectAgent.innerHTML = '<option value="">None</option>';
  const metaAgents = (window.appMetadata && window.appMetadata.agents) ? window.appMetadata.agents : [];
  metaAgents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.id} (${a.name || 'Vocalist'})`;
    selectAgent.appendChild(opt);
  });
  selectAgent.value = line.agent || '';
  
  $('line-attr-bg').checked = !!(line.isBackground || line.role === 'x-bg');
  
  $('line-attr-modal').style.display = 'flex';
}

$('line-attr-song-part').onchange = (e) => {
  $('line-attr-custom-part-wrapper').style.display = e.target.value === 'custom' ? 'flex' : 'none';
};

$('line-attr-cancel').onclick = () => {
  $('line-attr-modal').style.display = 'none';
};
$('line-attr-close-top').onclick = () => {
  $('line-attr-modal').style.display = 'none';
};
$('line-attr-modal').onclick = (e) => {
  if (e.target.id === 'line-attr-modal') $('line-attr-modal').style.display = 'none';
};

$('line-attr-save').onclick = () => {
  if (!attrEditingLine) return;
  
  const partSelect = $('line-attr-song-part').value;
  const partValue = partSelect === 'custom' ? $('line-attr-custom-part').value.trim() : partSelect;
  attrEditingLine.songPart = partValue;
  
  if ($('line-attr-apply-subsequent') && $('line-attr-apply-subsequent').checked) {
    const idx = lines.findIndex(l => l.id === attrEditingLine.id);
    if (idx !== -1) {
      for (let j = idx + 1; j < lines.length; j++) {
        // Stop if we hit a line with a different, non-empty song part
        if (lines[j].songPart && lines[j].songPart !== partValue) {
          break;
        }
        lines[j].songPart = partValue;
      }
    }
  }
  
  attrEditingLine.agent = $('line-attr-agent').value || null;
  
  const isBg = $('line-attr-bg').checked;
  attrEditingLine.isBackground = isBg;
  attrEditingLine.role = isBg ? 'x-bg' : null;
  
  if (attrEditingLine.words) {
    attrEditingLine.words.forEach(w => {
      w.isBackground = isBg;
      w.role = isBg ? 'x-bg' : null;
      w.agent = attrEditingLine.agent;
    });
  }
  
  $('line-attr-modal').style.display = 'none';
  pushHistory();
  renderTimeline();
};
