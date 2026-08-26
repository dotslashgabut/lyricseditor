// ── Format Parsers & Exporters ──

function detectFormat(filename, content) {
  const t = content.trim();
  if (t.startsWith('WEBVTT')) return 'vtt';
  if (t.includes('<tt') && t.includes('xmlns="http://www.w3.org/ns/ttml"')) return 'ttml';
  if (t.includes('<transcript')) return 'srv1';
  if (t.includes('<timedtext') && t.includes('format="3"')) return 'srv3';
  if (t.includes('<timedtext')) return 'srv2';
  if ((t.includes('version:') || t.includes('lyricsfile')) && t.includes('lines:')) return 'lyricsfile';
  if (filename.endsWith('.srt')) return 'srt';
  if (filename.endsWith('.vtt')) return 'vtt';
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.ttml')) return 'ttml';
  if (filename.endsWith('.lyricsfile') || filename.endsWith('.lyricsfile.yaml') || filename.endsWith('.lyricsfile.yml') || ((filename.endsWith('.yaml') || filename.endsWith('.yml')) && t.includes('lines:'))) return 'lyricsfile';
  if (filename.endsWith('.srv1')) return 'srv1';
  if (filename.endsWith('.srv2')) return 'srv2';
  if (filename.endsWith('.srv3')) return 'srv3';
  if (filename.endsWith('.xml')) {
    if (t.includes('<transcript')) return 'srv1';
    return 'srv2'; // default xml to srv2
  }
  if (filename.endsWith('.txt')) {
    if (t.includes('\t') && /^\d+\.\d+/.test(t)) return 'audacity';
    return 'txt';
  }
  if (filename.endsWith('.lrc')) return 'lrc';
  if (/^\[\d{2}:\d{2}\.\d{2}\]/.test(t)) return 'lrc';
  if (t.includes('\t') && /^\d+\.\d+/.test(t)) return 'audacity';
  if (t.includes('lines:') && (t.includes('start_ms') || t.includes('words:'))) return 'lyricsfile';
  return 'srt';
}

function detectSegments(content, format) {
    if (format === 'vtt') {
        // Split by WEBVTT at the start of a line, but ignore the first empty one
        const parts = content.split(/^(?=WEBVTT)/m);
        return parts.filter(p => p.trim()).map(p => p.trim());
    }
    if (format === 'srt') {
        const blocks = content.trim().replace(/\r\n/g, '\n').split(/\n\n+/);
        if (blocks.length <= 1) return [content];

        const segments = [];
        let currentSegment = [];
        let lastId = -1;
        
        blocks.forEach(block => {
            const idMatch = block.trim().match(/^(\d+)\n/);
            if (idMatch) {
                const id = parseInt(idMatch[1]);
                // Only split if ID strictly decreases (restarts)
                if (id < lastId && currentSegment.length > 0) {
                    segments.push(currentSegment.join('\n\n'));
                    currentSegment = [];
                }
                lastId = id;
            }
            currentSegment.push(block);
        });
        if (currentSegment.length > 0) segments.push(currentSegment.join('\n\n'));
        return segments;
    }
    if (format === 'audacity') {
        const lines = content.trim().split(/\r?\n/);
        const segments = [];
        let currentSegment = [];
        let lastStart = -1;
        lines.forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const start = parseFloat(parts[0]);
                // If timestamp restarts at 0 or is much earlier than last, it's a new segment
                if (start < lastStart - 1 && currentSegment.length > 0) {
                    segments.push(currentSegment.join('\n'));
                    currentSegment = [];
                }
                lastStart = start;
            }
            currentSegment.push(line);
        });
        if (currentSegment.length > 0) segments.push(currentSegment.join('\n'));
        return segments;
    }
    return [content];
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
  const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000), ml = ms%1000;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ml).padStart(3,'0')}`;
}

function msToSrt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000), s = Math.floor((ms%60000)/1000), ml = ms%1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ml).padStart(3,'0')}`;
}

function msToVtt(ms) { return msToSrt(ms).replace(',','.'); }

