// ── Format Parsers & Exporters ──

function detectFormat(filename, content) {
  const t = content.trim();
  if (t.startsWith('WEBVTT')) return 'vtt';
  if (t.includes('<tt') && t.includes('xmlns="http://www.w3.org/ns/ttml"')) return 'ttml';
  if (t.includes('<transcript')) return 'srv1';
  if (t.includes('<timedtext') && t.includes('format="3"')) return 'srv3';
  if (t.includes('<timedtext')) return 'srv2';
  if (t.includes('version: "1.0"') && t.includes('lines:')) return 'lyricsfile';
  if (filename.endsWith('.srt')) return 'srt';
  if (filename.endsWith('.vtt')) return 'vtt';
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.ttml')) return 'ttml';
  if (filename.endsWith('.lyricsfile')) return 'lyricsfile';
  if (filename.endsWith('.srv1')) return 'srv1';
  if (filename.endsWith('.srv2')) return 'srv2';
  if (filename.endsWith('.srv3')) return 'srv3';
  if (filename.endsWith('.xml')) {
    if (t.includes('<transcript')) return 'srv1';
    return 'srv2'; // default xml to srv2
  }
  if (filename.endsWith('.txt')) return 'txt';
  if (filename.endsWith('.lrc')) return 'lrc';
  if (/^\[\d{2}:\d{2}\.\d{2}\]/.test(t)) return 'lrc';
  return 'srt';
}

function timeToMs(str) {
  if (!str) return 0;
  str = str.trim().replace(',', '.');
  const parts = str.split(':');
  let ms = 0;
  if (parts.length === 3) ms = (parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseFloat(parts[2])) * 1000;
  else if (parts.length === 2) ms = (parseInt(parts[0])*60 + parseFloat(parts[1])) * 1000;
  else ms = parseFloat(str) * 1000 || 0;
  return Math.round(ms);
}

