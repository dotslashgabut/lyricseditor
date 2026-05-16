// â”€â”€ Database (IndexedDB) for True Persistence â”€â”€
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

// â”€â”€ Global State â”€â”€
let audio = new Audio(), lines = [];
let currentTime = 0, duration = 0, rafId = null, activeLineId = null, lockedWord = null;
let isPlaying = false, isRepeat = false, isWordRepeat = false, isSongRepeat = false;
let isWaveformEnabled = true, isWordHighlightEnabled = true;
let audioFullname = '', lyricsFullname = '';
let lastAudioFile = null, lastLyricsFile = null;
let history = [{lines:[], audioFN:'', lyricsFN:'', audioFull:'', lyricsFull:'', origFN:'lyrics'}], histIdx = 0;
let lastImportFormat = 'lrc', audioFilename = '', lyricsFilename = '', originalFilename = 'lyrics', editingLine = null;
let audioBuffer = null, waveformCache = new Map(), waveformObserver = null;

const $ = id => document.getElementById(id);
const playBtn=$('btn-play-pause'), stopBtn=$('btn-stop'), repeatBtn=$('btn-repeat');
const timeDisp=$('time-display'), progFill=$('progress-fill'), volSlider=$('volume-slider');
const container=$('timeline-container'), statL=$('stat-lines'), statW=$('stat-words');