function detectSongPartHeader(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Bracketed match: [Verse], [Bridge], [Chorus 1], [Verse: John], etc.
  const bracketMatch = trimmed.match(/^\[([a-zA-Z0-9\s\-_:,'\.\(\)]+)\]$/);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    // Exclude timestamp tags like [01:23.45] or metadata tags like [ti:Title]
    if (/^\d{1,3}:\d{2}/.test(inner)) return null;
    if (/^(ti|ar|al|by|au|la|offset|re|length):/i.test(inner)) return null;
    return inner;
  }

  // Colon match: Verse 1:, Chorus:, Bridge:, Intro:, Outro:, Pre-Chorus:, etc.
  const colonMatch = trimmed.match(/^(Verse(?:\s+\d+)?|Chorus(?:\s+\d+)?|Bridge(?:\s+\d+)?|Intro|Outro|Pre-Chorus|Post-Chorus|Hook|Solo|Interlude|Instrumental|Refrain|Break)\s*:$/i);
  if (colonMatch) {
    return colonMatch[1].trim();
  }

  return null;
}

function parseLRC(content) {
  const lines = content.split(/\r?\n/), cues = [];
  const re = /^(\s*\[\d{1,3}:\d{2}(?:\.\d{2,3})?\]\s*)+(.*)/;
  let id = 1, wid = 1;
  let currentSongPart = null;

  lines.forEach((line, li) => {
    let ts = '';
    let raw = line;
    let tms = [];

    const m = line.match(re);
    if (m) {
      ts = m[1];
      raw = m[2];
      const tre = /\[(\d{1,3}:\d{2}(?:\.\d{2,3})?)\]/g;
      let tm;
      while ((tm = tre.exec(ts))) tms.push(timeToMs(tm[1]));
    } else if (line.includes('<') && line.includes('>')) {
      // Inline timestamped line (e.g. [bg:<01:56.442>...] [01:57.845]v1:...)
      const lineTsMatches = [...line.matchAll(/\[(\d{1,3}:\d{2}(?:\.\d{2,3})?)\]/g)];
      if (lineTsMatches.length > 0) {
        tms = lineTsMatches.map(tm => timeToMs(tm[1]));
      } else {
        const firstW = line.match(/<(\d{1,3}:\d{2}(?:\.\d{2,3})?)>/);
        if (firstW) tms.push(timeToMs(firstW[1]));
      }
      raw = line;
    } else {
      const detectedPart = detectSongPartHeader(line);
      if (detectedPart) {
        currentSongPart = detectedPart;
      }
      return;
    }

    // Check if raw line starts with [Verse] or [Chorus]
    let linePart = currentSongPart;
    const partMatch = raw.match(/^\s*\[([a-zA-Z0-9\s\-_:,'\.\(\)]+)\]\s*(.*)$/);
    if (partMatch) {
      const tagInside = partMatch[1].trim();
      if (!/^\d{1,3}:\d{2}/.test(tagInside) && !/^(ti|ar|al|by|au|la|offset|re|length):/i.test(tagInside) && !/^(v\d+|bg|ch):?$/i.test(tagInside)) {
        currentSongPart = tagInside;
        linePart = currentSongPart;
        raw = partMatch[2];
      }
    }

    let lineAgent = null;
    let lineIsBg = false;

    // Detect line-level agent / bg prefix
    const lineAgentMatch = raw.match(/^\s*\[?(v\d+|bg|ch):?\]?\s*(.*)$/i);
    if (lineAgentMatch && !raw.includes('<')) {
      const tag = lineAgentMatch[1].toLowerCase();
      if (tag === 'bg') lineIsBg = true;
      else lineAgent = tag;
      raw = lineAgentMatch[2];
    }

    let words = [];
    if (raw.includes('<') && raw.includes('>')) {
      const wre = /<(\d{1,3}:\d{2}(?:\.\d{2,3})?)>/g;
      const wordMatches = [...raw.matchAll(wre)];
      
      let activeIsBg = lineIsBg;
      let activeAgent = lineAgent || 'v1';

      // Check text before first tag
      if (wordMatches.length > 0 && wordMatches[0].index > 0) {
        const preText = raw.substring(0, wordMatches[0].index).trim();
        if (/\[?\s*bg:?/i.test(preText) || preText.startsWith('(')) {
          activeIsBg = true;
        } else if (/\[?\s*v(\d+):?/i.test(preText)) {
          const vm = preText.match(/v(\d+)/i);
          if (vm) activeAgent = 'v' + vm[1];
          activeIsBg = false;
        } else if (/\[?\s*ch:?/i.test(preText)) {
          activeAgent = 'ch';
          activeIsBg = false;
        }
      }

      wordMatches.forEach((wm, i) => {
        const startMs = timeToMs(wm[1]);
        const startIdx = wm.index + wm[0].length;
        const endIdx = (i < wordMatches.length - 1) ? wordMatches[i+1].index : raw.length;
        const wordRaw = raw.substring(startIdx, endIdx);

        // Clean word text by stripping tags like [bg:, v1:, ch:, ], (, ) and line timestamps [01:57.845]
        let wordText = wordRaw
          .replace(/\[\d{1,3}:\d{2}(?:\.\d{2,3})?\]/g, '')
          .replace(/\[?(v\d+|bg|ch):?/gi, '')
          .replace(/[\[\]\(\)]/g, '')
          .trim();

        if (wordText === "") {
          // Trailing timestamp marker (e.g. <02:00.057>] or <02:00.057>)
          if (words.length > 0 && words[words.length - 1].endMs <= words[words.length - 1].startMs) {
            words[words.length - 1].endMs = startMs;
          }
        } else {
          words.push({
            id: wid++,
            text: wordText,
            startMs: startMs,
            endMs: 0,
            isBackground: activeIsBg,
            role: activeIsBg ? 'x-bg' : null,
            agent: activeIsBg ? null : activeAgent
          });
        }

        // Update active state based on trailing tags in wordRaw for subsequent words
        if (/\[?\s*bg:?/i.test(wordRaw) || wordRaw.includes('(')) {
          activeIsBg = true;
        }
        if (/\[?\s*v(\d+):?/i.test(wordRaw)) {
          const vm = wordRaw.match(/v(\d+)/i);
          if (vm) activeAgent = 'v' + vm[1];
          activeIsBg = false;
        }
        if (/\[?\s*ch:?/i.test(wordRaw)) {
          activeAgent = 'ch';
          activeIsBg = false;
        }
        if ((wordRaw.includes(']') || wordRaw.includes(')')) && !/\[?\s*bg:?/i.test(wordRaw)) {
          activeIsBg = false;
        }
      });
      
      if (words.length) {
        for (let i = 0; i < words.length - 1; i++) {
          if (words[i].endMs <= words[i].startMs) words[i].endMs = words[i+1].startMs;
        }
      }
    }
    
    // Clean up line text for display: remove tags and collapse extra spaces
    let cleanText = raw.replace(/<[^>]+>/g, '')
      .replace(/\[\d{1,3}:\d{2}(?:\.\d{2,3})?\]/g, '')
      .replace(/\[?(v\d+|bg|ch):?/gi, '')
      .replace(/[\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const isBgLine = lineIsBg || (cleanText.startsWith('(') && cleanText.endsWith(')'));

    if (words && words.length > 0) {
      const allWordsBg = isBgLine || words.every(w => w.isBackground || w.role === 'x-bg');
      if (allWordsBg) {
        words.forEach(w => { w.isBackground = true; w.role = 'x-bg'; });
      } else {
        const mainW = words.filter(w => !w.isBackground && w.role !== 'x-bg').sort((a, b) => a.startMs - b.startMs);
        const bgW = words.filter(w => w.isBackground || w.role === 'x-bg').sort((a, b) => a.startMs - b.startMs);
        if (mainW.length > 0 && bgW.length > 0) {
          const { startBg, endBg } = partitionBgWords(bgW, mainW);
          words = [...startBg, ...mainW, ...endBg];
        }
      }
      cleanText = formatLineDisplayText(words, isBgLine);
      if (!lineAgent) {
        const firstMain = words.find(w => !w.isBackground && w.agent);
        if (firstMain) lineAgent = firstMain.agent;
      }
    } else if (isBgLine && !cleanText.startsWith('(')) {
      cleanText = ensureParentheses(cleanText);
    }

    tms.forEach(start => {
      let cueStart = start;
      let cueEnd = start + 3000;
      if (words && words.length > 0) {
        const allStarts = words.map(w => w.startMs);
        const allEnds = words.map(w => w.endMs);
        if (allStarts.length) cueStart = Math.min(cueStart, ...allStarts);
        if (allEnds.length) {
          const maxEnd = Math.max(...allEnds);
          if (maxEnd > cueStart) cueEnd = maxEnd;
        }
      }

      cues.push({ 
        id: id++, 
        startMs: cueStart, 
        endMs: cueEnd, 
        text: cleanText, 
        words: words.length ? words.map(w => ({...w, ...(isBgLine ? { isBackground: true, role: 'x-bg' } : {}) })) : null,
        isBackground: isBgLine,
        role: isBgLine ? 'x-bg' : null,
        agent: lineAgent || null,
        ...(linePart ? { songPart: linePart } : {})
      });
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
        // CRITICAL: We prioritize the next line's start time as the absolute deadline.
        if (lastW.endMs <= lastW.startMs || lastW.endMs > c.endMs) {
          lastW.endMs = c.endMs;
        }
        
        // Ensure all words fit within the line boundary
        c.words.forEach(w => {
            if (w.startMs > c.endMs) w.startMs = Math.max(c.startMs, c.endMs - 50);
            if (w.endMs > c.endMs) w.endMs = c.endMs;
        });
      }
    }
  });

  return cues;
}

function parseSRT(content) {
  const chunks = content.trim().replace(/\r\n/g,'\n').split(/\n\n+/), cues = [];
  let id = 1;
  chunks.forEach(chunk => {
    const ls = chunk.trim().split('\n').map(l => l.trim());
    if (ls.length < 1) return;
    let ti = 0;
    if (ls[0].match(/^\d+$/)) ti = 1;
    if (!ls[ti]) return;
    const times = ls[ti].split('-->');
    if (times.length !== 2) return;
    cues.push({ id: id++, startMs: timeToMs(times[0]), endMs: timeToMs(times[1]), text: ls.slice(ti+1).join('\n'), words: null });
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
  const cues = [];
  let currentSongPart = null;
  let lineIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const detectedPart = detectSongPartHeader(trimmed);
    if (detectedPart) {
      currentSongPart = detectedPart;
      continue;
    }

    const isBgLine = trimmed.startsWith('(') && trimmed.endsWith(')');
    lineIdx++;
    cues.push({
      id: lineIdx,
      startMs: (lineIdx - 1) * 2000,
      endMs: lineIdx * 2000,
      text: trimmed,
      words: null,
      ...(currentSongPart ? { songPart: currentSongPart } : {}),
      ...(isBgLine ? { isBackground: true, role: 'x-bg' } : {})
    });
  }

  return cues;
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
    return arr.map((c,i) => {
      let words = c.words ? c.words.map((w, idx) => ({
        id: w.id || idx + 1,
        text: w.text || '',
        startMs: Math.round(w.startMs !== undefined ? w.startMs : (w.start || 0)),
        endMs: Math.round(w.endMs !== undefined ? w.endMs : (w.end || 0)),
        confidence: w.confidence !== undefined ? w.confidence : (w.score !== undefined ? w.score : undefined),
        isBackground: !!(w.isBackground || w.role === 'x-bg'),
        role: w.role || (w.isBackground ? 'x-bg' : null),
        agent: w.agent || null
      })) : null;

      const isCueBg = !!(c.isBackground || c.role === 'x-bg');

      if (words && words.length > 0) {
        const pIsBgLine = isCueBg || words.every(w => w.isBackground || w.role === 'x-bg');
        if (pIsBgLine) {
          words.sort((a, b) => a.startMs - b.startMs);
          words.forEach(w => { w.isBackground = true; w.role = 'x-bg'; });
        } else {
          const mainW = words.filter(w => !w.isBackground && w.role !== 'x-bg').sort((a, b) => a.startMs - b.startMs);
          const bgW = words.filter(w => w.isBackground || w.role === 'x-bg').sort((a, b) => a.startMs - b.startMs);
          if (mainW.length === 0) {
            words = bgW;
          } else if (bgW.length === 0) {
            words = mainW;
          } else {
            const { startBg, endBg } = partitionBgWords(bgW, mainW);
            words = [...startBg, ...mainW, ...endBg];
          }
        }
      }

      let text = c.text || '';
      if (words && words.length > 0) {
        text = formatLineDisplayText(words, isCueBg);
      } else if (!text && isCueBg) {
        text = '()';
      }

      return { 
        id: i+1, 
        startMs: Math.round(c.start !== undefined ? c.start : (c.startMs || 0)), 
        endMs: Math.round(c.end !== undefined ? c.end : (c.endMs || 0)), 
        text: text, 
        words: words && words.length ? words : null,
        isBackground: isCueBg,
        role: c.role || (isCueBg ? 'x-bg' : null),
        agent: c.agent || null,
        songPart: c.songPart || null
      };
    });
  } catch(e) { return []; }
}

function ensureParentheses(text) {
  if (!text) return '';
  let t = text.trim();
  if (!t) return '';
  if (!t.startsWith('(')) t = '(' + t;
  if (!t.endsWith(')')) t = t + ')';
  return t;
}

function formatLineDisplayText(words, isLineBg) {
  if (!words || words.length === 0) return '';
  const validWords = words.filter(w => (w.text !== undefined && w.text !== null && w.text !== "" && w.text !== "\\"));
  if (validWords.length === 0) return '';

  const allBg = isLineBg || (validWords.length > 0 && validWords.every(w => w.isBackground || w.role === 'x-bg'));
  if (allBg) {
    const raw = validWords.map(w => w.text.trim().replace(/^\(/, '').replace(/\)$/, '')).filter(Boolean).join(' ');
    return ensureParentheses(raw);
  }

  const allMain = !isLineBg && validWords.every(w => !w.isBackground && w.role !== 'x-bg');
  if (allMain) {
    return validWords.map(w => w.text.trim()).filter(Boolean).join(' ');
  }

  // Mixed line: group into contiguous runs of bg and main words
  const runs = [];
  let currentRun = null;

  for (let i = 0; i < validWords.length; i++) {
    const w = validWords[i];
    const isBg = !!(w.isBackground || w.role === 'x-bg');
    if (!currentRun || currentRun.isBg !== isBg) {
      currentRun = { isBg: isBg, words: [] };
      runs.push(currentRun);
    }
    currentRun.words.push(w);
  }

  const runTexts = runs.map(run => {
    if (run.isBg) {
      const text = run.words.map(w => w.text.trim().replace(/^\(/, '').replace(/\)$/, '')).filter(Boolean).join(' ');
      return ensureParentheses(text);
    } else {
      return run.words.map(w => w.text.trim()).filter(Boolean).join(' ');
    }
  });

  return runTexts.join(' ').replace(/\s+/g, ' ').trim();
}

function partitionBgWords(bgWords, mainWords) {
  if (!bgWords || bgWords.length === 0) return { startBg: [], endBg: [] };
  if (!mainWords || mainWords.length === 0) return { startBg: bgWords, endBg: [] };

  const firstMain = mainWords[0];
  const lastMain = mainWords[mainWords.length - 1];
  const effectiveMainEnd = (lastMain.endMs && lastMain.endMs > lastMain.startMs) ? lastMain.endMs : lastMain.startMs + 1000;
  const mainMid = (firstMain.startMs + effectiveMainEnd) / 2;

  // Check if all bgWords have tokenIdx
  const hasTokenIndices = bgWords.every(w => w.tokenIdx !== undefined) && firstMain.tokenIdx !== undefined && lastMain.tokenIdx !== undefined;

  if (hasTokenIndices) {
    const startBg = bgWords.filter(w => w.tokenIdx < firstMain.tokenIdx);
    const endBg = bgWords.filter(w => w.tokenIdx > lastMain.tokenIdx);
    const midBg = bgWords.filter(w => w.tokenIdx >= firstMain.tokenIdx && w.tokenIdx <= lastMain.tokenIdx);
    midBg.forEach(w => {
      const wMid = (w.startMs + (w.endMs && w.endMs > w.startMs ? w.endMs : w.startMs + 500)) / 2;
      if (wMid <= mainMid) startBg.push(w);
      else endBg.push(w);
    });
    return { startBg, endBg };
  }

  const startBg = [];
  const endBg = [];

  bgWords.forEach(w => {
    const wMid = (w.startMs + (w.endMs && w.endMs > w.startMs ? w.endMs : w.startMs + 500)) / 2;
    if (w.startMs < firstMain.startMs || (wMid <= mainMid && w.startMs <= lastMain.startMs)) {
      startBg.push(w);
    } else {
      endBg.push(w);
    }
  });

  return { startBg, endBg };
}

function getRole(el){ if(!el || !el.getAttribute) return ''; return el.getAttribute('ttm:role') || el.getAttributeNS('http://www.w3.org/ns/ttml#metadata','role') || el.getAttribute('role') || ''; }
function getAgent(el){ if(!el || !el.getAttribute) return ''; return el.getAttribute('ttm:agent') || el.getAttributeNS('http://www.w3.org/ns/ttml#metadata','agent') || el.getAttribute('agent') || ''; }
function isBackgroundRole(role){ if(!role) return false; const r = role.toLowerCase(); return r === 'x-bg' || r === 'x-background' || r === 'background' || r === 'x-bg-vocal' || r.includes('bg'); }

function extractTTMLMetadata(content) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(content, "text/xml");
  const meta = {};
  const tt = xml.documentElement;
  if (tt) {
    meta.itunesTiming = tt.getAttribute('itunes:timing') || tt.getAttributeNS('http://music.apple.com/lyric-ttml-internal','timing') || '';
    meta.language = tt.getAttribute('xml:lang') || tt.getAttribute('lang') || '';
  }
  const head = xml.getElementsByTagName('head')[0];
  if (head) {
    const titleEl = head.getElementsByTagName('ttm:title')[0] || head.getElementsByTagNameNS('http://www.w3.org/ns/ttml#metadata','title')[0];
    if (titleEl) meta.title = titleEl.textContent.trim();
    
    const copyrightEl = head.getElementsByTagName('ttm:copyright')[0] || head.getElementsByTagNameNS('http://www.w3.org/ns/ttml#metadata','copyright')[0];
    if (copyrightEl) meta.copyright = copyrightEl.textContent.trim();

    const agents = [];
    const agentEls = head.getElementsByTagName('ttm:agent');
    for (let i = 0; i < agentEls.length; i++) {
      const a = agentEls[i];
      agents.push({
        id: a.getAttribute('xml:id') || a.getAttribute('id') || `v${i+1}`,
        type: a.getAttribute('type') || 'person',
        name: a.textContent.trim() || ''
      });
    }
    if (agents.length) meta.agents = agents;

    const itunesMeta = head.getElementsByTagName('iTunesMetadata')[0] || head.getElementsByTagNameNS('http://music.apple.com/lyric-ttml-internal','iTunesMetadata')[0];
    if (itunesMeta) {
      const sw = [];
      const swEls = itunesMeta.getElementsByTagName('songwriter');
      for (let i = 0; i < swEls.length; i++) {
        const t = swEls[i].textContent.trim();
        if (t) sw.push(t);
      }
      if (sw.length) meta.songwriters = sw;
      const leading = itunesMeta.getAttribute('leadingSilence');
      if (leading) meta.leadingSilence = parseInt(leading) || 0;
    }
  }
  return meta;
}

function parseLRCAndExtractMetadata(content) {
  const metadata = {};
  const lines = content.split(/\r?\n/);
  lines.forEach(line => {
    const m = line.match(/^\[(ti|ar|al|by|au|length|offset|re|ve|la):([^\]]*)\]/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'ti') metadata.title = val;
      else if (key === 'ar') metadata.artist = val;
      else if (key === 'al') metadata.album = val;
      else if (key === 'by') metadata.by = val;
      else if (key === 'au') metadata.author = val;
      else if (key === 'offset') metadata.offset = parseInt(val) || 0;
      else if (key === 'la') metadata.language = val;
      else if (key === 're') metadata.copyright = val;
    }
  });
  return metadata;
}

function unquoteYaml(str) {
  if (!str) return '';
  str = str.trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    const quote = str[0];
    let body = str.slice(1, -1);
    if (quote === '"') {
      body = body.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
    } else {
      body = body.replace(/''/g, "'");
    }
    return body;
  }
  return str;
}

function parseMetadata(content, format) {
  const metadata = { durationMs: 0 };
  if (format === 'lyricsfile') {
    const match = content.match(/duration_ms:\s*(\d+)/);
    if (match) metadata.durationMs = parseInt(match[1]);
    const titleMatch = content.match(/title:\s*(.*)/);
    if (titleMatch) metadata.title = unquoteYaml(titleMatch[1]);
    const artistMatch = content.match(/artist:\s*(.*)/);
    if (artistMatch) metadata.artist = unquoteYaml(artistMatch[1]);
    const albumMatch = content.match(/album:\s*(.*)/);
    if (albumMatch) metadata.album = unquoteYaml(albumMatch[1]);
    const langMatch = content.match(/language:\s*(.*)/);
    if (langMatch) metadata.language = unquoteYaml(langMatch[1]);
    const byMatch = content.match(/by:\s*(.*)/);
    if (byMatch) metadata.by = unquoteYaml(byMatch[1]);
  } else if (format === 'lrc') {
    Object.assign(metadata, parseLRCAndExtractMetadata(content));
  } else if (format === 'ttml') {
    try {
      const m = extractTTMLMetadata(content);
      Object.assign(metadata, m);
    } catch(e) {}
  } else if (format === 'json') {
    try {
      const p = JSON.parse(content);
      if (p && p.metadata) {
        Object.assign(metadata, p.metadata);
        if (p.metadata.duration_ms) {
          metadata.durationMs = p.metadata.duration_ms;
        }
      }
    } catch(e) {}
  }
  return metadata;
}


function decodeHTMLEntities(text) {
  if (!text) return text;
  return text.replace(/&#39;/g, "'")
             .replace(/&quot;/g, '"')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>');
}

function fillGapsWithGhostWords(cues) {
  let nextGhostId = 20000;
  cues.forEach(c => {
    if (!c.words || c.words.length === 0) return;

    const startMs = c.startMs;
    const endMs = c.endMs;
    const pIsBg = !!(c.isBackground || c.role === 'x-bg');
    const pAgent = c.agent || null;

    const hasBg = c.words.some(w => w.isBackground || w.role === 'x-bg');

    // If the line contains background vocals, do NOT add ghost words for main or bg channels,
    // and strip any existing blank ghost words so the timeline display is clean.
    if (hasBg || pIsBg) {
      c.words = c.words.filter(w => {
        const t = (w.text || "").trim();
        return t !== "" && t !== "\\";
      });
      return;
    }

    c.words.sort((a, b) => a.startMs - b.startMs);

    function fillChannelGaps(chWords, isBg) {
      if (chWords.length === 0) return [];
      const filled = [];

      // Lead-in gap from line startMs
      if (!isBg && chWords[0].startMs > startMs + 20) {
        filled.push({
          id: nextGhostId++,
          text: "",
          startMs: startMs,
          endMs: chWords[0].startMs,
          isBackground: false,
          role: null,
          agent: pAgent
        });
      }

      for (let k = 0; k < chWords.length; k++) {
        filled.push(chWords[k]);
        if (k < chWords.length - 1) {
          const gap = chWords[k+1].startMs - chWords[k].endMs;
          if (gap > 5) {
            filled.push({
              id: nextGhostId++,
              text: "",
              startMs: chWords[k].endMs,
              endMs: chWords[k+1].startMs,
              isBackground: isBg,
              role: isBg ? 'x-bg' : null,
              agent: chWords[k].agent || pAgent
            });
          }
        }
      }

      // Tail gap to line endMs
      const lastW = filled[filled.length - 1];
      if (!isBg && lastW && lastW.endMs < endMs - 20) {
        filled.push({
          id: nextGhostId++,
          text: "",
          startMs: lastW.endMs,
          endMs: endMs,
          isBackground: false,
          role: null,
          agent: pAgent
        });
      }

      return filled;
    }

    c.words = fillChannelGaps(c.words, false);
  });
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
    case 'audacity': cues = parseAudacity(content); break;
    default: cues = parseSRT(content);
  }

  cues.forEach(c => {
    c.text = decodeHTMLEntities(c.text);
    if (c.words) {
      c.words.forEach(w => w.text = decodeHTMLEntities(w.text));
    }
  });

  // Automatically fill any gaps between timestamps with ghost word-blocks so words stay connected
  fillGapsWithGhostWords(cues);

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
  let globalMeta = {};
  try {
    globalMeta = extractTTMLMetadata(content);
  } catch(e) {}
  
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const beginAttr = p.getAttribute('begin');
    const endAttr = p.getAttribute('end');
    const durAttr = p.getAttribute('dur');
    let startMs = beginAttr ? timeToMs(beginAttr) : 0;
    let endMs = 0;
    if (endAttr) endMs = timeToMs(endAttr);
    else if (durAttr) endMs = startMs + timeToMs(durAttr);
    else endMs = startMs + 2000;

    const pRole = getRole(p);
    const pAgent = getAgent(p);
    const pIsBg = isBackgroundRole(pRole);
    
    let songPart = null;
    let parent = p.parentElement;
    while (parent) {
      if ((parent.localName || parent.tagName || '').toLowerCase() === 'div') {
        const sp = parent.getAttribute('itunes:song-part') || parent.getAttributeNS('http://music.apple.com/lyric-ttml-internal', 'song-part') || parent.getAttribute('song-part');
        if (sp) {
          songPart = sp;
          break;
        }
      }
      parent = parent.parentElement;
    }
    const words = [];
    let wordId = 1;

    function pushWord(text, sMs, eMs, isBg, agent, role) {
      if (!text) return;
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean) return;
      words.push({
        id: wordId++,
        text: clean,
        startMs: (sMs !== undefined && sMs !== null) ? sMs : startMs,
        endMs: (eMs !== undefined && eMs !== null) ? eMs : endMs,
        isBackground: !!isBg,
        agent: agent || pAgent || null,
        role: isBg ? 'x-bg' : (role || null)
      });
    }

    function hasTimedChildSpans(node) {
      return Array.from(node.childNodes).some(n => 
        n.nodeType === 1 && 
        n.localName === 'span' && 
        (n.hasAttribute('begin') || n.hasAttribute('end') || n.hasAttribute('dur') || hasTimedChildSpans(n))
      );
    }

    function traverse(node, inheritedBg, inheritedAgent) {
      if (!node) return;
      if (node.nodeType === 3) {
        const txt = node.textContent.trim();
        if (txt) {
          pushWord(txt, null, null, inheritedBg, inheritedAgent, inheritedBg ? 'x-bg' : null);
        }
        return;
      }
      if (node.nodeType !== 1) return;

      const tag = (node.localName || node.tagName || '').toLowerCase();
      if (tag === 'br') return;

      const role = getRole(node);
      const agent = getAgent(node);
      const curBg = inheritedBg || isBackgroundRole(role);
      const curAgent = agent || inheritedAgent;

      if (tag === 'span') {
        const hasBegin = node.hasAttribute('begin');
        const hasEnd = node.hasAttribute('end');
        const hasDur = node.hasAttribute('dur');
        const hasTiming = hasBegin || hasEnd || hasDur;
        const timedChildren = hasTimedChildSpans(node);

        if (!hasTiming && timedChildren) {
          for (let child of node.childNodes) {
            traverse(child, curBg, curAgent);
          }
        } else if (hasTiming) {
          if (timedChildren) {
            for (let child of node.childNodes) {
              traverse(child, curBg, curAgent);
            }
          } else {
            let sMs = hasBegin ? timeToMs(node.getAttribute('begin')) : startMs;
            let eMs = 0;
            if (hasEnd) eMs = timeToMs(node.getAttribute('end'));
            else if (hasDur) eMs = sMs + timeToMs(node.getAttribute('dur'));
            else eMs = endMs;
            const txt = node.textContent.trim();
            if (txt) {
              pushWord(txt, sMs, eMs, curBg, curAgent, role);
            }
          }
        } else {
          if (node.childElementCount > 0) {
            for (let child of node.childNodes) {
              traverse(child, curBg, curAgent);
            }
          } else {
            const txt = node.textContent.trim();
            if (txt) {
              pushWord(txt, null, null, curBg, curAgent, role);
            }
          }
        }
      } else {
        for (let child of node.childNodes) {
          traverse(child, inheritedBg, inheritedAgent);
        }
      }
    }

    for (let child of p.childNodes) {
      traverse(child, pIsBg, pAgent);
    }

    let pWords = words;
    if (pWords.length > 0) {
      const pIsBgLine = pIsBg || pWords.every(w => w.isBackground || w.role === 'x-bg');
      if (pIsBgLine) {
        pWords.sort((a, b) => a.startMs - b.startMs);
        pWords.forEach(w => { w.isBackground = true; w.role = 'x-bg'; });
      } else {
        const mainW = pWords.filter(w => !w.isBackground && w.role !== 'x-bg').sort((a, b) => a.startMs - b.startMs);
        const bgW = pWords.filter(w => w.isBackground || w.role === 'x-bg').sort((a, b) => a.startMs - b.startMs);
        if (mainW.length === 0) {
          pWords = bgW;
        } else if (bgW.length === 0) {
          pWords = mainW;
        } else {
          const { startBg, endBg } = partitionBgWords(bgW, mainW);
          pWords = [...startBg, ...mainW, ...endBg];
        }
      }
    }

    if (pWords.length > 0) {
      const allStarts = pWords.map(w => w.startMs);
      const allEnds = pWords.map(w => w.endMs);
      if (!beginAttr && allStarts.length) startMs = Math.min(...allStarts);
      if (!endAttr && !durAttr && allEnds.length) endMs = Math.max(...allEnds);
    }
    if (endMs <= startMs) endMs = startMs + 2000;

    let text = '';
    if (pWords.length > 0) {
      text = formatLineDisplayText(pWords, pIsBg);
    } else {
      text = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (pIsBg && text && !text.startsWith('(')) text = ensureParentheses(text);
    }

    cues.push({
      id: i + 1,
      startMs,
      endMs,
      text,
      words: pWords.length ? pWords : null,
      role: pRole || null,
      agent: pAgent || null,
      isBackground: pIsBg,
      songPart: songPart || null
    });
  }
  try {
    if (typeof window !== 'undefined') window.__lastTTMLMetadata = globalMeta;
  } catch(e) {}
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
    
    const startMs = tAttr ? Math.round(parseFloat(tAttr)) : 0;
    const durMs = dAttr ? Math.round(parseFloat(dAttr)) : 0;
    
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
  const plainStart = linesPart.indexOf('\nplain:');
  if (plainStart !== -1) linesPart = linesPart.substring(0, plainStart);

  const rawLines = linesPart.split(/\r?\n/);
  
  let currentLine = null;
  let currentWord = null;
  let inWords = false;
  let lineIndent = -1;
  let wordsIndent = -1;
  let lineIdx = 0;
  let wordIdx = 0;

  function finalizeWord(w) {
    return {
      id: ++wordIdx,
      text: w.text || '',
      startMs: (w.startMs !== null && w.startMs !== undefined) ? w.startMs : 0,
      endMs: (w.endMs !== null && w.endMs !== undefined) ? w.endMs : 0,
      ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
      ...(w.isBackground ? { isBackground: true, role: 'x-bg' } : {}),
      ...(w.agent ? { agent: w.agent } : {})
    };
  }

  function finalizeLine(l) {
    let startMs = (l.startMs !== null && l.startMs !== undefined) ? l.startMs : 0;
    let endMs = (l.endMs !== null && l.endMs !== undefined) ? l.endMs : 0;

    const words = (l.words && l.words.length) ? l.words : null;
    if (words) {
      if (startMs === 0 && words[0].startMs > 0) startMs = words[0].startMs;
      
      // Interpolate missing endMs for words
      for (let j = 0; j < words.length - 1; j++) {
        if (!words[j].endMs || words[j].endMs <= words[j].startMs) {
          words[j].endMs = words[j+1].startMs;
        }
      }
      const lastW = words[words.length - 1];
      if (endMs > 0 && (!lastW.endMs || lastW.endMs <= lastW.startMs)) {
        lastW.endMs = endMs;
      } else if (!lastW.endMs || lastW.endMs <= lastW.startMs) {
        lastW.endMs = lastW.startMs + 500;
      }
      if (endMs <= startMs) {
        endMs = Math.max(lastW.endMs, startMs + 3000);
      }
      lastW.endMs = Math.min(lastW.endMs, endMs);
    } else {
      if (endMs <= startMs) endMs = startMs + 3000;
    }

    return {
      id: ++lineIdx,
      text: l.text || '',
      startMs,
      endMs,
      words,
      ...(l.isBackground ? { isBackground: true, role: 'x-bg' } : {}),
      ...(l.agent ? { agent: l.agent } : {}),
      ...(l.songPart ? { songPart: l.songPart } : {})
    };
  }

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.search(/\S/);

    if (lineIndent === -1 && /^\s*-\s+text:/.test(raw)) {
      lineIndent = indent;
    }

    const isLineItem = /^\s*-\s+text:\s*(.*)/.test(raw) && (indent === lineIndent || (lineIndent !== -1 && indent <= lineIndent));

    if (isLineItem) {
      if (currentWord && currentLine) {
        currentLine.words.push(finalizeWord(currentWord));
        currentWord = null;
      }
      if (currentLine) {
        cues.push(finalizeLine(currentLine));
      }
      const match = raw.match(/^\s*-\s+text:\s*(.*)/);
      currentLine = {
        text: unquoteYaml(match[1]),
        startMs: null,
        endMs: null,
        words: [],
        isBackground: false,
        agent: null,
        songPart: null
      };
      currentWord = null;
      inWords = false;
      wordsIndent = -1;
      continue;
    }

    if (!currentLine) continue;

    const wordsKeyMatch = raw.match(/^\s*words:\s*(.*)/);
    if (wordsKeyMatch) {
      if (currentWord) {
        currentLine.words.push(finalizeWord(currentWord));
        currentWord = null;
      }
      const val = wordsKeyMatch[1].trim();
      if (val === '[]' || val === 'null' || val === '~') {
        inWords = false;
      } else {
        inWords = true;
      }
      wordsIndent = indent;
      continue;
    }

    if (inWords && wordsIndent !== -1 && indent <= wordsIndent) {
      inWords = false;
      if (currentWord) {
        currentLine.words.push(finalizeWord(currentWord));
        currentWord = null;
      }
    }

    if (inWords && /^\s*-\s+text:\s*(.*)/.test(raw)) {
      if (currentWord) {
        currentLine.words.push(finalizeWord(currentWord));
      }
      const match = raw.match(/^\s*-\s+text:\s*(.*)/);
      currentWord = {
        text: unquoteYaml(match[1]),
        startMs: null,
        endMs: null,
        confidence: undefined,
        isBackground: false,
        agent: null
      };
      continue;
    }

    if (inWords && currentWord) {
      if (/start_ms:\s*(\d+)/.test(raw)) {
        currentWord.startMs = parseInt(raw.match(/start_ms:\s*(\d+)/)[1]);
      } else if (/end_ms:\s*(\d+)/.test(raw)) {
        currentWord.endMs = parseInt(raw.match(/end_ms:\s*(\d+)/)[1]);
      } else if (/confidence:\s*([0-9.]+)/i.test(raw)) {
        let conf = parseFloat(raw.match(/confidence:\s*([0-9.]+)/i)[1]);
        if (conf > 1 && conf <= 100) conf = conf / 100;
        currentWord.confidence = Math.round(conf * 100) / 100;
      } else if (/score:\s*([0-9.]+)/i.test(raw)) {
        let conf = parseFloat(raw.match(/score:\s*([0-9.]+)/i)[1]);
        if (conf > 1 && conf <= 100) conf = conf / 100;
        currentWord.confidence = Math.round(conf * 100) / 100;
      } else if (/isBackground:\s*(true|false)/i.test(raw)) {
        currentWord.isBackground = /true/i.test(raw);
      } else if (/agent:\s*(.*)/i.test(raw)) {
        currentWord.agent = unquoteYaml(raw.match(/agent:\s*(.*)/i)[1]);
      }
      continue;
    }

    if (!inWords) {
      if (/^\s*start_ms:\s*(\d+)/.test(raw)) {
        currentLine.startMs = parseInt(raw.match(/start_ms:\s*(\d+)/)[1]);
      } else if (/^\s*end_ms:\s*(\d+)/.test(raw)) {
        currentLine.endMs = parseInt(raw.match(/end_ms:\s*(\d+)/)[1]);
      } else if (/^\s*isBackground:\s*(true|false)/i.test(raw)) {
        currentLine.isBackground = /true/i.test(raw);
      } else if (/^\s*agent:\s*(.*)/i.test(raw)) {
        currentLine.agent = unquoteYaml(raw.match(/agent:\s*(.*)/i)[1]);
      } else if (/^\s*songPart:\s*(.*)/i.test(raw)) {
        currentLine.songPart = unquoteYaml(raw.match(/songPart:\s*(.*)/i)[1]);
      } else if (/^\s*song_part:\s*(.*)/i.test(raw)) {
        currentLine.songPart = unquoteYaml(raw.match(/song_part:\s*(.*)/i)[1]);
      } else if (/^\s*part:\s*(.*)/i.test(raw)) {
        currentLine.songPart = unquoteYaml(raw.match(/part:\s*(.*)/i)[1]);
      }
    }
  }

  if (currentWord && currentLine) {
    currentLine.words.push(finalizeWord(currentWord));
  }
  if (currentLine) {
    cues.push(finalizeLine(currentLine));
  }

  return cues;
}

function autoFillWords(cues) {
  cues.forEach(c => {
    if (!c.words || !c.words.length) {
      const ws = c.text.trim().split(/\s+/).filter(w => w);
      if (ws.length === 0) {
        // Line is empty - create one blank word covering the whole duration
        // This preserves the timing of empty lines during Smart Merge
        c.words = [{ id: 1, text: "", startMs: c.startMs, endMs: c.endMs }];
      } else {
        const dur = Math.max(100, c.endMs - c.startMs), perW = dur / ws.length;
        c.words = ws.map((w, i) => ({ id: i+1, text: w, startMs: Math.round(c.startMs + perW*i), endMs: Math.round(c.startMs + perW*(i+1)) }));
      }
      if (c.words.length) {
        c.words[0].startMs = c.startMs;
        for (let i=0;i<c.words.length-1;i++) c.words[i].endMs = c.words[i+1].startMs;
        c.words[c.words.length-1].endMs = c.endMs;
      }
    }
  });
}

function escapeXML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function msToTTMLTime(ms){ return msToVtt(ms); }

function stringifyTTML(cues, karaoke, durationMs, options = {}) {
  const autoEmpty = options.autoEmptyLines !== false;
  const metadata = options.metadata || {};
  const title = metadata.title || metadata.ttmlTitle || "Lyrics";
  const lang = metadata.language || "en";
  let head = `  <head>\n    <metadata>\n      <ttm:title>${escapeXML(title)}</ttm:title>\n`;
  if (metadata.copyright) head += `      <ttm:copyright>${escapeXML(metadata.copyright)}</ttm:copyright>\n`;
  head += `    </metadata>\n    <styling>\n      <style xml:id="s1" tts:textAlign="center" tts:fontFamily="Arial" tts:fontSize="100%"/>\n    </styling>\n    <layout>\n      <region xml:id="bottom" tts:displayAlign="after" tts:extent="80% 40%" tts:origin="10% 50%"/>\n    </layout>\n  </head>`;
  let bodyLines = [];
  
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const pAttrs = [];
    pAttrs.push(`begin="${msToTTMLTime(cue.startMs)}"`);
    pAttrs.push(`end="${msToTTMLTime(cue.endMs)}"`);
    if (cue.agent) pAttrs.push(`ttm:agent="${cue.agent}"`);
    if (cue.isBackground || cue.role === 'x-bg') pAttrs.push(`ttm:role="x-bg"`);
    pAttrs.push(`region="bottom"`);
    pAttrs.push(`style="s1"`);
    let content = (cue.text || "").replace(/\n/g, '<br/>');
    if (karaoke && cue.words && cue.words.length > 0) {
      const validWords = cue.words.filter(w => (w.text || "").trim().length > 0 && w.text !== "\\");
      const wordsToExport = validWords.length > 0 ? validWords : cue.words;

      const isCueBg = !!(cue.isBackground || cue.role === 'x-bg');
      const mainWords = isCueBg ? [] : wordsToExport.filter(w => !w.isBackground && w.role !== 'x-bg');
      const bgWords = isCueBg ? wordsToExport : wordsToExport.filter(w => w.isBackground || w.role === 'x-bg');

      function renderWordSpan(w, indent = '        ') {
        const ws = w.startMs !== undefined ? w.startMs : cue.startMs;
        const we = w.endMs !== undefined ? w.endMs : cue.endMs;
        let extra = '';
        if (w.agent && w.agent !== cue.agent) extra += ` ttm:agent="${w.agent}"`;
        return `${indent}<span begin="${msToTTMLTime(ws)}" end="${msToTTMLTime(we)}"${extra}>${escapeXML(w.text)}</span>`;
      }

      function renderBgGroup(words) {
        if (!words || words.length === 0) return '';
        const inner = words.map((w, idx) => {
          let text = (w.text || "").trim();
          if (idx === 0 && !text.startsWith('(')) text = '(' + text;
          if (idx === words.length - 1 && !text.endsWith(')')) text = text + ')';
          const ws = w.startMs !== undefined ? w.startMs : cue.startMs;
          const we = w.endMs !== undefined ? w.endMs : cue.endMs;
          let extra = '';
          if (w.agent && w.agent !== cue.agent) extra += ` ttm:agent="${w.agent}"`;
          return `          <span begin="${msToTTMLTime(ws)}" end="${msToTTMLTime(we)}"${extra}>${escapeXML(text)}</span>`;
        }).join('\n');
        return `        <span ttm:role="x-bg">\n${inner}\n        </span>`;
      }

      let innerSpans = [];

      if (mainWords.length === 0) {
        innerSpans.push(renderBgGroup(bgWords));
      } else if (bgWords.length === 0) {
        mainWords.forEach(w => innerSpans.push(renderWordSpan(w)));
      } else {
        const { startBg, endBg } = partitionBgWords(bgWords, mainWords);

        if (startBg.length > 0) innerSpans.push(renderBgGroup(startBg));
        mainWords.forEach(w => innerSpans.push(renderWordSpan(w)));
        if (endBg.length > 0) innerSpans.push(renderBgGroup(endBg));
      }
      content = '\n' + innerSpans.join('\n') + '\n      ';
    } else {
      content = escapeXML(content);
    }
    bodyLines.push(`      <p ${pAttrs.join(' ')}>${content}</p>`);
    
    const nextStart = (i < cues.length - 1) ? cues[i + 1].startMs : null;
    if (autoEmpty && nextStart && cue.endMs < nextStart - 10) {
      bodyLines.push(`      <p begin="${msToVtt(cue.endMs)}" end="${msToVtt(nextStart)}" region="bottom" style="s1"></p>`);
    }
  }

  const body = bodyLines.join('\n');
  const bodyAttr = durationMs ? ` dur="${msToTTMLTime(durationMs)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="media" xml:lang="${lang}">\n${head}\n  <body${bodyAttr}>\n    <div>\n${body}\n    </div>\n  </body>\n</tt>`;
}

function stringifyAppleTTML(cues, karaoke, durationMs, options = {}) {
  const autoEmpty = options.autoEmptyLines !== false;
  const metadata = options.metadata || {};
  const lang = metadata.language || metadata.xmlLang || "en";
  const timing = metadata.itunesTiming || metadata.appleTiming || (karaoke ? "Word" : "Line");
  const agents = (metadata.agents && metadata.agents.length) ? metadata.agents : [{id:"v1", type:"person"}];
  let songwriters = metadata.songwriters || metadata.appleSongwriters || [];
  if (typeof songwriters === 'string') songwriters = songwriters.split('\n').map(s=>s.trim()).filter(Boolean);
  const leadingSilence = metadata.leadingSilence || 0;
  const title = metadata.title || metadata.ttmlTitle || "Lyrics";

  let head = `  <head>\n    <metadata>\n`;
  agents.forEach(a=>{
    const id = a.id || `v${Math.random()}`;
    const type = a.type || 'person';
    head += `      <ttm:agent type="${type}" xml:id="${id}"/>\n`;
  });
  if (title) head += `      <ttm:title>${escapeXML(title)}</ttm:title>\n`;
  head += `      <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal" leadingSilence="${leadingSilence}">\n        <translations/>\n        <songwriters>\n`;
  if (songwriters.length===0) {
    head += `          <songwriter></songwriter>\n`;
  } else {
    songwriters.forEach(sw=>{
      head += `          <songwriter>${escapeXML(sw)}</songwriter>\n`;
    });
  }
  head += `        </songwriters>\n      </iTunesMetadata>\n    </metadata>\n    <styling>\n      <style xml:id="s1" tts:textAlign="center" tts:fontFamily="Arial" tts:fontSize="100%"/>\n    </styling>\n    <layout>\n      <region xml:id="bottom" tts:displayAlign="after" tts:extent="80% 40%" tts:origin="10% 50%"/>\n    </layout>\n  </head>`;

  // Group cues by consecutive songPart values
  const divs = [];
  let currentDiv = null;
  cues.forEach(cue => {
    const part = cue.songPart || "";
    if (!currentDiv || currentDiv.part !== part) {
      currentDiv = { part: part, cues: [] };
      divs.push(currentDiv);
    }
    currentDiv.cues.push(cue);
  });

  let bodyLines = [];
  divs.forEach(d => {
    if (d.cues.length === 0) return;
    const divStart = d.cues[0].startMs;
    const divEnd = d.cues[d.cues.length - 1].endMs;
    let divAttrs = [];
    divAttrs.push(`begin="${msToTTMLTime(divStart)}"`);
    divAttrs.push(`end="${msToTTMLTime(divEnd)}"`);
    if (d.part) {
      divAttrs.push(`itunes:song-part="${escapeXML(d.part)}"`);
    }
    
    let pLines = [];
    d.cues.forEach((cue, i) => {
      let pAttrs = [];
      pAttrs.push(`begin="${msToTTMLTime(cue.startMs)}"`);
      pAttrs.push(`end="${msToTTMLTime(cue.endMs)}"`);
      if (cue.agent) pAttrs.push(`ttm:agent="${cue.agent}"`);
      if (cue.isBackground || cue.role === 'x-bg') pAttrs.push(`ttm:role="x-bg"`);
      pAttrs.push(`region="bottom"`);
      pAttrs.push(`style="s1"`);
      let content = '';

      if (karaoke && cue.words && cue.words.length > 0) {
        const validWords = cue.words.filter(w => (w.text || "").trim().length > 0 && w.text !== "\\");
        const wordsToExport = validWords.length > 0 ? validWords : cue.words;

        const isCueBg = !!(cue.isBackground || cue.role === 'x-bg');
        const mainWords = isCueBg ? [] : wordsToExport.filter(w => !w.isBackground && w.role !== 'x-bg');
        const bgWords = isCueBg ? wordsToExport : wordsToExport.filter(w => w.isBackground || w.role === 'x-bg');

        function renderWordSpan(w, indent = '        ') {
          const ws = w.startMs !== undefined ? w.startMs : cue.startMs;
          const we = w.endMs !== undefined ? w.endMs : cue.endMs;
          let extra = '';
          if (w.agent && w.agent !== cue.agent) extra += ` ttm:agent="${w.agent}"`;
          return `${indent}<span begin="${msToTTMLTime(ws)}" end="${msToTTMLTime(we)}"${extra}>${escapeXML(w.text)}</span>`;
        }

        function renderBgGroup(words) {
          if (!words || words.length === 0) return '';
          const inner = words.map((w, idx) => {
            let text = (w.text || "").trim();
            if (idx === 0 && !text.startsWith('(')) text = '(' + text;
            if (idx === words.length - 1 && !text.endsWith(')')) text = text + ')';
            const ws = w.startMs !== undefined ? w.startMs : cue.startMs;
            const we = w.endMs !== undefined ? w.endMs : cue.endMs;
            let extra = '';
            if (w.agent && w.agent !== cue.agent) extra += ` ttm:agent="${w.agent}"`;
            return `          <span begin="${msToTTMLTime(ws)}" end="${msToTTMLTime(we)}"${extra}>${escapeXML(text)}</span>`;
          }).join('\n');
          return `        <span ttm:role="x-bg">\n${inner}\n        </span>`;
        }

        let innerSpans = [];

        if (mainWords.length === 0) {
          innerSpans.push(renderBgGroup(bgWords));
        } else if (bgWords.length === 0) {
          mainWords.forEach(w => innerSpans.push(renderWordSpan(w)));
        } else {
          const { startBg, endBg } = partitionBgWords(bgWords, mainWords);

          if (startBg.length > 0) innerSpans.push(renderBgGroup(startBg));
          mainWords.forEach(w => innerSpans.push(renderWordSpan(w)));
          if (endBg.length > 0) innerSpans.push(renderBgGroup(endBg));
        }
        content = '\n' + innerSpans.join('\n') + '\n      ';
      } else {
        content = escapeXML(cue.text || '');
      }
      pLines.push(`      <p ${pAttrs.join(' ')}>${content}</p>`);
      
      const nextStart = (i < d.cues.length - 1) ? d.cues[i + 1].startMs : null;
      if (autoEmpty && nextStart && cue.endMs < nextStart - 10) {
        pLines.push(`      <p begin="${msToTTMLTime(cue.endMs)}" end="${msToTTMLTime(nextStart)}" region="bottom" style="s1"></p>`);
      }
    });

    bodyLines.push(`    <div ${divAttrs.join(' ')}>\n${pLines.join('\n')}\n    </div>`);
  });

  const body = bodyLines.join('\n');
  const bodyAttr = durationMs ? ` dur="${msToTTMLTime(durationMs)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" itunes:timing="${timing}" xml:lang="${lang}">\n${head}\n  <body${bodyAttr}>\n${body}\n  </body>\n</tt>`;
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

function stringifyTXT(cues, options = {}) {
  let result = '';
  const STANZA_BREAK_THRESHOLD = 2000;
  const includeSongParts = options.includeSongParts !== false;
  let lastSongPart = null;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const text = (cue.text || "").trim();
    const currentPart = (cue.songPart || "").trim();

    if (includeSongParts) {
      if (currentPart && currentPart !== lastSongPart) {
        if (result.length > 0) {
          result = result.trimEnd() + '\n\n';
        }
        result += `[${currentPart}]\n`;
        lastSongPart = currentPart;
      } else if (!currentPart && lastSongPart !== null) {
        lastSongPart = null;
      }
    }

    if (text) {
      result += text + '\n';
    }
    
    if (i < cues.length - 1) {
      const nextCue = cues[i + 1];
      const nextPart = (nextCue.songPart || "").trim();
      if (!includeSongParts || !nextPart || nextPart === currentPart) {
        const currentEnd = cue.endMs;
        const nextStart = nextCue.startMs;
        const gap = nextStart - currentEnd;

        if (gap >= STANZA_BREAK_THRESHOLD) {
          result += '\n';
        }
      }
    }
  }
  return result.trim() + '\n';
}

function stringifyLRC(cues, enhanced, durationMs, options = {}) {
  const autoEmpty = options.autoEmptyLines !== false;
  const metadata = options.metadata || {};
  let output = [];
  if (metadata.title) output.push(`[ti:${metadata.title}]`);
  if (metadata.artist) output.push(`[ar:${metadata.artist}]`);
  if (metadata.album) output.push(`[al:${metadata.album}]`);
  if (metadata.author || metadata.by) output.push(`[by:${metadata.author || metadata.by}]`);
  if (metadata.lyricist) output.push(`[au:${metadata.lyricist}]`);
  if (metadata.language) output.push(`[la:${metadata.language}]`);
  if (metadata.offset) output.push(`[offset:${metadata.offset}]`);
  if (metadata.copyright) output.push(`[re:${metadata.copyright}]`);
  if (durationMs) {
    const totalSecs = Math.round(durationMs / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    output.push(`[length:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}]`);
  }

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    let line = `[${msToLrc(c.startMs)}]`;
    if (enhanced && c.words && c.words.length > 0) {
      const validWords = c.words.filter(w => (w.text || "").trim().length > 0 && w.text !== "\\");
      if (validWords.length > 0) {
        const runs = [];
        let curRun = null;
        for (let w of validWords) {
          const isBg = !!(w.isBackground || w.role === 'x-bg');
          if (!curRun || curRun.isBg !== isBg) {
            curRun = { isBg, words: [] };
            runs.push(curRun);
          }
          curRun.words.push(w);
        }

        const runStrs = runs.map(run => {
          if (run.isBg) {
            const inner = run.words.map(w => {
              const clean = (w.text || "").replace(/^\(/, '').replace(/\)$/, '');
              return `<${msToLrc(w.startMs)}>${clean}`;
            }).join(' ');
            return `(${inner})`;
          } else {
            return run.words.map(w => `<${msToLrc(w.startMs)}>${w.text}`).join(' ');
          }
        });
        line += " " + runStrs.join(' ');
      } else if (c.text && c.text.trim()) {
        line += " " + c.text;
      }
    } else if (c.text && c.text.trim()) {
      let txt = c.text;
      if (c.isBackground && !txt.startsWith('(')) txt = ensureParentheses(txt);
      line += " " + txt;
    }
    output.push(line);

    // Add a blank line to clear the screen if there's a gap to the next cue or at the end
    const nextStart = (i < cues.length - 1) ? cues[i + 1].startMs : (durationMs || (c.endMs + 1000));
    if (autoEmpty && c.endMs < nextStart - 10) { // Small threshold to avoid redundant clears
      output.push(`[${msToLrc(c.endMs)}]`);
    }
  }
  return output.join('\n');
}

function stringifyLRCTesting(cues, enhanced, durationMs, options = {}) {
  const autoEmpty = options.autoEmptyLines !== false;
  const metadata = options.metadata || {};
  let output = [];
  if (metadata.title) output.push(`[ti:${metadata.title}]`);
  if (metadata.artist) output.push(`[ar:${metadata.artist}]`);
  if (metadata.album) output.push(`[al:${metadata.album}]`);
  if (metadata.author || metadata.by) output.push(`[by:${metadata.author || metadata.by}]`);
  if (metadata.lyricist) output.push(`[au:${metadata.lyricist}]`);
  if (metadata.language) output.push(`[la:${metadata.language}]`);
  if (metadata.offset) output.push(`[offset:${metadata.offset}]`);
  if (metadata.copyright) output.push(`[re:${metadata.copyright}]`);
  if (durationMs) {
    const totalSecs = Math.round(durationMs / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    output.push(`[length:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}]`);
  }

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    let line = `[${msToLrc(c.startMs)}]`;
    const defaultAgent = (c.agent && c.agent.trim()) ? c.agent.trim() : 'v1';

    if (enhanced && c.words && c.words.length > 0) {
      const validWords = c.words.filter(w => (w.text || "").trim().length > 0 && w.text !== "\\");
      if (validWords.length > 0) {
        const runs = [];
        let curRun = null;
        for (let w of validWords) {
          const isBg = !!(w.isBackground || w.role === 'x-bg' || c.isBackground || c.role === 'x-bg');
          const agent = (w.agent && w.agent.trim()) ? w.agent.trim() : defaultAgent;
          const key = isBg ? 'bg' : agent;
          if (!curRun || curRun.key !== key) {
            curRun = { isBg, agent, key, words: [] };
            runs.push(curRun);
          }
          curRun.words.push(w);
        }

        const runStrs = runs.map(run => {
          if (run.isBg) {
            const inner = run.words.map(w => {
              const clean = (w.text || "").replace(/^\[?bg(?::|\])\s*/i, '').replace(/^\(/, '').replace(/\)$/, '').replace(/[\[\]]/g, '').trim();
              return `<${msToLrc(w.startMs)}>${clean}`;
            }).filter(Boolean).join(' ');
            const lastWord = run.words[run.words.length - 1];
            const endTag = (lastWord && lastWord.endMs && lastWord.endMs > lastWord.startMs) ? ` <${msToLrc(lastWord.endMs)}>` : '';
            return `[bg:${inner}${endTag}]`;
          } else {
            const inner = run.words.map(w => {
              const clean = (w.text || "").replace(/^\[?(v\d+|ch)(?::|\])\s*/i, '').replace(/[\[\]]/g, '').trim();
              return `<${msToLrc(w.startMs)}>${clean}`;
            }).filter(Boolean).join(' ');
            const lastWord = run.words[run.words.length - 1];
            const endTag = (lastWord && lastWord.endMs && lastWord.endMs > lastWord.startMs) ? ` <${msToLrc(lastWord.endMs)}>` : '';
            return `${run.agent}:${inner}${endTag}`;
          }
        });
        line += " " + runStrs.join(' ');
      } else if (c.text && c.text.trim()) {
        const isBg = !!(c.isBackground || c.role === 'x-bg');
        if (isBg) {
          const clean = c.text.replace(/^\(/, '').replace(/\)$/, '').trim();
          line += ` [bg:${clean}]`;
        } else {
          line += ` ${defaultAgent}:${c.text.trim()}`;
        }
      }
    } else if (c.text && c.text.trim()) {
      const isBg = !!(c.isBackground || c.role === 'x-bg');
      if (isBg) {
        const clean = c.text.replace(/^\(/, '').replace(/\)$/, '').trim();
        line += ` [bg:${clean}]`;
      } else {
        line += ` ${defaultAgent}:${c.text.trim()}`;
      }
    }
    output.push(line);

    // Add a blank line to clear the screen if there's a gap to the next cue or at the end
    const nextStart = (i < cues.length - 1) ? cues[i + 1].startMs : (durationMs || (c.endMs + 1000));
    if (autoEmpty && c.endMs < nextStart - 10) {
      output.push(`[${msToLrc(c.endMs)}]`);
    }
  }
  return output.join('\n');
}

function stringifySRT(cues, options = {}) {
  const metadata = options.metadata || {};
  let header = '';
  if (metadata.title || metadata.artist) {
    header = `NOTE Title: ${metadata.title || ''} Artist: ${metadata.artist || ''}\n\n`;
  }
  return header + cues.map((c, i) => {
    return `${i + 1}\n${msToSrt(c.startMs)} --> ${msToSrt(c.endMs)}\n${c.text || ""}\n`;
  }).join('\n') + '\n'; // Ensure trailing newline
}

function stringifyVTT(cues, karaoke, options = {}) {
  const metadata = options.metadata || {};
  let header = 'WEBVTT\n';
  if (metadata.title) header += `NOTE Title: ${metadata.title}\n`;
  if (metadata.artist) header += `NOTE Artist: ${metadata.artist}\n`;
  if (metadata.language) header += `NOTE Language: ${metadata.language}\n`;
  if (options.durationMs) header += `NOTE Duration: ${msToVtt(options.durationMs)}\n`;
  header += '\n';
  return header + cues.map(c => {
    let text = c.text || "";
    if (karaoke && c.words && c.words.length > 0) {
       text = c.words.map(w => `<${msToVtt(w.startMs)}>${w.text}`).join(' ');
    }
    if (c.isBackground) text = `(${text})`;
    return `${msToVtt(c.startMs)} --> ${msToVtt(c.endMs)}\n${text}\n`;
  }).join('\n') + '\n'; // Ensure trailing newline
}

// ── Exporters ──
function exportAs(cues, format, durationMs, options = {}) {
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

  const metadata = options.metadata || {};

  switch(format) {
    case 'lrc': return stringifyLRC(exportCues, false, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'lrc_enhanced': return stringifyLRC(exportCues, true, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'lrc_enhanced_testing': return stringifyLRCTesting(exportCues, true, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'srt': return stringifySRT(exportCues, {metadata});
    case 'vtt': return stringifyVTT(exportCues, false, {metadata, durationMs});
    case 'vtt_karaoke': return stringifyVTT(exportCues, true, {metadata, durationMs});
    case 'ttml': return stringifyTTML(exportCues, false, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'ttml_karaoke': return stringifyTTML(exportCues, true, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'apple_ttml': return stringifyAppleTTML(exportCues, false, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'apple_ttml_karaoke': return stringifyAppleTTML(exportCues, true, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'ttml_apple': return stringifyAppleTTML(exportCues, false, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'ttml_apple_karaoke': return stringifyAppleTTML(exportCues, true, durationMs, {autoEmptyLines: options.autoEmptyLines, metadata});
    case 'srv1': return stringifySRV1(exportCues);
    case 'srv2': return stringifySRV2(exportCues);
    case 'srv3': return stringifySRV3(exportCues);
    case 'srv3_karaoke': return stringifySRV3Karaoke(exportCues);
    case 'audacity_karaoke': return stringifyAudacity(exportCues, true);
    case 'json': return JSON.stringify({ 
      metadata: { title: metadata.title, artist: metadata.artist, album: metadata.album, language: metadata.language, duration_ms: durationMs, ...metadata },
      cues: exportCues.map(c => ({
        startMs: c.startMs,
        endMs: c.endMs,
        text: c.text,
        words: c.words ? c.words.map(w => ({
          text: w.text,
          startMs: w.startMs,
          endMs: w.endMs,
          ...(w.confidence !== undefined ? { confidence: w.confidence } : (w.score !== undefined ? { confidence: w.score } : {})),
          isBackground: !!(w.isBackground || w.role === 'x-bg'),
          role: w.role || null,
          agent: w.agent || null
        })) : null,
        isBackground: !!(c.isBackground || c.role === 'x-bg'),
        role: c.role || null,
        agent: c.agent || null,
        songPart: c.songPart || null
      }))
    }, null, 2);
    case 'json3': return stringifyJSON3(exportCues);
    case 'lyricsfile': return stringifyLyricsFile(exportCues, durationMs, {metadata});
    case 'lyricsfile_yaml': return stringifyLyricsFile(exportCues, durationMs, {metadata});
    case 'yaml': return stringifyLyricsFile(exportCues, durationMs, {metadata});
    case 'txt_parts': return stringifyTXT(exportCues, { ...options, metadata, includeSongParts: true });
    case 'txt_plain': return stringifyTXT(exportCues, { ...options, metadata, includeSongParts: false });
    case 'txt': return stringifyTXT(exportCues, { ...options, metadata, includeSongParts: options.includeSongParts !== undefined ? options.includeSongParts : false });
    case 'audacity': return stringifyAudacity(exportCues, false);
    default: return '';
  }
}

function stringifyLyricsFile(cues, durationMs, options = {}) {
  const metadata = options.metadata || {};
  let yaml = `version: "1.0"\nmetadata:\n`;
  yaml += `  title: "${(metadata.title || "").replace(/"/g, '\\"')}"\n`;
  yaml += `  artist: "${(metadata.artist || "").replace(/"/g, '\\"')}"\n`;
  yaml += `  album: "${(metadata.album || "").replace(/"/g, '\\"')}"\n`;
  yaml += `  language: "${(metadata.language || "en").replace(/"/g, '\\"')}"\n`;
  yaml += `  duration_ms: ${Math.round(durationMs || 0)}\n`;
  if (metadata.by) yaml += `  by: "${metadata.by.replace(/"/g, '\\"')}"\n`;
  yaml += `lines:\n`;
  cues.forEach(c => {
    const cleanText = c.text.replace(/\s+/g, ' ').trim();
    yaml += `  - text: "${cleanText.replace(/"/g, '\\"')}"\n`;
    yaml += `    words:\n`;
    if (c.words && c.words.length) {
      const validWords = c.words.filter(w => (w.text || "").trim().length > 0 && w.text !== "\\");
      if (validWords.length > 0) {
        validWords.forEach((w, i) => {
          let txt = w.text;
          if (i < validWords.length - 1 && !txt.endsWith(' ')) txt += ' ';
          yaml += `      - text: "${txt.replace(/"/g, '\\"')}"\n`;
          yaml += `        start_ms: ${Math.round(w.startMs)}\n`;
          if (w.endMs !== undefined && w.endMs !== null && w.endMs > w.startMs) {
            yaml += `        end_ms: ${Math.round(w.endMs)}\n`;
          }
          const conf = (w.confidence !== undefined && w.confidence !== null) ? w.confidence : w.score;
          if (conf !== undefined && conf !== null && !isNaN(conf)) {
            yaml += `        confidence: ${conf}\n`;
          }
          if (w.isBackground || w.role === 'x-bg') yaml += `        isBackground: true\n`;
          if (w.agent) yaml += `        agent: "${w.agent}"\n`;
        });
      } else {
        yaml += `      []\n`;
      }
    } else {
      yaml += `      []\n`;
    }
    yaml += `    start_ms: ${Math.round(c.startMs)}\n`;
    yaml += `    end_ms: ${Math.round(c.endMs)}\n`;
    if (c.isBackground || c.role === 'x-bg') yaml += `    isBackground: true\n`;
    if (c.agent) yaml += `    agent: "${c.agent}"\n`;
    if (c.songPart) yaml += `    songPart: "${c.songPart.replace(/"/g, '\\"')}"\n`;
  });
  yaml += `plain: |-\n`;
  cues.forEach(c => {
    const cleanText = c.text.replace(/\s+/g, ' ').trim();
    yaml += `    ${cleanText}\n`;
  });
  return yaml;
}

function stringifyAudacity(cues, karaoke) {
    let lines = [];
    cues.forEach(c => {
        if (karaoke && c.words && c.words.length > 0) {
            c.words.forEach(w => {
                const s = (w.startMs / 1000).toFixed(6);
                const e = (w.endMs / 1000).toFixed(6);
                const t = (w.text || "").replace(/\t/g, ' ').replace(/\n/g, ' ');
                lines.push(`${s}\t${e}\t${t}`);
            });
        } else {
            const s = (c.startMs / 1000).toFixed(6);
            const e = (c.endMs / 1000).toFixed(6);
            const t = (c.text || "").replace(/\t/g, ' ').replace(/\n/g, ' ');
            lines.push(`${s}\t${e}\t${t}`);
        }
    });
    return lines.join('\n') + '\n';
}

function parseAudacity(content) {
    const lines = content.trim().split(/\r?\n/);
    return lines.map((l, i) => {
        const parts = l.split('\t');
        if (parts.length < 2) return null;
        const start = parseFloat(parts[0]) * 1000;
        const end = parseFloat(parts[1]) * 1000;
        const text = (parts[2] || "").trim();
        return { id: i + 1, startMs: Math.round(start), endMs: Math.round(end), text, words: null };
    }).filter(c => c !== null);
}

function downloadFile(content, filename) {
  const b = new Blob([content], {type:'text/plain'}), u = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = u; a.download = filename; a.click();
  URL.revokeObjectURL(u);
}