function msToLrc(ms) {
  ms = Math.max(0, Math.round(ms));
  const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000), cs = Math.floor((ms%1000)/10);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function msToSrt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000), s = Math.floor((ms%60000)/1000), ml = ms%1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ml).padStart(3,'0')}`;
}

function msToVtt(ms) { return msToSrt(ms).replace(',','.'); }

function parseLRC(content) {
  const lines = content.split(/\r?\n/), cues = [];
  const re = /^(\s*\[\d{1,3}:\d{2}(?:\.\d{2,3})?\]\s*)+(.*)/;
  let id = 1, wid = 1;
  lines.forEach((line, li) => {
    const m = line.match(re);
    if (!m) return;
    const ts = m[1], raw = m[2];
    const tms = []; let tm;
    const tre = /\[(\d{1,3}:\d{2}(?:\.\d{2,3})?)\]/g;
    while ((tm = tre.exec(ts))) tms.push(timeToMs(tm[1]));
    let words = [];
    if (raw.includes('<') && raw.includes('>')) {
      const wre = /<(\d{1,3}:\d{2}(?:\.\d{2,3})?)>/g;
      const wordMatches = [...raw.matchAll(wre)];
      
      // Handle text before the first tag
      if (wordMatches.length > 0 && wordMatches[0].index > 0) {
        const preText = raw.substring(0, wordMatches[0].index).trim();
        if (preText) {
          words.push({ id: wid++, text: preText, startMs: tms[0] || 0, endMs: timeToMs(wordMatches[0][1]) });
        }
      }

      wordMatches.forEach((m, i) => {
        const startMs = timeToMs(m[1]);
        const startIdx = m.index + m[0].length;
        const endIdx = (i < wordMatches.length - 1) ? wordMatches[i+1].index : raw.length;
        const wordText = raw.substring(startIdx, endIdx); // Don't trim yet to preserve spaces
        
        if (wordText !== "") {
          words.push({
            id: wid++,
            text: wordText, // Keep spaces to maintain LRC structure
            startMs: startMs,
            endMs: 0
          });
        }
      });
      
      if (words.length) {
        for (let i = 0; i < words.length - 1; i++) {
          if (words[i].endMs <= words[i].startMs) words[i].endMs = words[i+1].startMs;
        }
      }
    }
    
    // Clean up line text for display: remove tags and collapse extra spaces
    let cleanText = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    tms.forEach(start => {
      cues.push({ id: id++, startMs: start, endMs: start + 3000, text: cleanText, words: words.length ? words.map(w => ({...w})) : null });
    });
  });
  
  cues.sort((a,b) => a.startMs - b.startMs);
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].endMs = cues[i+1].startMs;
  }
  
  if (cues.length > 0) {
    const last = cues[cues.length - 1];
    if (last.endMs <= last.startMs) {
      last.endMs = last.startMs + 3000;
    }
  }

  // Ensure line duration covers all words and last words end at line end
  cues.forEach((c, idx) => {
    if (c.words && c.words.length) {
      const lastW = c.words[c.words.length-1];
      
      if (idx === cues.length - 1) {
        // Very last line in the file: give the last word 3s from ITS start time if missing
        if (lastW.endMs <= lastW.startMs) {
          lastW.endMs = lastW.startMs + 3000;
        }
        // Ensure the line covers this extended word
        c.endMs = Math.max(c.endMs, lastW.endMs);
        lastW.endMs = c.endMs; // Seal perfectly to line end
      } else {
        // Other lines: sync last word to the line boundary
        if (lastW.endMs <= lastW.startMs) {
          lastW.endMs = c.endMs;
        }
        // If line is cut too short by next line, extend it to at least cover the last word
        if (c.endMs <= lastW.startMs) {
          c.endMs = lastW.startMs + 500;
          lastW.endMs = c.endMs;
        }
        // Always ensure line covers all its words
        if (lastW.endMs > c.endMs) c.endMs = lastW.endMs;
      }
    }
  });

  return cues;
}

function parseSRT(content) {
  const chunks = content.trim().replace(/\r\n/g,'\n').split('\n\n'), cues = [];
  let id = 1;
  chunks.forEach(chunk => {
    const ls = chunk.split('\n');
    let ti = 0;
    if (ls[0].match(/^\d+$/)) ti = 1;
    if (!ls[ti]) return;
    const times = ls[ti].split('-->');
    if (times.length !== 2) return;
    cues.push({ id: id++, startMs: timeToMs(times[0]), endMs: timeToMs(times[1]), text: ls.slice(ti+1).join('\n').trim(), words: null });
  });
  return cues;
}

function parseVTT(content) {
  const ls = content.trim().replace(/\r\n/g,'\n').split('\n'), cues = [];
  let cur = null, buf = [], id = 1, wid = 1;
  let i = ls[0].startsWith('WEBVTT') ? 1 : 0;
  
  for (; i < ls.length; i++) {
    const l = ls[i].trim();
    if (l.includes('-->')) {
      if (cur) {
        processCue(cur, buf.join('\n'));
        cues.push(cur);
        buf = [];
      }
      const t = l.split('-->');
      cur = { id: id++, startMs: timeToMs(t[0]), endMs: timeToMs(t[1]), text: '', words: null };
    } else if (l === '' && cur) {
      processCue(cur, buf.join('\n'));
      cues.push(cur);
      cur = null;
      buf = [];
    } else if (cur) {
      buf.push(l);
    }
  }
  if (cur) {
    processCue(cur, buf.join('\n'));
    cues.push(cur);
  }

  function processCue(cue, rawText) {
    const wre = /<(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)>([^<]*)/g;
    if (rawText.includes('<') && rawText.includes('>')) {
      cue.text = rawText.replace(/<[^>]+>/g, '').trim();
      let wm, words = [];
      while ((wm = wre.exec(rawText))) {
        if (wm[2].trim()) words.push({ id: wid++, text: wm[2].trim(), startMs: timeToMs(wm[1]), endMs: 0 });
      }
      if (words.length) {
        for (let j = 0; j < words.length - 1; j++) words[j].endMs = words[j+1].startMs;
        words[words.length-1].endMs = cue.endMs;
        cue.words = words;
      }
    } else {
      cue.text = rawText.trim();
    }
  }
  
  return cues;
}

function parseTXT(content) {
  // Normalize line endings and split
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  
  // Remove the very last empty line if the file ended with a newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.map((l, i) => ({
    id: i+1, startMs: i*2000, endMs: (i+1)*2000, text: l.trim(), words: null
  }));
}

function parseJSON_(content) {
  try {
    const p = JSON.parse(content);
    if (p.events) {
      return p.events.filter(e => e.segs || e.utf8).map((e, i) => {
        const s = Math.round(e.tStartMs||0), d = Math.round(e.dDurationMs||2000), words = [];
        let text = '';
        if (e.segs) e.segs.forEach((seg,j) => {
          if (seg.utf8 && seg.utf8.trim()) words.push({ id: j+1, text: seg.utf8.trim(), startMs: Math.round(s+(seg.tOffsetMs||0)), endMs: 0 });
          text += seg.utf8||'';
        }); else text = e.utf8||'';
        for (let w=0;w<words.length-1;w++) words[w].endMs = words[w+1].startMs;
        if (words.length) words[words.length-1].endMs = s+d;
        return { id: i+1, startMs: s, endMs: s+d, text: text.trim(), words: words.length?words:null };
      });
    }
    const arr = Array.isArray(p) ? p : (p.cues||[]);
    return arr.map((c,i) => ({ 
      id: i+1, 
      startMs: Math.round(c.start !== undefined ? c.start : (c.startMs || 0)), 
      endMs: Math.round(c.end !== undefined ? c.end : (c.endMs || 0)), 
      text: c.text||'', 
      words: c.words || null 
    }));
  } catch(e) { return []; }
}

function parseMetadata(content, format) {
  const metadata = { durationMs: 0 };
  if (format === 'lyricsfile') {
    const match = content.match(/duration_ms:\s*(\d+)/);
    if (match) metadata.durationMs = parseInt(match[1]);
  }
  return metadata;
}

function parseContent(content, format) {
  let cues = [];
  switch(format) {
    case 'lrc': cues = parseLRC(content); break;
    case 'srt': cues = parseSRT(content); break;
    case 'vtt': cues = parseVTT(content); break;
    case 'json': cues = parseJSON_(content); break;
    case 'lyricsfile': cues = parseLyricsFile(content); break;
    case 'ttml': cues = parseTTML(content); break;
    case 'srv1': cues = parseSRV1(content); break;
    case 'srv2': cues = parseSRV2(content); break;
    case 'srv3': cues = parseSRV23(content); break;
    case 'txt': cues = parseTXT(content); break;
    default: cues = parseSRT(content);
  }
  // Safety pass: ensure the very last cue has a duration if missing
  if (cues.length > 0) {
    const last = cues[cues.length - 1];
    if (last.endMs <= last.startMs) last.endMs = last.startMs + 3000;
    
    // Ensure all other cues have at least some minimal duration to prevent UI bugs
    cues.forEach(c => {
      if (c.endMs <= c.startMs) c.endMs = c.startMs + 100;
    });
  }
  return cues;
}

function parseTTML(content) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(content, "text/xml");
  const ps = xml.getElementsByTagName('p');
  const cues = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const startMs = timeToMs(p.getAttribute('begin'));
    const endMs = timeToMs(p.getAttribute('end')) || (startMs + timeToMs(p.getAttribute('dur')));
    const words = [];
    const spans = p.getElementsByTagName('span');
    let text = p.textContent.trim();
    if (spans.length > 0) {
      for (let j = 0; j < spans.length; j++) {
        const s = spans[j];
        words.push({
          id: j + 1,
          text: s.textContent.trim(),
          startMs: timeToMs(s.getAttribute('begin')) || startMs,
          endMs: timeToMs(s.getAttribute('end')) || endMs
        });
      }
    }
    cues.push({ id: i + 1, startMs, endMs, text, words: words.length ? words : null });
  }
  return cues;
}

function parseSRV1(content) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(content, "text/xml");
  const ts = xml.getElementsByTagName('text');
  const cues = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const startMs = Math.round(parseFloat(t.getAttribute('start')) * 1000);
    const durMs = Math.round(parseFloat(t.getAttribute('dur')) * 1000);
    cues.push({ id: i + 1, startMs, endMs: startMs + durMs, text: t.textContent.trim(), words: null });
  }
  return cues;
}

function parseSRV2(content) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(content, "text/xml");
  const texts = xml.getElementsByTagName('text');
  
  const ps = xml.getElementsByTagName('p');
  if (ps.length > 0 && texts.length === 0) {
    return parseSRV23(content); // Fallback to old behavior
  }

  const cues = [];
  let currentWords = [];
  
  function flushLine() {
    if (currentWords.length > 0) {
      const lineText = currentWords.map(w => w.text).join('').trim();
      cues.push({
        id: cues.length + 1,
        startMs: currentWords[0].startMs,
        endMs: currentWords[currentWords.length - 1].endMs,
        text: lineText,
        words: currentWords.map((w, widx) => ({
          id: widx + 1,
          text: w.text.trim(),
          startMs: w.startMs,
          endMs: w.endMs
        }))
      });
      currentWords = [];
    }
  }

  for (let i = 0; i < texts.length; i++) {
    const node = texts[i];
    const textContent = node.textContent.replace(/\r/g, '');
    const tAttr = node.getAttribute('t');
    const dAttr = node.getAttribute('d');
    
    const startMs = tAttr ? parseInt(tAttr) : 0;
    const durMs = dAttr ? parseInt(dAttr) : 0;
    
    let endMs = startMs + durMs;
    if (i + 1 < texts.length) {
       const nextT = texts[i+1].getAttribute('t');
       if (nextT) endMs = parseInt(nextT);
    }
    
    if (textContent === '\n') {
      flushLine();
      continue;
    }
    
    if (textContent.includes('\n')) {
      const parts = textContent.split('\n');
      for (let j = 0; j < parts.length; j++) {
         if (parts[j] !== '') {
            currentWords.push({
               text: parts[j],
               startMs: startMs,
               endMs: endMs
            });
         }
         if (j < parts.length - 1) {
            flushLine();
         }
      }
      continue;
    }

    currentWords.push({
      text: textContent,
      startMs: startMs,
      endMs: endMs
    });
  }
  
  flushLine();

  return cues;
}

function parseSRV23(content) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(content, "text/xml");
  const ps = xml.getElementsByTagName('p');
  const cues = [];
  let wid = 1;

  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const tAttr = p.getAttribute('t');
    const dAttr = p.getAttribute('d');
    const append = p.getAttribute('append') === '1';
    
    const startMs = tAttr ? Math.round(parseFloat(tAttr)) : 0;
    const durMs = dAttr ? Math.round(parseFloat(dAttr)) : 0;
    const endMs = startMs + durMs;
    const pText = p.textContent;

    if (append && cues.length > 0) {
      const last = cues[cues.length - 1];
      last.endMs = Math.max(last.endMs, endMs);
      last.text += pText;
      
      if (!last.words) {
        // Convert previous plain text to a word if it wasn't already
        last.words = [{ id: wid++, text: last.text.replace(pText, '').trim(), startMs: last.startMs, endMs: startMs }];
      }
      
      last.words.push({
        id: wid++,
        text: pText.trim(),
        startMs: startMs,
        endMs: endMs
      });
      
      // Clean up the main text after merging
      last.text = last.words.map(w => w.text).join(' ');
    } else {
      const words = [];
      const ss = p.getElementsByTagName('s'); // Word tags in some SRV3
      if (ss.length > 0) {
        for (let j = 0; j < ss.length; j++) {
          const s = ss[j];
          const tOffset = Math.round(parseFloat(s.getAttribute('t')) || 0);
          words.push({
            id: wid++,
            text: s.textContent.trim(),
            startMs: startMs + tOffset,
            endMs: 0
          });
        }
        for (let j = 0; j < words.length - 1; j++) words[j].endMs = words[j+1].startMs;
        if (words.length) words[words.length-1].endMs = endMs;
      } else {
        // Standard P tag, treat as one word for karaoke consistency if needed
        // but we'll only add it as a word if it's potentially part of a future append
        words.push({ id: wid++, text: pText.trim(), startMs, endMs });
      }
      
      cues.push({ 
        id: cues.length + 1, 
        startMs, 
        endMs, 
        text: pText.trim(), 
        words: words.length ? words : null 
      });
    }
  }
  return cues;
}

function parseLyricsFile(content) {
  const cues = [];
  
  const linesStart = content.indexOf('lines:');
  if (linesStart === -1) return [];
  
  let linesPart = content.substring(linesStart + 6);
  const plainStart = linesPart.indexOf('plain:');
  if (plainStart !== -1) linesPart = linesPart.substring(0, plainStart);

  // Split only by top-level line entries (indented by exactly 2 spaces)
  // We use a lookahead to keep the text in the block
  const blocks = linesPart.split(/\n(?=  - text:)/).filter(b => b.trim());

  blocks.forEach((block, idx) => {
    // Extract line text
    const textMatch = block.match(/  - text:\s*(.*)/);
    let text = textMatch ? textMatch[1].trim() : "";
    if (text.startsWith('"') && text.endsWith('"')) {
      text = text.substring(1, text.length - 1).replace(/\\"/g, '"');
    }

    // Line-level timestamps (usually indented less than words, e.g. 4 spaces)
    const lineStartMatch = block.match(/\n\s{2,6}start_ms:\s*(\d+)/);
    const lineEndMatch = block.match(/\n\s{2,6}end_ms:\s*(\d+)/);
    const startMs = lineStartMatch ? parseInt(lineStartMatch[1]) : 0;
    let endMs = lineEndMatch ? parseInt(lineEndMatch[1]) : 0;
    
    // Estimation logic (always 3s fallback)
    if (endMs <= startMs) {
      endMs = startMs + 3000;
    }

    const words = [];
    const wordsMatch = block.match(/words:\s*([\s\S]*?)(?:\n\s{2,6}(?:start|end)_ms:|$)/);
    
    if (wordsMatch && !wordsMatch[1].includes('[]')) {
      const wordEntries = wordsMatch[1].split(/\n(?=\s+-\s+text:)/).filter(w => w.trim());
      wordEntries.forEach((wBlock, wIdx) => {
        const wLines = wBlock.split('\n');
        const wTextMatch = wLines[0].match(/-\s+text:\s*(.*)/);
        let wTextRaw = wTextMatch ? wTextMatch[1] : ""; 
        let wText = wTextRaw.trim();
        
        if (wText.startsWith('"') && wText.endsWith('"')) {
          const insideQuotes = wTextRaw.match(/"(.*)"/);
          wText = insideQuotes ? insideQuotes[1].replace(/\\"/g, '"') : wText.substring(1, wText.length - 1).replace(/\\"/g, '"');
        }
        
        const wStartMatch = wBlock.match(/start_ms:\s*(\d+)/);
        const wEndMatch = wBlock.match(/end_ms:\s*(\d+)/);
        const wStart = wStartMatch ? parseInt(wStartMatch[1]) : startMs;
        const wEnd = wEndMatch ? parseInt(wEndMatch[1]) : 0;
        
        words.push({
          id: (idx * 1000) + wIdx + 1,
          text: wText,
          startMs: wStart,
          endMs: wEnd
        });
      });
      // Fill gaps for words missing end_ms
      for (let j = 0; j < words.length - 1; j++) {
        if (words[j].endMs <= words[j].startMs) words[j].endMs = words[j+1].startMs;
      }
      if (words.length && words[words.length-1].endMs <= words[words.length-1].startMs) {
        words[words.length-1].endMs = endMs;
      }
    }

    cues.push({ id: idx + 1, text, startMs, endMs, words: words.length ? words : null });
  });

  // Ensure line duration covers all words
  cues.forEach(c => {
    if (c.words && c.words.length) {
      const lastW = c.words[c.words.length-1];
      if (lastW.endMs > c.endMs) c.endMs = lastW.endMs;
      c.words[c.words.length-1].endMs = Math.max(lastW.endMs, c.endMs);
    }
  });

  return cues;
}

function autoFillWords(cues) {
  cues.forEach(c => {
    if (!c.words || !c.words.length) {
      const ws = c.text.trim().split(/\s+/);
      if (!ws.length || !ws[0]) return;
      const dur = c.endMs - c.startMs, perW = dur / ws.length;
      c.words = ws.map((w, i) => ({ id: i+1, text: w, startMs: Math.round(c.startMs + perW*i), endMs: Math.round(c.startMs + perW*(i+1)) }));
    }
    // ensure full coverage
    if (c.words.length) {
      c.words[0].startMs = c.startMs;
      for (let i=0;i<c.words.length-1;i++) c.words[i].endMs = c.words[i+1].startMs;
      c.words[c.words.length-1].endMs = c.endMs;
    }
  });
}

function escapeXML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stringifyTTML(cues, karaoke, durationMs) {
  let head = `  <head>\n    <metadata>\n      <ttm:title>Lyrics</ttm:title>\n    </metadata>\n    <styling>\n      <style xml:id="s1" tts:textAlign="center" tts:fontFamily="Arial" tts:fontSize="100%"/>\n    </styling>\n    <layout>\n      <region xml:id="bottom" tts:displayAlign="after" tts:extent="80% 40%" tts:origin="10% 50%"/>\n    </layout>\n  </head>`;
  let bodyLines = [];
  
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    let content = (cue.text || "").replace(/\n/g, '<br/>');
    if (karaoke && cue.words && cue.words.length > 0) {
      const spans = cue.words.map((w, i, arr) => {
        let wStart = w.startMs !== undefined ? w.startMs : cue.startMs;
        let wEnd = w.endMs !== undefined ? w.endMs : (wStart + 300);
        if (i < arr.length - 1 && arr[i+1].startMs) wEnd = Math.min(wEnd, arr[i+1].startMs);
        return `        <span begin="${msToVtt(wStart)}" end="${msToVtt(wEnd)}">${escapeXML(w.text)}</span>`;
      });
      content = '\n' + spans.join('\n') + '\n      ';
    } else {
      content = escapeXML(content);
    }
    bodyLines.push(`      <p begin="${msToVtt(cue.startMs)}" end="${msToVtt(cue.endMs)}" region="bottom" style="s1">${content}</p>`);
    
    // Gap filling (blank line support) - only between cues
    const nextStart = (i < cues.length - 1) ? cues[i + 1].startMs : null;
    if (nextStart && cue.endMs < nextStart - 10) {
      bodyLines.push(`      <p begin="${msToVtt(cue.endMs)}" end="${msToVtt(nextStart)}" region="bottom" style="s1"></p>`);
    }
  }

  const body = bodyLines.join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="media" lang="en">\n${head}\n  <body>\n    <div>\n${body}\n    </div>\n  </body>\n</tt>`;
}

