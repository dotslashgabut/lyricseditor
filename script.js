// ── Database (IndexedDB) for True Persistence ──
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

// ── Global State ──
let audio = new Audio(), lines = [], isPlaying = false, isRepeat = false;
let currentTime = 0, duration = 0, rafId = null, activeLineId = null;
let audioFullname = '', lyricsFullname = '';
let lastAudioFile = null, lastLyricsFile = null;
let history = [{lines:[], audioFN:'', lyricsFN:'', audioFull:'', lyricsFull:'', origFN:'lyrics'}], histIdx = 0;
let lastImportFormat = 'lrc', audioFilename = '', lyricsFilename = '', isWordHighlightEnabled = true, originalFilename = 'lyrics', editingLine = null;

const $ = id => document.getElementById(id);
const playBtn=$('btn-play-pause'), stopBtn=$('btn-stop'), repeatBtn=$('btn-repeat');
const timeDisp=$('time-display'), progFill=$('progress-fill'), volSlider=$('volume-slider');
const container=$('timeline-container'), statL=$('stat-lines'), statW=$('stat-words');

function fmt(s) {
  if(isNaN(s))return'00:00.00';
  const m=Math.floor(s/60),sc=Math.floor(s%60),ms=Math.floor((s%1)*100);
  return`${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
}

// ── History ──
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
  history = history.slice(0, histIdx+1);
  history.push(snap);
  if(history.length>50)history.shift();
  histIdx = history.length-1;
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
            lastImportFormat: lastImportFormat
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

function applySnapshot(snap) {
  lines = JSON.parse(JSON.stringify(snap.lines));
  audioFilename = snap.audioFN;
  lyricsFilename = snap.lyricsFN;
  audioFullname = snap.audioFull;
  lyricsFullname = snap.lyricsFull;
  originalFilename = snap.origFN;
  if (audio.src !== snap.audioSrc) {
      audio.src = snap.audioSrc || "";
      if (audio.src) audio.load();
  }
  updateFileUI();
  renderTimeline();
  updateDisplay();
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

// ── Render ──
function renderTimeline() {
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
        <div style="margin-top: 20px; font-size: 11px; opacity: 0.6; max-width: 400px; line-height: 1.5; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
            <strong>Pro Tip for High Precision:</strong><br>
            Use <b>WAV</b> or <b>FLAC</b> for sample-accurate sync. MP3 files may have slight timing offsets. 
            If audio feels off, use the <b>[</b> or <b>]</b> buttons/keys to nudge all timings.
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
    container.appendChild(tr);
    const tc = tr.querySelector('.track-content');
    const ws = (line.words && line.words.length > 0) ? line.words : [{ id: `pl-${line.id}`, text: (line.text || "").trim() || "[Empty]", startMs: line.startMs, endMs: line.endMs, isPl: true }];
    ws.forEach(w => {
      const el = document.createElement('div'); el.className='word-block'; el.id=`w-${w.id}`;
      if(w.isPl) el.style.opacity = '0.7';
      el.innerHTML=`<div class="resize-handle left"></div><div class="word-text">${w.text}</div><div class="word-duration">${((w.endMs-w.startMs)/1000).toFixed(2)}s</div><div class="resize-handle right"></div>`;
      tc.appendChild(el);
      posWord(el, w, line);
      bindDrag(el, w, line, tc, w.isPl);
    });
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
      $('edit-text-input').value = line.text.replace(/\s+/g, ' ').trim();
      $('edit-text-modal').style.display = 'flex';
      $('edit-text-input').focus();
    };
    
    container.appendChild(createAddLineBtn(idx+1));
  });
  statL.textContent=lines.length; statW.textContent=tw;
  updateDisplay();
  updateSelectionCount();
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
      end = Math.max(0, lines[0].startMs - 50);
      start = Math.max(0, end - 2000);
    }
  } else if (idx >= lines.length) {
    start = lines[lines.length-1].endMs + 50;
    end = start + 2000;
  } else {
    start = lines[idx-1].endMs + 50;
    end = lines[idx].startMs - 50;
    if (end < start) {
      start = lines[idx-1].endMs;
      end = lines[idx].startMs;
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
  if(d) d.textContent = ((w.endMs - w.startMs) / 1000).toFixed(2) + 's';
}

// ── Drag Logic ──
function bindDrag(el, word, line, tc, isPl = false) {
  const lh=el.querySelector('.resize-handle.left'), rh=el.querySelector('.resize-handle.right');
  let mode=null, sx=0, snap={}, hasDragged=false;
  const MIN=50; // 50ms min

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

// ── Playback ──
function togglePlay(){
  if(audio.src){audio.paused?audio.play():audio.pause();}
  else{isPlaying=!isPlaying;playBtn.innerHTML=isPlaying?'<i class="fas fa-pause"></i>':'<i class="fas fa-play"></i>';if(isPlaying)startTick();else cancelAnimationFrame(rafId);}
}

let lastT=0;
function startTick(){lastT=performance.now();rafId=requestAnimationFrame(tick);}
function tick(now){
  if(!isPlaying)return;
  currentTime+=(now-lastT); lastT=now;
  // Repeat logic: loop current line
  if(isRepeat && activeLineId!==null){
    const al=lines.find(l=>l.id===activeLineId);
    if(al && currentTime>=al.endMs) currentTime=al.startMs;
  }
  if(duration>0&&currentTime>=duration){
    if(isRepeat){currentTime=0;}else{isPlaying=false;currentTime=0;playBtn.innerHTML='<i class="fas fa-play"></i>';updateDisplay();return;}
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
  currentTime=ms;lastT=performance.now();updateDisplay();
}

// ── Display Update ──
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

// ── Audio Events ──
audio.addEventListener('timeupdate',()=>{currentTime=audio.currentTime*1000;updateDisplay();});
audio.addEventListener('play',()=>{isPlaying=true;playBtn.innerHTML='<i class="fas fa-pause"></i>';startAudioTick();});
audio.addEventListener('pause',()=>{isPlaying=false;playBtn.innerHTML='<i class="fas fa-play"></i>';cancelAnimationFrame(rafId);});
audio.addEventListener('loadedmetadata',()=>{duration=audio.duration*1000;updateDisplay();});
audio.addEventListener('ended',()=>{if(isRepeat){audio.currentTime=0;audio.play();}else{isPlaying=false;playBtn.innerHTML='<i class="fas fa-play"></i>';updateDisplay();}});

// High-precision ticker for audio (for smooth indicator)
function startAudioTick(){
  const loop=()=>{
    if(!audio.paused){
      currentTime=audio.currentTime*1000;
      // Line repeat with real audio
      if(isRepeat&&activeLineId!==null){const al=lines.find(l=>l.id===activeLineId);if(al&&currentTime>=al.endMs)audio.currentTime=al.startMs/1000;}
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
    repeatBtn.style.color = isRepeat ? 'var(--accent)' : '';
}

playBtn.onclick=togglePlay;
stopBtn.onclick=stopPlay;
repeatBtn.onclick=toggleRepeat;

// Progress bar seek
$('progress-bar').onclick=e=>{if(!duration)return;const r=$('progress-bar').getBoundingClientRect();seekMs(Math.max(0,(e.clientX-r.left)/r.width*duration));};

// ── File Loading ──
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
      // Create a fresh Blob from the array buffer - this fixes demuxer and sound issues
      const blob = new Blob([event.target.result], { type: f.type || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      audio.src = url;
      audio.load(); 
      updateFileUI();
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
  if (!audio.src || audio.src === window.location.href) return; // Ignore intentional ejects
  const err = audio.error;
  let msg = "Audio error occurred";
  let details = "";
  if (err) {
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
      // If there's an error event but no error object, it might be an empty src issue
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
  lastLyricsFile = f;
  saveFileToDB('lastLyrics', f); // Persist to DB
  stopPlay();
  lyricsFullname = f.name;
  lyricsFilename = f.name.replace(/\.[^/.]+$/, "");
  
  // Update name if no audio is present or if we are using the default "lyrics" name
  if (!audioFilename || originalFilename === 'lyrics') {
      originalFilename = lyricsFilename;
  }
  
  updateFileUI();

  const r=new FileReader();
  r.onload=ev=>{
    const fmt=detectFormat(f.name,ev.target.result);
    lastImportFormat = fmt;
    
    lines=parseContent(ev.target.result,fmt);
    const meta = parseMetadata(ev.target.result, fmt);
    autoFillWords(lines);
    let wid=1; lines.forEach(l=>{if(l.words)l.words.forEach(w=>w.id=wid++);});
    
    // Always calculate a reasonable project duration if no audio is loaded
    if(!audio.src){
      if(meta.durationMs > 0) duration = meta.durationMs;
      else if(lines.length) duration = lines[lines.length-1].endMs + 2000;
    }
    
    pushHistory();
    renderTimeline();
    updateDisplay();
  };
  r.readAsText(f);
}
$('input-lyrics').onchange=e=>{
  handleLyricsFile(e.target.files[0]);
  e.target.value = "";
};

// ── Dropdown Menus ──
function setupDropdown(btnId, menuId){
  const btn=$(btnId), menu=$(menuId);
  btn.onclick=e=>{e.stopPropagation();document.querySelectorAll('.dropdown-menu.open').forEach(m=>{if(m!==menu)m.classList.remove('open');});menu.classList.toggle('open');};
}
setupDropdown('btn-tools','tools-menu');
setupDropdown('btn-export','export-menu');
document.addEventListener('click',()=>document.querySelectorAll('.dropdown-menu.open').forEach(m=>m.classList.remove('open')));

// ── Export ──
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
  const ext={lrc:'lrc',lrc_enhanced:'lrc',srt:'srt',vtt:'vtt',vtt_karaoke:'vtt',ttml:'ttml',ttml_karaoke:'ttml',srv1:'srv1',srv2:'srv2',srv3:'srv3',srv3_karaoke:'srv3',json:'json',json3:'json',lyricsfile:'lyricsfile',txt:'txt'}[targetFormat]||'txt';
  
  let finalBaseName = originalFilename;
  if (audioFilename && lyricsFilename && audioFilename !== lyricsFilename) {
      finalBaseName = `${audioFilename} - ${lyricsFilename}`;
  } else {
      finalBaseName = audioFilename || lyricsFilename || "lyrics";
  }

  const name = `${finalBaseName} - lyricseditor.${ext}`;
  downloadFile(exportAs(lines.map(l=>({startMs:l.startMs,endMs:l.endMs,text:l.text,words:l.words})), targetFormat, duration, { autoEmptyLines: autoEmpty }), name);
}

$('export-menu').onclick=e=>{
  e.stopPropagation(); // Prevent closing when clicking non-item areas (like the toggle)
  const item=e.target.closest('.dropdown-item');if(!item)return;
  performExport(item.dataset.format, false); // Manual export: respect chosen format
  $('export-menu').classList.remove('open');
};

// ── Tools ──
$('tool-shift-time').onclick=()=>{$('tools-menu').classList.remove('open');$('shift-modal').style.display='flex';$('shift-amount').value=0;};
$('tool-find-replace').onclick=()=>{$('tools-menu').classList.remove('open');$('find-replace-modal').style.display='flex';};
$('tool-sort-rows').onclick=()=>{lines.sort((a,b)=>a.startMs-b.startMs);pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-remove-empty-lines').onclick=()=>{lines=lines.filter(l=>(l.words&&l.words.length>0)||l.text.trim());pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
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

$('tool-remove-overlaps').onclick=()=>{for(let i=0;i<lines.length-1;i++){if(lines[i].endMs>lines[i+1].startMs){lines[i].endMs=lines[i+1].startMs;if(lines[i].words&&lines[i].words.length)lines[i].words[lines[i].words.length-1].endMs=Math.min(lines[i].words[lines[i].words.length-1].endMs,lines[i+1].startMs);}}pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-merge-lines').onclick=()=>{const checks=Array.from(document.querySelectorAll('.line-checkbox:checked')).map(c=>parseInt(c.dataset.id));if(checks.length>1){const selected=lines.filter(l=>checks.includes(l.id));const first=selected[0],last=selected[selected.length-1];first.endMs=last.endMs;first.text=selected.map(l=>(l.text||"").trim()).filter(t=>t).join(' ');first.words=selected.flatMap(l=>l.words||[]);lines=lines.filter(l=>l.id===first.id||!checks.includes(l.id));pushHistory();renderTimeline();}$('tools-menu').classList.remove('open');};

let linesToSplit = [];
$('tool-split-lines').onclick=()=>{
  $('tools-menu').classList.remove('open');
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

$('tool-remove-punct').onclick=()=>{lines.forEach(l=>{l.text=l.text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()♪]/g,"");if(l.words)l.words.forEach(w=>w.text=w.text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()♪]/g,""));});pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-clear-words').onclick=()=>{lines.forEach(l=>l.words=[]);pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-distribute-words').onclick=()=>{const checks=document.querySelectorAll('.line-checkbox:checked');const sIds=Array.from(checks).map(c=>parseInt(c.dataset.id));const tgts=sIds.length?lines.filter(l=>sIds.includes(l.id)):lines;tgts.forEach(l=>{if(l.words&&l.words.length){const p=(l.endMs-l.startMs)/l.words.length;l.words.forEach((w,i)=>{w.startMs=Math.round(l.startMs+p*i);w.endMs=Math.round(l.startMs+p*(i+1));});}});pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};

$('tool-auto-karaoke').onclick=()=>{autoFillWords(lines);let wid=1;lines.forEach(l=>{if(l.words)l.words.forEach(w=>w.id=wid++);});pushHistory();renderTimeline();$('tools-menu').classList.remove('open');};
$('tool-fill-gaps').onclick=()=>{
  lines.forEach(c=>{if(c.words&&c.words.length){c.words[0].startMs=c.startMs;for(let i=0;i<c.words.length-1;i++)c.words[i].endMs=c.words[i+1].startMs;c.words[c.words.length-1].endMs=c.endMs;}});
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};
$('tool-remove-empty').onclick=()=>{
  lines.forEach(l=>{if(l.words)l.words=l.words.filter(w=>w.text.trim());});
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};
$('tool-compact-ws').onclick=()=>{
  lines.forEach(l=>{l.text=l.text.replace(/\s+/g,' ').trim();if(l.words)l.words.forEach(w=>w.text=w.text.trim());});
  pushHistory();renderTimeline();$('tools-menu').classList.remove('open');
};

// ── Hot Fix (one-click combo) ──
$('btn-hotfix').onclick=()=>{
  // 1. compact whitespace
  lines.forEach(l=>{l.text=l.text.replace(/\s+/g,' ').trim();if(l.words)l.words.forEach(w=>w.text=w.text.trim());});
  // 2. remove empty words
  lines.forEach(l=>{if(l.words)l.words=l.words.filter(w=>w.text.trim());});
  // 3. fill gaps
  lines.forEach(c=>{if(c.words&&c.words.length){c.words[0].startMs=c.startMs;for(let i=0;i<c.words.length-1;i++)c.words[i].endMs=c.words[i+1].startMs;c.words[c.words.length-1].endMs=c.endMs;}});
  pushHistory();renderTimeline();
};

// ── Shift Time Modal ──
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

// ── Selection Logic ──
$('check-all-lines').onclick = (e) => {
    const checked = e.target.checked;
    document.querySelectorAll('.line-checkbox').forEach(cb => cb.checked = checked);
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

// ── Find & Replace Modal ──
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

// ── Edit Text Modal ──
$('et-cancel').onclick = () => $('edit-text-modal').style.display = 'none';
$('et-apply').onclick = () => {
  const newText = $('edit-text-input').value.replace(/\s+/g, ' ').trim();
  if (newText && editingLine) {
    editingLine.text = newText;
    const newWords = editingLine.text.split(/\s+/);
    if (editingLine.words && editingLine.words.length === newWords.length) {
      editingLine.words.forEach((w, i) => w.text = newWords[i]);
    } else {
      const dur = editingLine.endMs - editingLine.startMs;
      const perW = dur / newWords.length;
      editingLine.words = newWords.map((txt, i) => ({
        id: Date.now() + i, 
        text: txt,
        startMs: Math.round(editingLine.startMs + perW * i),
        endMs: Math.round(editingLine.startMs + perW * (i + 1))
      }));
    }
    pushHistory();
    renderTimeline();
  }
  $('edit-text-modal').style.display = 'none';
  editingLine = null;
};

// ── Undo/Redo Buttons ──
$('btn-undo').onclick=undo;
$('btn-redo').onclick=redo;

// ── View Mode Toggle ──
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

// ── Highlight Toggle ──
$('btn-toggle-highlight').onclick = () => {
    isWordHighlightEnabled = !isWordHighlightEnabled;
    $('btn-toggle-highlight').style.color = isWordHighlightEnabled ? 'var(--accent)' : 'var(--text-muted)';
    updateDisplay();
};

// ── Prev/Next Line ──
function centerActiveLine() {
    const active = document.querySelector('.timeline-track.active');
    if (active) {
        active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

$('btn-prev-line').onclick=()=>{
    if(!lines.length) return;
    let activeIdx=-1;
    for(let i=0;i<lines.length;i++){
        if(lines[i].startMs <= currentTime + 50) activeIdx=i;
        else break;
    }
    let targetIdx = activeIdx - 1;
    if(targetIdx < 0) targetIdx = 0;
    seekMs(lines[targetIdx].startMs);
    setTimeout(centerActiveLine, 50); // Small delay to ensure render is updated
};

$('btn-next-line').onclick=()=>{
    if(!lines.length) return;
    const next = lines.find(l => l.startMs > currentTime + 50);
    if(next) {
        seekMs(next.startMs);
        setTimeout(centerActiveLine, 50);
    }
};

// ── Keyboard Shortcuts ──
window.addEventListener('keydown', e => {
  const isMod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    $('shift-modal').style.display = 'none';
    $('split-line-modal').style.display = 'none';
    $('find-replace-modal').style.display = 'none';
    $('shortcuts-modal').style.display = 'none';
    $('edit-text-modal').style.display = 'none';
    $('format-text-modal').style.display = 'none';
    if (document.activeElement === $('search-input')) {
      $('search-input').blur();
    }
    return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // 1. Handle specific Mod-key combinations first
  if (isMod) {
    // History
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    
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
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); stopPlay(); }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRepeat(); }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMute(); }
    if (e.key === '1') { $('btn-load-audio').click(); }
    if (e.key === '2') { $('btn-load-lyrics').click(); }
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); performExport(lastImportFormat, true); }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); $('search-input').focus(); }
    if (e.key === 'g' || e.key === 'G') { e.preventDefault(); $('tool-find-replace').click(); }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); $('tool-shift-time').click(); }
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); $('btn-hotfix').click(); }
    if (e.key === 'd' || e.key === 'D') { e.preventDefault(); setViewMode('default'); }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setViewMode('compact'); }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); $('btn-shortcuts').click(); }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); $('btn-fullscreen').click(); }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); insertBlankLine(lines.length); }
    if (e.key === 'Delete') { e.preventDefault(); $('btn-delete-selected').click(); }

    // Navigation & Seeking
    if (e.key === 'ArrowUp') { e.preventDefault(); $('btn-prev-line').click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); $('btn-next-line').click(); }
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
  document.querySelectorAll('.timeline-track').forEach(t=>{t.style.display='';});
  if(!q)return;
  lines.forEach(l=>{const el=$(`tc-${l.id}`);if(el&&!l.text.toLowerCase().includes(q))el.style.display='none';});
};

$('search-clear').onclick = () => {
    $('search-input').value = '';
    $('search-clear').style.display = 'none';
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

// ── Shortcuts Modal ──
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

window.addEventListener('click', (e) => { if (e.target === $('shortcuts-modal')) $('shortcuts-modal').style.display = 'none'; });

// Handle Esc key or other fullscreen exits
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        $('btn-fullscreen').innerHTML = '<i class="fas fa-expand"></i>';
    } else {
        $('btn-fullscreen').innerHTML = '<i class="fas fa-compress"></i>';
    }
});

// ── Drag & Drop ──
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

// ── Init ──
(async function init() {
    loadSession(); // Load text/metadata (very fast)
    updateFileUI();
    renderTimeline();
    updateDisplay();

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
                handleAudioFile(file, true); 
            } else {
                updateFileUI(); // Show reload icon
            }
        }
    });
})();