function fmt(s) {
  if(isNaN(s))return'00:00.000';
  const m=Math.floor(s/60),sc=Math.floor(s%60),ms=Math.floor((s%1)*1000);
  return`${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}

// â”€â”€ History â”€â”€
function pushHistory() {
  const snap = {
    lines: JSON.parse(JSON.stringify(lines)),
    audioFN: audioFilename,
    lyricsFN: lyricsFilename,
    audioFull: audioFullname,
    lyricsFull: lyricsFullname,
    origFN: originalFilename,
    audioSrc: audio.src
  };
  
  // Don't push if it's the same as the current head (to avoid redundant undo steps)
  const current = history[histIdx];
  // More robust check for changes
  if (current && JSON.stringify(current.lines) === JSON.stringify(snap.lines)) {
      // Still update filenames/audio sources if they changed even if lines didn't
      if (current.audioSrc === snap.audioSrc && current.audioFN === snap.audioFN && current.lyricsFN === snap.lyricsFN) {
        return;
      }
  }

  history = history.slice(0, histIdx + 1);
  history.push(snap);
  if (history.length > 50) history.shift();
  histIdx = history.length - 1;
  saveSession();
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
        
        // Initial history entry for the loaded session
        history = [{
            lines: JSON.parse(JSON.stringify(lines)),
            audioFN: audioFilename,
            lyricsFN: lyricsFilename,
            audioFull: audioFullname,
            lyricsFull: lyricsFullname,
            origFN: originalFilename,
            audioSrc: ''
        }];
        histIdx = 0;
        
        updateFileUI();
        renderTimeline();
        updateDisplay();
        return true;
    } catch(e) {
        console.error("Session load failed", e);
        return false;
    }
}

// â”€â”€ Modal History (Local to Edit Modal) â”€â”€
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
  if (audio.src !== (snap.audioSrc || "")) {
      try {
          if (!snap.audioSrc) {
              audio.removeAttribute('src');
              audio.load();
          } else {
              audio.src = snap.audioSrc;
              audio.load();
          }
      } catch (e) { console.warn("Failed to restore audio source", e); }
  }
  updateFileUI();
  renderTimeline();
  updateDisplay();
  saveSession(); // Keep localStorage in sync with undo/redo
}

function undo() { if(histIdx>0){histIdx--; applySnapshot(history[histIdx]);} }
function redo() { if(histIdx<history.length-1){histIdx++; applySnapshot(history[histIdx]);} }

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

// â”€â”€ Render â”€â”€
function renderTimeline() {
  normalizeLines(lines);
  const oldScroll = container.scrollTop;
  // Capture currently selected IDs before clearing
  const previouslySelected = new Set();
  document.querySelectorAll('.line-checkbox:checked').forEach(cb => {
    const tr = cb.closest('.timeline-track');
    if (tr) previouslySelected.add(parseInt(tr.id.replace('tc-', '')));
  });

  container.innerHTML = '';
  if(!lines.length){
    // ... (placeholder code)
    container.innerHTML=`
      <div class="placeholder-text">
        <i class="fas fa-cloud-upload-alt" style="font-size: 32px; margin-bottom: 12px; opacity: 0.5;"></i><br>
        Load audio and lyrics to start editing<br>
        <span style="font-size:12px; opacity:0.7;">(or Drag & Drop files anywhere)</span>
        <div style="margin-top: 15px; font-size: 12px; font-weight: 500; color: var(--accent); opacity: 0.8;">
            <i class="fas fa-hand-pointer"></i> Drag words or boundaries to adjust timings
        </div>
        <div style="margin-top: 8px; font-size: 11px; opacity: 0.7; color: var(--text-main);">
            <i class="fas fa-keyboard"></i> Press <b style="color:var(--accent)">K</b> to view all keyboard shortcuts
        </div>
        <div style="margin-top: 20px; font-size: 11px; opacity: 0.6; max-width: 400px; line-height: 1.5; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
            <strong>Pro Tip for High Precision:</strong><br>
            Use <b>WAV</b> or <b>FLAC</b> for sample-accurate sync. MP3 files may have slight timing offsets. 
            If audio feels off, use the <b>[</b> or <b>]</b> buttons/keys to nudge all timings.
        </div>
        <div style="margin-top: 25px; font-size: 11px;">
            <a href="https://github.com/dummy/lyricseditor" target="_blank" class="github-link">
                <i class="fab fa-github" style="font-size: 16px;"></i> github.com/dummy/lyricseditor
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
    tr.className='timeline-track'; tr.id=`tc-${line.id}`;
    const isChecked = previouslySelected.has(line.id);
    tr.innerHTML=`<div class="track-controls"><input type="checkbox" class="line-checkbox" data-id="${line.id}" ${isChecked ? 'checked' : ''} style="cursor:pointer; margin-right:4px;" title="Select this line"><span style="color:var(--text-muted);font-size:11px;width:14px">${idx+1}</span><button class="track-play-btn" data-start="${line.startMs}" data-end="${line.endMs}"><i class="fas fa-play" style="font-size:9px;margin-left:1px"></i></button><div class="track-info">${fmt(line.startMs/1000)}</div></div><div class="track-content" id="trk-${line.id}"><div class="playback-indicator" id="pi-${line.id}"></div></div><div class="track-end-time">${fmt(line.endMs/1000)}</div><button class="icon-btn track-edit-btn" title="Edit Line Text"><i class="fas fa-edit"></i></button><button class="icon-btn track-delete-btn" title="Delete Line"><i class="fas fa-trash"></i></button>`;
    
    // Observer for lazy-loading waveforms
    const tc = tr.querySelector('.track-content');
    tc.dataset.lineId = line.id;

    const ws = (line.words && line.words.length > 0) ? line.words : [{ id: `pl-${line.id}`, text: (line.text || "").trim() || "[Empty]", startMs: line.startMs, endMs: line.endMs, isPl: true }];
    ws.forEach(w => {
      const el = document.createElement('div'); el.className='word-block'; el.id=`w-${w.id}`;
      if(w.isPl) el.style.opacity = '0.7';
      const wText = (w.text || "").trim();
      const isActuallyBlank = !wText || wText === "\\" || wText === "[Empty]" || wText === "\"";
      if(isActuallyBlank) el.classList.add('blank-word');
      
      el.innerHTML=`<div class="resize-handle left"></div><div class="word-text">${w.text || ""}</div><div class="word-duration">${((w.endMs-w.startMs)/1000).toFixed(3)}s</div><div class="resize-handle right"></div>`;
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
    tr.querySelector('.track-edit-btn').onclick = () => {
      editingLine = line;
      // Show \ for blank words so users can preserve them
      $('edit-text-input').value = (line.words && line.words.length > 0) 
        ? line.words.map(w => w.text || "\\").join(' ') 
        : line.text.replace(/\s+/g, ' ').trim();
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

  // Lazy load waveforms
  if (audioBuffer && isWaveformEnabled) {
    observeWaveforms();
  }

  statL.textContent=lines.length; statW.textContent=tw;
  updateDisplay();
  updateSelectionCount();
  container.scrollTop = oldScroll;
}

function observeWaveforms() {
  if (waveformObserver) waveformObserver.disconnect();
  waveformObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const tc = entry.target;
        const lineId = parseInt(tc.dataset.lineId);
        const line = lines.find(l => l.id === lineId);
        if (line && audioBuffer && isWaveformEnabled) {
          drawWaveformForLine(tc, line);
          // We can keep observing if we want it to redraw on resize, 
          // but for now let's just draw once per render.
          waveformObserver.unobserve(tc);
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
        return alert("No space between these lines to insert a new line.\nUse Shift Time or adjust timestamps to create a gap first.");
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

// â”€â”€ Drag Logic â”€â”€
function bindDrag(el, word, line, tc, isPl = false) {
  const lh=el.querySelector('.resize-handle.left'), rh=el.querySelector('.resize-handle.right');
  let mode=null, sx=0, snap={}, hasDragged=false;
  const MIN=20; // 20ms min

  function getIdx(){return line.words.findIndex(w=>w.id===word.id);}
  function capture(){
    if (isPl) {
      snap = { i: -1, s: line.startMs, e: line.endMs, lineStartMs: line.startMs, lineEndMs: line.endMs };
      return;
    }
    const i=getIdx();
    snap={i, s:word.startMs, e:word.endMs,
      lineStartMs: line.startMs, lineEndMs: line.endMs,
      ps:i>0?line.words[i-1].startMs:null, pe:i>0?line.words[i-1].endMs:null,
      ns:i<line.words.length-1?line.words[i+1].startMs:null, ne:i<line.words.length-1?line.words[i+1].endMs:null};
  }

  lh.onpointerdown=e=>{mode='rl';sx=e.clientX;hasDragged=false;capture();e.stopPropagation();el.setPointerCapture(e.pointerId);};
  rh.onpointerdown=e=>{mode='rr';sx=e.clientX;hasDragged=false;capture();e.stopPropagation();el.setPointerCapture(e.pointerId);};
  el.onpointerdown=e=>{if(e.target.classList.contains('resize-handle'))return;mode='drag';sx=e.clientX;hasDragged=false;capture();el.classList.add('dragging');el.setPointerCapture(e.pointerId);};

  document.addEventListener('pointermove', e=>{
    if(!mode)return;
    if(Math.abs(e.clientX - sx) > 2) hasDragged = true;
    const tw=tc.getBoundingClientRect().width;
    if(!tw)return;
    const ld=snap.lineEndMs-snap.lineStartMs;
    let dt=Math.round((e.clientX-sx)/tw*ld);
    const i=snap.i, prev=i>0?line.words[i-1]:null, next=i<line.words.length-1?line.words[i+1]:null;

    const lineIdx = lines.indexOf(line);
    const prevLine = lineIdx > 0 ? lines[lineIdx - 1] : null;
    const nextLine = lineIdx < lines.length - 1 ? lines[lineIdx + 1] : null;

    if(mode==='drag'){
      let mxR=next?(snap.ne-snap.ns-MIN):(nextLine ? nextLine.startMs - snap.e : (duration > 0 ? duration - snap.e : 9999999));
      let mxL=prev?-(snap.pe-snap.ps-MIN):-(snap.s-(prevLine ? prevLine.endMs : 0));
      dt=Math.max(mxL,Math.min(mxR,dt));
      word.startMs=snap.s+dt; word.endMs=snap.e+dt;
      if(prev){prev.endMs=snap.pe+dt;}
      if(next){next.startMs=snap.ns+dt;}
    } else if(mode==='rr'){
      let mxR=next?(snap.ne-snap.ns-MIN):(nextLine ? nextLine.startMs - snap.e : (duration > 0 ? duration - snap.e : 9999999));
      let mxL=-(snap.e-snap.s-MIN);
      dt=Math.max(mxL,Math.min(mxR,dt));
      word.endMs=snap.e+dt;
      if(next){next.startMs=snap.ns+dt;}
    } else if(mode==='rl'){
      let mxR=snap.e-snap.s-MIN;
      let mxL=prev?-(snap.pe-snap.ps-MIN):-(snap.s-(prevLine ? prevLine.endMs : 0));
      dt=Math.max(mxL,Math.min(mxR,dt));
      word.startMs=snap.s+dt;
      if(prev){prev.endMs=snap.pe+dt;}
    }

    if(!isPl) {
      if(!prev) line.startMs = word.startMs;
      if(!next) line.endMs = word.endMs;
      line.words.forEach(w => posWord(document.getElementById(`w-${w.id}`), w, line));
    } else {
      line.startMs = word.startMs;
      line.endMs = word.endMs;
      posWord(el, word, line);
    }
    
    // Live update waveform if it's a boundary change
    if (audioBuffer && (!prev || !next)) {
        const tr = document.getElementById(`tc-${line.id}`);
        if (tr) {
            const contentContainer = tr.querySelector('.track-content');
            drawWaveformForLine(contentContainer, line);
        }
    }

    const tr = document.getElementById(`tc-${line.id}`);
    tr.querySelector('.track-info').textContent = fmt(line.startMs/1000);
    tr.querySelector('.track-end-time').textContent = fmt(line.endMs/1000);
  });

  document.addEventListener('pointerup', ()=>{
    if(mode){
      el.classList.remove('dragging');
      if(hasDragged){
        pushHistory();
      }else{
        seekMs(word.startMs);
        if(!isPlaying)togglePlay();
      }
      mode=null;
    }
  });
}

// â”€â”€ Playback â”€â”€
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

// â”€â”€ Display Update â”€â”€
function updateDisplay(){
  const cs=currentTime/1000, ds=duration/1000;
  timeDisp.textContent=`${fmt(cs)} / ${fmt(ds)}`;
  progFill.style.width=duration>0?(currentTime/duration*100)+'%':'0%';
  
  let newActiveLineId = null;
  lines.forEach(line=>{
    const te=$(`tc-${line.id}`), pi=$(`pi-${line.id}`);
    if(!te)return;
    
    if(currentTime>=line.startMs&&currentTime<line.endMs){
      newActiveLineId=line.id;
      if(!te.classList.contains('active')){
          te.classList.add('active');
          if(isPlaying) te.scrollIntoView({behavior:'smooth',block:'nearest'});
      }
      if(pi){
          pi.style.display='block';
          pi.style.left=((currentTime-line.startMs)/(line.endMs-line.startMs)*100)+'%';
      }
      if(line.words){
        line.words.forEach(w=>{
          const we=$(`w-${w.id}`);
          if(we){
            if(isWordHighlightEnabled && currentTime>=w.startMs&&currentTime<w.endMs) we.classList.add('active');
            else we.classList.remove('active');
          }
        });
      }
    } else {
      te.classList.remove('active');
      if(pi)pi.style.display='none';
      if(line.words){
        line.words.forEach(w=>{
          const we=$(`w-${w.id}`);
          if(we) we.classList.remove('active');
        });
      }
    }
  });
  
  activeLineId = newActiveLineId;

  // Update all track play buttons
  document.querySelectorAll('.track-play-btn').forEach(btn => {
    const tr = btn.closest('.timeline-track');
    const lineId = tr ? parseInt(tr.id.replace('tc-', '')) : null;
    const icon = btn.querySelector('i');
    
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
}

// â”€â”€ Audio Events â”€â”€
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

// Progress bar seek
$('progress-bar').onclick=e=>{if(!duration)return;const r=$('progress-bar').getBoundingClientRect();seekMs(Math.max(0,(e.clientX-r.left)/r.width*duration));};

// â”€â”€ File Loading â”€â”€
$('btn-load-audio').onclick=()=>$('input-audio').click();
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
    reader.onload = (event) => {
      const arrayBuffer = event.target.result;
      // Clear cache and buffer immediately
      waveformCache.clear();
      audioBuffer = null;

      // Create a fresh Blob from the array buffer - this fixes demuxer and sound issues
      const blob = new Blob([arrayBuffer], { type: f.type || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      audio.src = url;
      audio.load(); 
      updateFileUI();
      
      // Decode audio for waveform
      decodeAudioForWaveform(arrayBuffer);
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
  
  alert(`${msg}${details}\n\nPlease convert the audio to a standard MP3/WAV, or try using Firefox.`);
  
  // Revert UI since audio failed
  stopPlay();
  audioFilename = "";
  audioFullname = "";
  updateFileUI();
  if(lines.length === 0) $('placeholder').style.display = 'flex';
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
    
    if (!pRadio || !rRadio) return alert("Select both a Primary and a Reference segment.");
    
    const pIdx = parseInt(pRadio.value);
    const rIdx = parseInt(rRadio.value);
    
    if (pIdx === rIdx) return alert("Primary and Reference segments must be different.");
    
    const primaryCues = parseContent(pendingSegments[pIdx], pendingFormat);
    const refCues = parseContent(pendingSegments[rIdx], pendingFormat);
    
    if (primaryCues.length <= refCues.length) {
        return alert(`Primary segment (${primaryCues.length} lines) should ideally have more lines than Reference (${refCues.length} lines) to merge correctly.`);
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
    applySmartMergeFromCues(refCues, pendingFormat);
    
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

// â”€â”€ Dropdown Menus â”€â”€
function setupDropdown(btnId, menuId){
  const btn=$(btnId), menu=$(menuId);
  btn.onclick=e=>{e.stopPropagation();document.querySelectorAll('.dropdown-menu.open').forEach(m=>{if(m!==menu)m.classList.remove('open');});menu.classList.toggle('open');};
}
setupDropdown('btn-tools','tools-menu');
setupDropdown('btn-export','export-menu');
document.addEventListener('click',()=>document.querySelectorAll('.dropdown-menu.open').forEach(m=>m.classList.remove('open')));

// â”€â”€ Export â”€â”€
function performExport(f, isQuick = false) {
  if(!f || !lines.length) return;
  
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
  const ext={lrc:'lrc',lrc_enhanced:'lrc',srt:'srt',vtt:'vtt',vtt_karaoke:'vtt',ttml:'ttml',ttml_karaoke:'ttml',srv1:'srv1',srv2:'srv2',srv3:'srv3',srv3_karaoke:'srv3',json:'json',json3:'json',lyricsfile:'lyricsfile',txt:'txt',audacity:'txt',audacity_karaoke:'txt'}[targetFormat]||'txt';
  
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
  downloadFile(exportAs(lines.map(l=>({startMs:l.startMs,endMs:l.endMs,text:l.text,words:l.words})), targetFormat, duration, { autoEmptyLines: autoEmpty }), name);
}

$('export-menu').onclick=e=>{
  e.stopPropagation(); // Prevent closing when clicking non-item areas (like the toggle)
  const item=e.target.closest('.dropdown-item');if(!item)return;
  performExport(item.dataset.format, false); // Manual export: respect chosen format
  $('export-menu').classList.remove('open');
};

// â”€â”€ Tools â”€â”€
$('tool-shift-time').onclick=()=>{$('tools-menu').classList.remove('open');$('shift-modal').style.display='flex';$('shift-amount').value=0;};
$('tool-find-replace').onclick=()=>{$('tools-menu').classList.remove('open');$('find-replace-modal').style.display='flex';};
$('tool-sort-rows').onclick=()=>{lines.sort((a,b)=>a.startMs-b.startMs);pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-remove-empty-lines').onclick=()=>{lines=lines.filter(l=>(l.words&&l.words.length>0)||l.text.trim());pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
// --- Gap Filling Logic ---
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
        clearDB().then(() => location.reload());
    }
};

function mergeSelectedLines() {
  const checks = Array.from(document.querySelectorAll('.line-checkbox:checked')).map(c => parseInt(c.dataset.id));
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
        allWords.push({ id: Date.now() + Math.random(), text: "", startMs: l.startMs, endMs: l.endMs });
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
    alert("Please select at least two lines to merge.");
  }
}

function applySmartMerge(refContent, refFormat) {
  const refCues = parseContent(refContent, refFormat);
  applySmartMergeFromCues(refCues, refFormat);
}

function applySmartMergeFromCues(refCues, refFormat) {
  if (!lines.length) return;
  autoFillWords(lines);
  let allWords = lines.flatMap(l => l.words || []);
  if (!allWords.length) return alert("No words found to merge.");

  if (!refCues.length) return alert("No lines found in reference.");

  const newLines = [];
  let wordIdx = 0;
  const isTimestampBased = refFormat !== 'txt';

  refCues.forEach((refCue, idx) => {
    const refText = refCue.text.trim();
    let lineWords = [];

    // Smart logic: prioritize text phrasing if the reference cue has text.
    // This avoids loose line-level timestamps from "sucking in" words from the next phrase.
    const refWords = refText.split(/\s+/).filter(w => w);
    const refWordsCount = refWords.length;
    
    let mode = (isTimestampBased && refWordsCount === 0) ? 'time' : 'text';
    
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
        lineWords.push(allWords[wordIdx]);
        wordIdx++;
      }
    } else {
      let addedNonEmpty = 0;
      while (wordIdx < allWords.length && addedNonEmpty < refWordsCount) {
        const w = allWords[wordIdx];
        lineWords.push(w);
        if (w.text && w.text.trim()) {
          addedNonEmpty++;
        }
        wordIdx++;
      }
      // Peek ahead: if there are trailing blank words before the next non-empty word, 
      // include them in the current line to preserve the silence/timing gap.
      // CRITICAL: We stop if we hit the start of the next reference cue to avoid stealing words from it.
      const nextRefStart = (idx < refCues.length - 1) ? refCues[idx + 1].startMs : Infinity;
      while (wordIdx < allWords.length && (!allWords[wordIdx].text || !allWords[wordIdx].text.trim())) {
        if (allWords[wordIdx].startMs >= nextRefStart) break; 
        lineWords.push(allWords[wordIdx]);
        wordIdx++;
      }
    }

    // Preserve the line if it has words OR if the reference specifically had an empty line/cue
    if (lineWords.length > 0 || refText === "") {
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

  if (wordIdx < allWords.length) {
    const rem = allWords.slice(wordIdx);
    newLines.push({
      id: newLines.length + 1,
      startMs: rem[0].startMs,
      endMs: rem[rem.length - 1].endMs,
      text: rem.map(w => w.text).join(' '),
      words: rem.map((w, widx) => ({ ...w, id: (newLines.length) * 1000 + widx + 1 }))
    });
  }
  
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

$('btn-smart-merge-header').onclick = () => $('smart-merge-modal').style.display = 'flex';
$('tool-smart-merge').onclick = () => { $('tools-menu').classList.remove('open'); $('smart-merge-modal').style.display = 'flex'; };

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
  const checks=Array.from(document.querySelectorAll('.line-checkbox:checked')).map(c=>parseInt(c.dataset.id));
  if(checks.length === 0) return alert("Please select at least one line to split.");
  linesToSplit = lines.filter(l=>checks.includes(l.id));
  
  if (linesToSplit.length === 1) {
    const l = linesToSplit[0];
    const maxW = (l.words && l.words.length > 0) ? l.words.length - 1 : (l.text.trim().split(/\s+/).length - 1);
    if(maxW < 1) return alert("Line only has 1 word. Cannot split.");
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
  let maxId=lines.reduce((m,l)=>Math.max(m,l.id),0);
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
  const sIds=Array.from(checks).map(c=>parseInt(c.dataset.id));
  const tgts=sIds.length?lines.filter(l=>sIds.includes(l.id)):lines;
  tgts.forEach(l=>{
    if(l.words && l.words.length > 0){
      const startMs = l.words[0].startMs;
      const endMs = l.words[l.words.length - 1].endMs;
      l.words = [{ id: Date.now() + Math.random(), text: l.text.trim(), startMs, endMs }];
    }
  });
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};

$('tool-join-words').onclick=()=>{
  const checks=document.querySelectorAll('.line-checkbox:checked');
  const sIds=Array.from(checks).map(c=>parseInt(c.dataset.id));
  const tgts=sIds.length?lines.filter(l=>sIds.includes(l.id)):lines;
  tgts.forEach(l=>{
    l.text = l.text.replace(/\s+/g, '');
    if(l.words && l.words.length > 0){
        const startMs = l.words[0].startMs;
        const endMs = l.words[l.words.length - 1].endMs;
        l.words = [{ id: Date.now() + Math.random(), text: l.text, startMs, endMs }];
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
    const isBlank = !t || t === "\\" || t === "\"";
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

// â”€â”€ Hot Fix (one-click combo) â”€â”€
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


  
  // 2. Word-level structural cleanup
  lines.forEach(l => {
    if(!l.words || !l.words.length) return;
    
    // Remove zero-duration or invalid blank/ghost blocks
    l.words = l.words.filter(w => {
        const t = (w.text || "").trim();
        if (!t || t === "\\" || t === "\"") {
            if (w.endMs <= w.startMs) return false;
            if (w.startMs === 0 && w.endMs === 0) return false;
        }
        return true;
    });
    
    if(l.words.length === 0) return;

    // 3. Resolve overlaps (Fix Word Overlaps)
    const minD = 20;
    for (let i = 0; i < l.words.length - 1; i++) {
        if (l.words[i].endMs > l.words[i + 1].startMs) {
            l.words[i + 1].startMs = l.words[i].endMs;
            if (l.words[i + 1].endMs < l.words[i + 1].startMs + minD) {
                l.words[i + 1].endMs = l.words[i + 1].startMs + minD;
            }
        }
    }
    
    // 4. Fill gaps (Ensure full line coverage)
    l.words[0].startMs = l.startMs;
    for (let i = 0; i < l.words.length - 1; i++) {
        l.words[i].endMs = l.words[i + 1].startMs;
    }
    l.words[l.words.length - 1].endMs = l.endMs;
  });

  // 5. Resolve Line-Level Overlaps & Jumps (Sequential Alignment)
  const minD = 20;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].endMs > lines[i + 1].startMs) {
      lines[i].endMs = lines[i + 1].startMs;
      // Also ensure words inside the line don't exceed the new boundary
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
  


// â”€â”€ Shift Time Modal â”€â”€
$('shift-minus-500').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)-500;
$('shift-minus-100').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)-100;
$('shift-plus-100').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)+100;
$('shift-plus-500').onclick=()=>$('shift-amount').value=parseInt($('shift-amount').value||0)+500;
$('shift-cancel').onclick=()=>$('shift-modal').style.display='none';
$('shift-apply').onclick=()=>{
const ms=parseInt($('shift-amount').value)||0;
  const checks = document.querySelectorAll('.line-checkbox:checked');
  const selectedIds = Array.from(checks).map(c => parseInt(c.dataset.id));
  const targetLines = selectedIds.length ? lines.filter(l => selectedIds.includes(l.id)) : lines;
  targetLines.forEach(l=>{l.startMs=Math.max(0,l.startMs+ms);l.endMs=Math.max(0,l.endMs+ms);if(l.words)l.words.forEach(w=>{w.startMs=Math.max(0,w.startMs+ms);w.endMs=Math.max(0,w.endMs+ms);});});
  pushHistory();renderTimeline();$('shift-modal').style.display='none';
};

// â”€â”€ Selection Logic â”€â”€
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
    const label = master.parentElement.querySelector('span') || master.nextSibling;
    
    if (checked.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        if (label) label.textContent = "Select All / None";
    } else if (checked.length === cbs.length) {
        master.checked = true;
        master.indeterminate = false;
        if (label) label.textContent = `Select All / None (${checked.length})`;
    } else {
        master.checked = false;
        master.indeterminate = true;
        if (label) label.textContent = `Select All / None (${checked.length})`;
    }
}

// â”€â”€ Find & Replace Modal â”€â”€
$('fr-cancel').onclick=()=>$('find-replace-modal').style.display='none';
$('fr-apply').onclick=()=>{
  const f=$('find-text').value, r=$('replace-text').value;
  if(!f)return;
  const checks = document.querySelectorAll('.line-checkbox:checked');
  const selectedIds = Array.from(checks).map(c => parseInt(c.dataset.id));
  const targetLines = selectedIds.length ? lines.filter(l => selectedIds.includes(l.id)) : lines;
  targetLines.forEach(l=>{l.text=l.text.split(f).join(r);if(l.words)l.words.forEach(w=>w.text=w.text.split(f).join(r));});
  pushHistory();renderTimeline();$('find-replace-modal').style.display='none';
};

// â”€â”€ Edit Text Modal â”€â”€
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
    input.value = input.value.replace(/\s?[\\"]\s?/g, '').replace(/\s+/g, ' ').trim();
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

$('et-apply').onclick = () => {
  const inputVal = $('edit-text-input').value.trim();
  if (editingLine) {
    // Fix tokenization: ensure \ and " are treated as separate tokens even if attached to words
    const newTokens = inputVal.replace(/([\\"])/g, ' $1 ').split(/\s+/).filter(t => t);
    const oldWords = (editingLine.words && editingLine.words.length > 0)
        ? editingLine.words
        : editingLine.text.trim().split(/\s+/).filter(t => t).map((t, i, arr) => {
            const p = (editingLine.endMs - editingLine.startMs) / arr.length;
            return {
                id: `tmp-${Date.now()}-${i}`,
                text: t,
                startMs: Math.round(editingLine.startMs + p * i),
                endMs: Math.round(editingLine.startMs + p * (i + 1))
            };
        });

    const keepStructure = $('edit-keep-structure').checked;

    // 1. Case: Word counts match
    if (newTokens.length === oldWords.length) {
        let resultWords;

        if (keepStructure) {
            // ON: Sequential â€” slot N keeps its timestamp, text changes
            resultWords = oldWords.map((w, i) => ({
                ...w,
                text: (newTokens[i] === '\\' || newTokens[i] === '"') ? "" : newTokens[i]
            }));
        } else {
            // OFF (default): Smart â€” words carry their DURATION to new positions
            const usedOld = new Set();
            const matched = new Array(newTokens.length).fill(null);

            // First pass: Match identical words (case-insensitive)
            newTokens.forEach((t, i) => {
                const text = (t === '\\' || t === '"') ? "" : t;
                const matchIdx = oldWords.findIndex((ow, idx) =>
                    !usedOld.has(idx) && ow.text.toLowerCase() === text.toLowerCase()
                );
                if (matchIdx !== -1) {
                    matched[i] = {
                        text: text,
                        duration: oldWords[matchIdx].endMs - oldWords[matchIdx].startMs,
                        id: oldWords[matchIdx].id
                    };
                    usedOld.add(matchIdx);
                }
            });

            // Second pass: Fill unmatched with remaining old words' durations
            const remainingOld = oldWords.filter((_, idx) => !usedOld.has(idx));
            let remIdx = 0;
            newTokens.forEach((t, i) => {
                if (!matched[i]) {
                    const text = (t === '\\' || t === '"') ? "" : t;
                    if (remIdx < remainingOld.length) {
                        matched[i] = {
                            text: text,
                            duration: remainingOld[remIdx].endMs - remainingOld[remIdx].startMs,
                            id: remainingOld[remIdx].id
                        };
                        remIdx++;
                    } else {
                        matched[i] = { text: text, duration: 50, id: Date.now() + i };
                    }
                }
            });

            // Place words sequentially, preserving proportional durations
            const lineStart = oldWords[0].startMs;
            const lineEnd = oldWords[oldWords.length - 1].endMs;
            const totalSpan = lineEnd - lineStart;
            const totalDur = matched.reduce((sum, m) => sum + m.duration, 0);
            let cursor = lineStart;

            resultWords = matched.map((m, i) => {
                const dur = (totalDur > 0) ? (m.duration / totalDur) * totalSpan : totalSpan / matched.length;
                const word = {
                    id: m.id,
                    text: m.text,
                    startMs: Math.round(cursor),
                    endMs: Math.round(cursor + dur)
                };
                cursor = word.endMs;
                return word;
            });
            // Snap last word to exact line boundary
            resultWords[resultWords.length - 1].endMs = lineEnd;
        }

        editingLine.words = resultWords;
        editingLine.text = resultWords.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
        pushHistory(); renderTimeline();
        $('edit-text-modal').style.display = 'none'; editingLine = null;
        return;
    }

    // 2. Case: Keep Structure (Different word counts)
    if (keepStructure) {
        const resultWords = [];
        newTokens.forEach((t, i) => {
            const text = (t === '\\' || t === '"') ? "" : t;
            if (i < oldWords.length) {
                resultWords.push({ ...oldWords[i], text: text });
            } else {
                const last = resultWords[resultWords.length - 1];
                const start = last ? last.endMs : (oldWords.length ? oldWords[oldWords.length-1].endMs : editingLine.startMs);
                resultWords.push({ id: Date.now() + i, text: text, startMs: start, endMs: Math.max(start + 100, editingLine.endMs) });
            }
        });
        for (let i = newTokens.length; i < oldWords.length; i++) {
            resultWords.push({ ...oldWords[i], text: "" });
        }
        editingLine.words = resultWords;
        editingLine.text = resultWords.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
        pushHistory(); renderTimeline();
        $('edit-text-modal').style.display = 'none'; editingLine = null;
        return;
    }

    // 3. Case: Smart Alignment (LCS - Different word counts)
    function getLCS(arr1, arr2) {
        const n = arr1.length, m = arr2.length;
        const dp = Array.from({length: n+1}, () => Array(m+1).fill(0));
        for (let i=1; i<=n; i++) {
            for (let j=1; j<=m; j++) {
                const w1 = arr1[i-1].text.toLowerCase();
                const w2 = arr2[j-1].toLowerCase();
                const isMatch = (w1 === w2) || (w1 === "" && (w2 === "\\" || w2 === '"'));
                if (isMatch) dp[i][j] = dp[i-1][j-1] + 1;
                else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
            }
        }
        const res = []; let i=n, j=m;
        while (i>0 && j>0) {
            const w1 = arr1[i-1].text.toLowerCase();
            const w2 = arr2[j-1].toLowerCase();
            const isMatch = (w1 === w2) || (w1 === "" && (w2 === "\\" || w2 === '"'));
            if (isMatch) {
                res.unshift({oldIdx: i-1, newIdx: j-1}); i--; j--;
            } else if (dp[i-1][j] > dp[i][j-1]) i--; else j--;
        }
        return res;
    }

    const anchors = getLCS(oldWords, newTokens);
    const resultWords = [];

    // Add virtual anchors at start/end
    const fullAnchors = [
        {oldIdx: -1, newIdx: -1, endMs: editingLine.startMs},
        ...anchors.map(a => ({...a, startMs: oldWords[a.oldIdx].startMs, endMs: oldWords[a.oldIdx].endMs})),
        {oldIdx: oldWords.length, newIdx: newTokens.length, startMs: editingLine.endMs}
    ];

    for (let i = 0; i < fullAnchors.length - 1; i++) {
        const curr = fullAnchors[i], next = fullAnchors[i+1];

        // Add current anchor if it's real
        if (curr.oldIdx !== -1) {
            resultWords.push({
                ...oldWords[curr.oldIdx],
                text: (newTokens[curr.newIdx] === "\\" || newTokens[curr.newIdx] === '"') ? "" : newTokens[curr.newIdx]
            });
        }

        // Process gap between current and next anchor
        const oldGapStart = curr.oldIdx === -1 ? curr.endMs : oldWords[curr.oldIdx].endMs;
        const oldGapEnd = next.oldIdx === oldWords.length ? next.startMs : oldWords[next.oldIdx].startMs;

        const oldInGap = oldWords.slice(curr.oldIdx + 1, next.oldIdx);
        const newInGap = newTokens.slice(curr.newIdx + 1, next.newIdx);

        if (newInGap.length > 0) {
            if (oldInGap.length > 0) {
                // If we have both, map them proportionally
                const spanStart = oldInGap[0].startMs;
                const spanEnd = oldInGap[oldInGap.length - 1].endMs;
                const dur = spanEnd - spanStart;
                const perW = dur / newInGap.length;
                newInGap.forEach((t, idx) => {
                    const isBlank = (t === "\\" || t === '"');
                    resultWords.push({
                        id: oldInGap[idx] ? oldInGap[idx].id : (Date.now() + Math.random()),
                        text: isBlank ? "" : t,
                        startMs: Math.round(spanStart + perW * idx),
                        endMs: Math.round(spanStart + perW * (idx + 1))
                    });
                });
            } else {
                // Pure insertion: Steal space from neighbors (prev and next)
                const newWordMin = 50;
                const existingWordMin = 20;

                const minNeeded = newWordMin * newInGap.length;
                let insertStart = oldGapStart;
                let insertEnd = oldGapEnd;
                let available = insertEnd - insertStart;

                if (available < minNeeded) {
                    const toSteal = minNeeded - available;
                    const prev = resultWords.length > 0 ? resultWords[resultWords.length - 1] : null;
                    const nWord = next.oldIdx < oldWords.length ? oldWords[next.oldIdx] : null;

                    const prevCap = prev ? Math.max(0, (prev.endMs - prev.startMs) - existingWordMin) : 0;
                    const nextCap = nWord ? Math.max(0, (nWord.endMs - nWord.startMs) - existingWordMin) : 0;
                    const totalCap = prevCap + nextCap;

                    if (totalCap > 0) {
                        const prevSteal = (prevCap / totalCap) * toSteal;
                        const nextSteal = (nextCap / totalCap) * toSteal;

                        if (prev) {
                            prev.endMs -= prevSteal;
                            insertStart = prev.endMs;
                        }
                        if (nWord) {
                            nWord.startMs += nextSteal;
                            insertEnd = nWord.startMs;
                            fullAnchors[i+1].startMs = nWord.startMs;
                        }
                    }
                }

                // Recalculate available and perW after stealing
                available = Math.max(minNeeded, insertEnd - insertStart);
                const perW = available / newInGap.length;
                newInGap.forEach((t, idx) => {
                    const isBlank = (t === "\\" || t === '"');
                    resultWords.push({
                        id: Date.now() + Math.random(),
                        text: isBlank ? "" : t,
                        startMs: Math.round(insertStart + perW * idx),
                        endMs: Math.round(insertStart + perW * (idx + 1))
                    });
                });
            }
        } else if (oldInGap.length > 0) {
            // Words were deleted in the text modal.
            // Merge their duration into the preceding word (curr or last in resultWords)
            const lastWord = resultWords.length > 0 ? resultWords[resultWords.length - 1] : null;
            if (lastWord) {
                lastWord.endMs = oldInGap[oldInGap.length - 1].endMs;
            } else if (next.oldIdx < oldWords.length) {
                // If no previous word, expand the next anchor's start
                oldWords[next.oldIdx].startMs = oldGapStart;
                fullAnchors[i+1].startMs = oldGapStart;
            }
        }
    }

    editingLine.words = resultWords;
    editingLine.text = resultWords.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    pushHistory(); renderTimeline();
  }
  $('edit-text-modal').style.display = 'none';
  editingLine = null;
};

// â”€â”€ Undo/Redo Buttons â”€â”€
$('btn-undo').onclick=undo;
$('btn-redo').onclick=redo;

// â”€â”€ View Mode Toggle â”€â”€
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
}

$('view-one-line').onclick = () => setViewMode('default');
$('view-compact').onclick = () => setViewMode('compact');

// â”€â”€ Highlight Toggle â”€â”€
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
    updateDisplay();
};

// â”€â”€ Prev/Next Line â”€â”€
function centerActiveLine() {
    const active = document.querySelector('.timeline-track.active');
    if (active) {
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

$('btn-prev-line').onclick=()=> jumpLines(-1);
$('btn-next-line').onclick=()=> jumpLines(1);

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

// â”€â”€ Keyboard Shortcuts â”€â”€
window.addEventListener('keydown', e => {
  const isMod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    $('shift-modal').style.display = 'none';
    $('split-line-modal').style.display = 'none';
    $('find-replace-modal').style.display = 'none';
    $('shortcuts-modal').style.display = 'none';
    $('edit-text-modal').style.display = 'none';
    $('smart-merge-modal').style.display = 'none';
    $('format-text-modal').style.display = 'none';
    $('jump-line-modal').style.display = 'none';
    $('jump-word-modal').style.display = 'none';
    if (document.activeElement === $('search-input')) {
      $('search-input').blur();
    }
    return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

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


function nudgeTime(ms) {
    if (!lines.length) return;
    
    // Check if there are any selected lines
    const selectedIds = new Set();
    document.querySelectorAll('.line-checkbox:checked').forEach(cb => {
        const id = parseInt(cb.closest('.timeline-track').id.replace('tc-', ''));
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
    
    pushHistory(); 
    renderTimeline();
}

// ── Search ──
$('search-input').oninput=e=>{
  const q=e.target.value.toLowerCase();
  $('search-clear').style.display = q ? 'block' : 'none';
  if (q) container.classList.add('searching');
  else container.classList.remove('searching');

  document.querySelectorAll('.timeline-track').forEach(t=>{t.style.display='';});
  if(!q)return;
  lines.forEach(l=>{
      const el=$(`tc-${l.id}`);
      if(el) {
          const text = (l.text || "").toLowerCase();
          const wordMatch = l.words ? l.words.some(w => (w.text || "").toLowerCase().includes(q)) : false;
          if(!text.includes(q) && !wordMatch) el.style.display='none';
      }
  });
};

$('search-clear').onclick = () => {
    $('search-input').value = '';
    $('search-clear').style.display = 'none';
    container.classList.remove('searching');
    document.querySelectorAll('.timeline-track').forEach(t => { t.style.display = ''; });
    $('search-input').focus();
};

// ── Fullscreen ──
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

// â”€â”€ Shortcuts Modal â”€â”€
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
        clearDB().then(() => location.reload());
    }
};

$('btn-delete-selected').onclick = () => {
    const checks = document.querySelectorAll('.line-checkbox:checked');
    if (!checks.length) return;
    if (confirm(`Are you sure you want to delete ${checks.length} selected lines?`)) {
        const selectedIds = Array.from(checks).map(c => parseInt(c.dataset.id));
        lines = lines.filter(l => !selectedIds.includes(l.id));
        pushHistory();
        renderTimeline();
    }
};

// ── Jump to Line ──
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
        alert(`Invalid line number. Please enter a number between 1 and ${lines.length}.`);
    }
};
$('jump-line-input').onkeydown = (e) => {
    if (e.key === 'Enter') $('jl-apply').click();
};

window.addEventListener('click', (e) => { 
    if (e.target === $('shortcuts-modal')) $('shortcuts-modal').style.display = 'none'; 
    if (e.target === $('jump-line-modal')) $('jump-line-modal').style.display = 'none';
    if (e.target === $('jump-word-modal')) $('jump-word-modal').style.display = 'none';
});

// ── Jump to Word ──
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
        if (!found) alert("Word index out of range");
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

// â”€â”€ Drag & Drop â”€â”€
document.addEventListener('dragover', e => {
    e.preventDefault();
    if (!lines.length) container.classList.add('drag-over');
});
document.addEventListener('dragleave', e => {
    container.classList.remove('drag-over');
});
document.addEventListener('drop', e => {
    e.preventDefault();
    container.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;

    let audioToLoad = null, audioCount = 0;
    let lyricsToLoad = null, lyricsCount = 0;

    const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm', 'mp4'];
    const lyricsExts = ['lrc', 'srt', 'vtt', 'txt', 'json', 'xml', 'ttml', 'lyricsfile', 'srv1', 'srv2', 'srv3'];

    for (const f of files) {
        const ext = f.name.split('.').pop().toLowerCase();
        if (f.type.startsWith('audio/') || f.type.startsWith('video/') || audioExts.includes(ext)) {
            audioCount++; audioToLoad = f;
        } else if (lyricsExts.includes(ext)) {
            lyricsCount++; lyricsToLoad = f;
        }
    }

    if (audioCount > 1 || lyricsCount > 1) {
        alert("Too many files! Please drop only 1 audio and/or 1 lyrics file at a time.");
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

// â”€â”€ Init â”€â”€
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
        return;
    }
    
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    if (width <= 0 || height <= 0) return;
    
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
}