function stringifySRV1(cues) {
  let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<transcript>\n`;
  for(const cue of cues) {
    const text = escapeXML(cue.text).replace(/\n/g, '&#10;');
    xml += `  <text start="${(cue.startMs/1000).toFixed(3)}" dur="${((cue.endMs-cue.startMs)/1000).toFixed(3)}">${text}</text>\n`;
  }
  return xml + `</transcript>`;
}

function stringifySRV2(cues) {
  let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="2">\n  <body>\n`;
  for(const cue of cues) {
    const text = escapeXML(cue.text).replace(/\n/g, '&#10;');
    xml += `    <p t="${cue.startMs}" d="${cue.endMs-cue.startMs}">${text}</p>\n`;
  }
  return xml + `  </body>\n</timedtext>`;
}

function stringifySRV3Karaoke(cues) {
  let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3">\n  <body>\n`;
  for (const cue of cues) {
     if (cue.words && cue.words.length > 0) {
         for (let i = 0; i < cue.words.length; i++) {
             const w = cue.words[i];
             const startMs = w.startMs !== undefined ? w.startMs : cue.startMs;
             const endMs = w.endMs !== undefined ? w.endMs : cue.endMs;
             const durMs = Math.max(0, endMs - startMs);
             let content = escapeXML(w.text).trim();
             
             if (i > 0) {
                 xml += `    <p t="${startMs}" d="${durMs}" append="1"> ${content}</p>\n`;
             } else {
                 xml += `    <p t="${startMs}" d="${durMs}">${content}</p>\n`;
             }
         }
     } else {
         const durMs = cue.endMs - cue.startMs;
         xml += `    <p t="${cue.startMs}" d="${durMs}">${escapeXML(cue.text).trim()}</p>\n`;
     }
  }
  xml += `  </body>\n</timedtext>`;
  return xml;
}

