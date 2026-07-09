// ── Metadata Editor Module for LyricsEditor ──
// Provides: appMetadata store + UI handlers + Apple TTML export integration + Audio/Lyrics Metadata Extraction

(function(){
  const defaultMetadata = {
    title: "",
    artist: "",
    album: "",
    language: "en",
    by: "",
    author: "",
    lyricist: "",
    copyright: "",
    offset: 0,
    ttmlTitle: "",
    itunesTiming: "Word",
    appleTiming: "Word",
    leadingSilence: 0,
    agents: [{id:"v1", type:"person", name:"Lead"}],
    songwriters: [],
    appleSongwriters: [],
    enableBackgroundExport: true
  };

  window.appMetadata = window.appMetadata || JSON.parse(JSON.stringify(defaultMetadata));

  function loadAppMetadata(){
    try{
      const raw = localStorage.getItem('lyricseditor_metadata');
      if(raw){
        const parsed = JSON.parse(raw);
        window.appMetadata = {...defaultMetadata, ...window.appMetadata, ...parsed};
        if(!Array.isArray(window.appMetadata.agents) || window.appMetadata.agents.length===0) window.appMetadata.agents = [{id:"v1", type:"person"}];
      }
    }catch(e){ console.warn("Failed to load metadata", e); }
  }
  function saveAppMetadata(){
    try{ localStorage.setItem('lyricseditor_metadata', JSON.stringify(window.appMetadata)); }catch(e){}
  }
  window.loadAppMetadata = loadAppMetadata;
  window.saveAppMetadata = saveAppMetadata;
  loadAppMetadata();

  function $(id){ return document.getElementById(id); }

  function parseAgentsTextarea(text){
    return text.split('\n').map(l=>l.trim()).filter(Boolean).map(line=>{
      const parts = line.split('|');
      if(parts.length>=2) return {id: parts[0].trim(), type:"person", name: parts.slice(1).join('|').trim()};
      return {id: line.trim(), type:"person", name: line.trim()};
    });
  }
  function agentsToTextarea(agents){
    if(!agents || !agents.length) return "v1|Lead Vocal\nv2|Backing Vocal";
    return agents.map(a=> a.name && a.name!==a.id ? `${a.id}|${a.name}` : `${a.id}`).join('\n');
  }

  function populateForm(){
    const m = window.appMetadata;
    if($('meta-title')) $('meta-title').value = m.title||"";
    if($('meta-artist')) $('meta-artist').value = m.artist||"";
    if($('meta-album')) $('meta-album').value = m.album||"";
    if($('meta-language')) $('meta-language').value = m.language||"en";
    if($('meta-by')) $('meta-by').value = m.by||"";
    if($('meta-author')) $('meta-author').value = m.author||"";
    if($('meta-copyright')) $('meta-copyright').value = m.copyright||"";
    if($('meta-offset')) $('meta-offset').value = m.offset||0;
    if($('meta-lyricist')) $('meta-lyricist').value = m.lyricist||"";
    if($('meta-itunes-timing')) $('meta-itunes-timing').value = m.itunesTiming||"Word";
    if($('meta-leading-silence')) $('meta-leading-silence').value = m.leadingSilence||0;
    if($('meta-agents')) $('meta-agents').value = agentsToTextarea(m.agents);
    if($('meta-songwriters')) $('meta-songwriters').value = (m.songwriters||[]).join('\n');
    if($('meta-enable-bg')) $('meta-enable-bg').checked = m.enableBackgroundExport!==false;
  }

  function collectForm(){
    const m = window.appMetadata;
    m.title = $('meta-title')?.value.trim()||"";
    m.artist = $('meta-artist')?.value.trim()||"";
    m.album = $('meta-album')?.value.trim()||"";
    m.language = $('meta-language')?.value.trim()||"en";
    m.by = $('meta-by')?.value.trim()||"";
    m.author = $('meta-author')?.value.trim()||"";
    m.copyright = $('meta-copyright')?.value.trim()||"";
    m.offset = parseInt($('meta-offset')?.value)||0;
    m.lyricist = $('meta-lyricist')?.value.trim()||"";
    m.itunesTiming = $('meta-itunes-timing')?.value||"Word";
    m.appleTiming = m.itunesTiming;
    m.leadingSilence = parseInt($('meta-leading-silence')?.value)||0;
    m.agents = parseAgentsTextarea($('meta-agents')?.value||"");
    if(m.agents.length===0) m.agents = [{id:"v1", type:"person"}];
    const swText = $('meta-songwriters')?.value||"";
    m.songwriters = swText.split('\n').map(s=>s.trim()).filter(Boolean);
    m.appleSongwriters = [...m.songwriters];
    m.enableBackgroundExport = $('meta-enable-bg')?.checked!==false;
    saveAppMetadata();
  }

  function openMetadataEditor(){
    populateForm();
    const modal = $('metadata-modal');
    if(modal) modal.style.display='flex';
    // reset tabs to common
    document.querySelectorAll('#metadata-modal .toggle-btn').forEach(b=>b.classList.remove('active'));
    document.querySelector('#meta-tab-common')?.classList.add('active');
    document.querySelectorAll('#metadata-tab-common, #metadata-tab-lrc, #metadata-tab-ttml').forEach(el=>{
      if(el) el.style.display = el.id==='metadata-tab-common' ? 'block' : 'none';
    });
  }
  window.openMetadataEditor = openMetadataEditor;

  // Simple ID3v2/ID3v1 tags parser for local audio files
  async function extractAudioMetadata(file) {
    const meta = { title: "", artist: "", album: "" };
    if (!file) return meta;

    // Default to filename parsing
    const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
    const parts = nameWithoutExt.split(" - ");
    if (parts.length >= 2) {
      meta.artist = parts[0].trim();
      meta.title = parts.slice(1).join(" - ").trim();
    } else {
      meta.title = nameWithoutExt.trim();
    }

    try {
      const headerBuffer = await file.slice(0, 10).arrayBuffer();
      const dv = new DataView(headerBuffer);
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2));
      if (magic === "ID3") {
        const version = dv.getUint8(3);
        const sizeBytes = [dv.getUint8(6), dv.getUint8(7), dv.getUint8(8), dv.getUint8(9)];
        const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
        
        const tagBuffer = await file.slice(10, 10 + tagSize).arrayBuffer();
        const tagDv = new DataView(tagBuffer);
        let offset = 0;
        
        while (offset < tagBuffer.byteLength - 10) {
          let frameId = "";
          let frameSize = 0;
          let isVersion3Or4 = version === 3 || version === 4;
          
          if (isVersion3Or4) {
            frameId = String.fromCharCode(tagDv.getUint8(offset), tagDv.getUint8(offset + 1), tagDv.getUint8(offset + 2), tagDv.getUint8(offset + 3));
            if (version === 4) {
              const b = [tagDv.getUint8(offset + 4), tagDv.getUint8(offset + 5), tagDv.getUint8(offset + 6), tagDv.getUint8(offset + 7)];
              frameSize = (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3];
            } else {
              frameSize = tagDv.getUint32(offset + 4, false);
            }
            offset += 10;
          } else if (version === 2) {
            frameId = String.fromCharCode(tagDv.getUint8(offset), tagDv.getUint8(offset + 1), tagDv.getUint8(offset + 2));
            frameSize = (tagDv.getUint8(offset + 3) << 16) | (tagDv.getUint8(offset + 4) << 8) | tagDv.getUint8(offset + 5);
            offset += 6;
          } else {
            break;
          }
          
          if (!frameId || frameId.charCodeAt(0) === 0 || frameSize <= 0 || offset + frameSize > tagBuffer.byteLength) {
            break;
          }
          
          const isArtist = frameId === "TPE1" || frameId === "TP1";
          const isTitle = frameId === "TIT2" || frameId === "TT2";
          const isAlbum = frameId === "TALB" || frameId === "TAL";
          
          if (isArtist || isTitle || isAlbum) {
            const encoding = tagDv.getUint8(offset);
            let text = "";
            const textBytes = new Uint8Array(tagBuffer, offset + 1, frameSize - 1);
            
            if (encoding === 0) {
              text = new TextDecoder("latin1").decode(textBytes);
            } else if (encoding === 1 || encoding === 2) {
              text = new TextDecoder("utf-16").decode(textBytes);
            } else if (encoding === 3) {
              text = new TextDecoder("utf-8").decode(textBytes);
            }
            
            text = text.replace(/^\0+/, "").replace(/\0+$/, "").trim();
            if (text) {
              if (isArtist) meta.artist = text;
              else if (isTitle) meta.title = text;
              else if (isAlbum) meta.album = text;
            }
          }
          offset += frameSize;
        }
      }
    } catch (e) {
      console.warn("Failed to extract ID3 tags", e);
    }
    return meta;
  }

  async function extractLyricsMetadata(file) {
    if (!file) return {};
    try {
      const content = await file.text();
      const ext = file.name.split('.').pop().toLowerCase();
      const fmt = {lrc:'lrc', ttml:'ttml', xml:'ttml', json:'json', lyricsfile:'lyricsfile'}[ext] || 'lrc';
      if (window.parseMetadata) {
        return window.parseMetadata(content, fmt);
      }
    } catch (e) {
      console.warn("Failed to parse lyrics metadata", e);
    }
    return {};
  }

  async function handleMetadataExtractionAudio() {
    const audioFile = typeof window.getLastAudioFile === 'function' ? window.getLastAudioFile() : null;
    if (!audioFile) {
      alert("No audio file is currently loaded.");
      return;
    }
    const extracted = await extractAudioMetadata(audioFile);
    applyExtractedMetadata(extracted, "audio file (" + audioFile.name + ")");
  }

  async function handleMetadataExtractionLyrics() {
    const lyricsFile = typeof window.getLastLyricsFile === 'function' ? window.getLastLyricsFile() : null;
    if (!lyricsFile) {
      alert("No lyrics/subtitle file is currently loaded.");
      return;
    }
    const extracted = await extractLyricsMetadata(lyricsFile);
    applyExtractedMetadata(extracted, "lyrics file (" + lyricsFile.name + ")");
  }

  function applyExtractedMetadata(extracted, source) {
    if (!extracted || (!extracted.title && !extracted.artist && !extracted.album)) {
      alert("Could not extract any metadata fields from the selected file.");
      return;
    }

    // Overwrite check
    const currentTitle = $('meta-title')?.value.trim() || "";
    const currentArtist = $('meta-artist')?.value.trim() || "";
    const currentAlbum = $('meta-album')?.value.trim() || "";

    if (currentTitle || currentArtist || currentAlbum) {
      if (!confirm("Are you sure you want to overwrite the current form metadata with the extracted data?")) {
        return;
      }
    }

    // Populate
    if (extracted.title && $('meta-title')) $('meta-title').value = extracted.title;
    if (extracted.artist && $('meta-artist')) $('meta-artist').value = extracted.artist;
    if (extracted.album && $('meta-album')) $('meta-album').value = extracted.album;
    if (extracted.language && $('meta-language')) $('meta-language').value = extracted.language;
    if (extracted.by && $('meta-by')) $('meta-by').value = extracted.by;
    if (extracted.author && $('meta-author')) $('meta-author').value = extracted.author;
    if (extracted.lyricist && $('meta-lyricist')) $('meta-lyricist').value = extracted.lyricist;
    if (extracted.offset !== undefined && $('meta-offset')) $('meta-offset').value = extracted.offset;

    // Apple TTML specific metadata
    if (extracted.itunesTiming && $('meta-itunes-timing')) {
      $('meta-itunes-timing').value = extracted.itunesTiming;
    }
    if (extracted.leadingSilence !== undefined && $('meta-leading-silence')) {
      $('meta-leading-silence').value = extracted.leadingSilence;
    }
    if (extracted.agents && $('meta-agents')) {
      const lines = extracted.agents.map(a => `${a.id}|${a.name || ''}`);
      $('meta-agents').value = lines.join('\n');
    }
    if (extracted.songwriters && $('meta-songwriters')) {
      const lines = Array.isArray(extracted.songwriters) ? extracted.songwriters : [];
      $('meta-songwriters').value = lines.join('\n');
    }

    // Toast feedback
    const toast = document.createElement('div');
    toast.textContent = "Extracted metadata from " + source + " ✓";
    toast.style.cssText = "position:fixed; bottom:20px; right:20px; background:#1a1a1d; color:#fff; border:1px solid #333; padding:10px 16px; border-radius:8px; font-size:13px; z-index:9999; box-shadow:0 4px 12px rgba(0,0,0,0.4);";
    document.body.appendChild(toast);
    setTimeout(()=>toast.remove(), 3000);
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.getElementById('tool-metadata-editor');
    if(btn) btn.addEventListener('click', (e)=>{ e.stopPropagation(); document.querySelectorAll('.dropdown-menu.open').forEach(m=>m.classList.remove('open')); openMetadataEditor(); });

    // Close handlers
    $('metadata-cancel')?.addEventListener('click', ()=>{ $('metadata-modal').style.display='none'; });
    $('metadata-close-top')?.addEventListener('click', ()=>{ $('metadata-modal').style.display='none'; });
    $('metadata-modal')?.addEventListener('click', (e)=>{ if(e.target.id==='metadata-modal') e.currentTarget.style.display='none'; });

    $('metadata-clear')?.addEventListener('click', ()=>{
      if(!confirm("Are you sure you want to clear all metadata?")) return;
      window.appMetadata = JSON.parse(JSON.stringify(defaultMetadata));
      saveAppMetadata(); populateForm();
    });

    $('metadata-save')?.addEventListener('click', ()=>{
      collectForm();
      $('metadata-modal').style.display='none';
      const toast = document.createElement('div');
      toast.textContent = "Metadata saved ✓";
      toast.style.cssText = "position:fixed; bottom:20px; right:20px; background:#1a1a1d; color:#fff; border:1px solid #333; padding:10px 16px; border-radius:8px; font-size:13px; z-index:9999; box-shadow:0 4px 12px rgba(0,0,0,0.4);";
      document.body.appendChild(toast); setTimeout(()=>toast.remove(), 2000);
    });

    // Extract buttons
    $('metadata-extract-audio')?.addEventListener('click', handleMetadataExtractionAudio);
    $('metadata-extract-lyrics')?.addEventListener('click', handleMetadataExtractionLyrics);

    // Tabs
    document.querySelectorAll('#metadata-modal .metadata-tabs .toggle-btn').forEach(tabBtn=>{
      tabBtn.addEventListener('click', ()=>{
        const target = tabBtn.dataset.tab;
        document.querySelectorAll('#metadata-modal .metadata-tabs .toggle-btn').forEach(b=>b.classList.remove('active'));
        tabBtn.classList.add('active');
        document.getElementById('metadata-tab-common').style.display = target==='common' ? 'block' : 'none';
        document.getElementById('metadata-tab-lrc').style.display = target==='lrc' ? 'block' : 'none';
        document.getElementById('metadata-tab-ttml').style.display = target==='ttml' ? 'block' : 'none';
      });
    });
  });

  // Hook into processImportedContent if exists, to auto-merge metadata from file
  const origProcess = window.processImportedContent;
  if(typeof origProcess === 'function'){
    window.processImportedContent = function(content, fmt, fileObj){
      const result = origProcess(content, fmt, fileObj);
      try{
        if(window.parseMetadata){
          const meta = window.parseMetadata(content, fmt);
          if(meta){
            let changed=false;
            if(meta.title){ window.appMetadata.title = meta.title; changed=true; }
            if(meta.artist){ window.appMetadata.artist = meta.artist; changed=true; }
            if(meta.album){ window.appMetadata.album = meta.album; changed=true; }
            if(meta.language){ window.appMetadata.language = meta.language; changed=true; }
            if(meta.by){ window.appMetadata.by = meta.by; changed=true; }
            if(meta.author){ window.appMetadata.author = meta.author; changed=true; }
            if(meta.offset!==undefined){ window.appMetadata.offset = meta.offset; changed=true; }
            if(meta.agents && meta.agents.length){ window.appMetadata.agents = meta.agents; changed=true; }
            if(meta.songwriters && meta.songwriters.length){ window.appMetadata.songwriters = meta.songwriters; window.appMetadata.appleSongwriters = meta.songwriters; changed=true; }
            if(meta.itunesTiming){ window.appMetadata.itunesTiming = meta.itunesTiming; window.appMetadata.appleTiming = meta.itunesTiming; changed=true; }
            if(changed) saveAppMetadata();
          }
        }
      }catch(e){ console.warn(e); }
      return result;
    };
  }
})();