function stringifySRV3(cues) {
  let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3">\n  <body>\n`;
  for(const cue of cues) {
    const durMs = cue.endMs - cue.startMs;
    let content = '';
    
    if (cue.words && cue.words.length > 0) {
       content = cue.words.map((w, i) => {
           const offset = (w.startMs !== undefined ? (w.startMs - cue.startMs) : 0);
           const space = i > 0 ? ' ' : '';
           return `${space}<s t="${offset}">${escapeXML(w.text.trim())}</s>`;
       }).join('');
    } else {
       content = escapeXML(cue.text);
    }
    
    xml += `    <p t="${cue.startMs}" d="${durMs}">${content}</p>\n`;
  }
  xml += `  </body>\n</timedtext>`;
  return xml;
}

function stringifyJSON3(cues) {
  const events = cues.map(cue => {
      let segs;
      if (cue.words && cue.words.length) {
          segs = cue.words.map((w, i) => {
              let wText = w.text;
              if (i < cue.words.length - 1 && !wText.endsWith(' ')) wText += ' ';
              return { utf8: wText, tOffsetMs: Math.max(0, w.startMs - cue.startMs) };
          });
      } else {
          segs = [{ utf8: cue.text, tOffsetMs: 0 }];
      }
      return { tStartMs: cue.startMs, dDurationMs: cue.endMs - cue.startMs, segs };
  });
  return JSON.stringify({ events }, null, 2);
}

function stringifyTXT(cues) {
  let result = '';
  const STANZA_BREAK_THRESHOLD = 2000;

  for (let i = 0; i < cues.length; i++) {
    const text = (cues[i].text || "").trim();
    result += text + '\n';
    
    if (i < cues.length - 1) {
      const currentEnd = cues[i].endMs;
      const nextStart = cues[i + 1].startMs;
      const gap = nextStart - currentEnd;

      if (gap >= STANZA_BREAK_THRESHOLD) {
        result += '\n';
      }
    }
  }
  return result.trim();
}

function stringifyLRC(cues, enhanced, durationMs) {
  let output = [];
  if (durationMs) {
    output.push(`[length:${msToLrc(durationMs)}]`);
  }

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    let line = `[${msToLrc(c.startMs)}]`;
    if (enhanced && c.words && c.words.length > 0) {
      const hasVisibleText = c.words.some(w => (w.text || "").trim().length > 0);
      if (hasVisibleText) {
        line += " " + c.words.map(w => `<${msToLrc(w.startMs)}>${w.text}`).join(' ');
      } else if (c.text && c.text.trim()) {
        line += " " + c.text;
      }
    } else if (c.text && c.text.trim()) {
      line += " " + c.text;
    }
    output.push(line);

    // Add a blank line to clear the screen if there's a gap to the next cue or at the end
    const nextStart = (i < cues.length - 1) ? cues[i + 1].startMs : (durationMs || (c.endMs + 1000));
    if (c.endMs < nextStart - 10) { // Small threshold to avoid redundant clears
      output.push(`[${msToLrc(c.endMs)}]`);
    }
  }
  return output.join('\n');
}

function stringifySRT(cues) {
  return cues.map((c, i) => {
    return `${i + 1}\n${msToSrt(c.startMs)} --> ${msToSrt(c.endMs)}\n${c.text || ""}\n`;
  }).join('\n') + '\n'; // Ensure trailing newline
}

function stringifyVTT(cues, karaoke) {
  let header = 'WEBVTT\n\n';
  return header + cues.map(c => {
    let text = c.text || "";
    if (karaoke && c.words && c.words.length > 0) {
       text = c.words.map(w => `<${msToVtt(w.startMs)}>${w.text}`).join(' ');
    }
    return `${msToVtt(c.startMs)} --> ${msToVtt(c.endMs)}\n${text}\n`;
  }).join('\n') + '\n'; // Ensure trailing newline
}

// ── Exporters ──
function exportAs(cues, format, durationMs) {
  // Deep copy all cues
  const exportCues = JSON.parse(JSON.stringify(cues));

  // Clean text: collapse all whitespace
  exportCues.forEach(c => {
    c.text = (c.text || "").replace(/\s+/g, ' ').trim();
    if (c.words) {
      c.words.forEach(w => {
        w.text = (w.text || "").trim();
      });
    }
  });

  switch(format) {
    case 'lrc': return stringifyLRC(exportCues, false, durationMs);
    case 'lrc_enhanced': return stringifyLRC(exportCues, true, durationMs);
    case 'srt': return stringifySRT(exportCues);
    case 'vtt': return stringifyVTT(exportCues, false);
    case 'vtt_karaoke': return stringifyVTT(exportCues, true);
    case 'ttml': return stringifyTTML(exportCues, false, durationMs);
    case 'ttml_karaoke': return stringifyTTML(exportCues, true, durationMs);
    case 'srv1': return stringifySRV1(exportCues);
    case 'srv2': return stringifySRV2(exportCues);
    case 'srv3': return stringifySRV3(exportCues);
    case 'srv3_karaoke': return stringifySRV3Karaoke(exportCues);
    case 'json': return JSON.stringify({ 
      metadata: { duration_ms: durationMs },
      cues: exportCues.map(c => ({ startMs: c.startMs, endMs: c.endMs, text: c.text, words: c.words })) 
    }, null, 2);
    case 'json3': return stringifyJSON3(exportCues);
    case 'lyricsfile': return stringifyLyricsFile(exportCues, durationMs);
    case 'txt': return stringifyTXT(exportCues);
    default: return '';
  }
}

function stringifyLyricsFile(cues, durationMs) {
  let yaml = `version: "1.0"\nmetadata:\n  title: ""\n  artist: ""\n  instrumental: false\n  album: ""\n  duration_ms: ${Math.round(durationMs || 0)}\nlines:\n`;
  cues.forEach(c => {
    const cleanText = c.text.replace(/\s+/g, ' ').trim();
    yaml += `  - text: "${cleanText.replace(/"/g, '\\"')}"\n`;
    yaml += `    words:\n`;
    if (c.words && c.words.length) {
      c.words.forEach((w, i) => {
        let txt = w.text;
        if (i < c.words.length - 1 && !txt.endsWith(' ')) txt += ' ';
        yaml += `      - text: "${txt.replace(/"/g, '\\"')}"\n`;
        yaml += `        start_ms: ${Math.round(w.startMs)}\n`;
      });
    } else {
      yaml += `      []\n`;
    }
    yaml += `    start_ms: ${Math.round(c.startMs)}\n`;
    yaml += `    end_ms: ${Math.round(c.endMs)}\n`;
  });
  yaml += `plain: |-\n`;
  cues.forEach(c => {
    const cleanText = c.text.replace(/\s+/g, ' ').trim();
    yaml += `    ${cleanText}\n`;
  });
  return yaml;
}

function downloadFile(content, filename) {
  const b = new Blob([content], {type:'text/plain'}), u = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = u; a.download = filename; a.click();
  URL.revokeObjectURL(u);
}
