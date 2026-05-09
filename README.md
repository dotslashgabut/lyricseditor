<div align="center">
  
# LyricsEditor - Premium Lyrics & Subtitle Tool

A professional-grade, browser-based word-level lyrics and subtitle editor. Designed for precision, efficiency, and broad format compatibility.

<img src="favicon.svg" width="80" height="80" alt="LyricsEditor Logo">

</div>

## ✨ Features

- **Word-Level Precision**: Adjust timings for individual words using an intuitive drag-and-drop timeline.
- **Multi-Format Support**: Import and export a wide variety of subtitle and karaoke formats.
- **Advanced Timeline**:
    - Interactive waveform-style word blocks.
    - Drag edges to resize or drag the center to move words.
    - Automatic gap filling and overlapping prevention.
- **Smart Tools**:
    - **Shift Time**: Offset all or selected timestamps (forward/backward).
    - **Find & Replace**: Bulk edit text across lines.
    - **Auto-Karaoke**: Automatically distribute word timings for a line.
    - **Hot Fix**: One-click cleanup (compact whitespace, remove empty words, fill gaps).
- **Playback Controls**:
    - High-precision audio playback.
    - Line repeat mode for focused editing.
    - Progress bar seeking and volume control.
- **Professional UI**:
    - Dark mode by default with a premium aesthetic.
    - Responsive layout (works on tablets and desktops).
    - Compact and Default view modes.
    - Fullscreen support.
- **Undo/Redo**: Full history support for all editing actions (up to 50 steps).

## 📥 Supported Formats

### Import
- LRC (Standard & Enhanced)
- SRT (SubRip)
- VTT (WebVTT)
- TTML (Timed Text Markup Language)
- YouTube JSON/SRV
- LRCLIB (.lyricsfile)
- Plain Text (.txt)

### Export
- **Subtitles**: LRC, SRT, VTT, TTML
- **Karaoke (Word-Level)**: Enhanced LRC, VTT (Words), TTML (Words), YouTube SRV3 (Words)
- **Other**: YouTube SRV1/SRV2/SRV3, JSON, YouTube JSON3, LRCLIB, Plain Text

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `1` | Load Audio File |
| `2` | Load Lyrics File |
| `Space` | Play / Pause |
| `S` | Stop |
| `R` | Toggle Repeat (Loop current line) |
| `M` | Mute / Unmute |
| `E` | Quick Export (uses the same format as imported) |
| `F` | Focus Search Box |
| `H` | Hot Fix (Cleanup lyrics) |
| `D` | Default View Mode |
| `C` | Compact View Mode |
| `Up` / `Down` | Jump to Previous / Next Line |
| `Left` / `Right` | Seek Backward / Forward (2 seconds) |
| `Ctrl + Up` / `Down` | Volume Up / Down |
| `Ctrl + Z` | Undo |
| `Ctrl + Shift + Z` / `Ctrl + Y` | Redo |
| `[` / `{` | Global Shift Backward (-100ms) |
| `]` / `}` | Global Shift Forward (+100ms) |

---

## 🔌 Offline Mode Setup

To use LyricsEditor without an internet connection, you need to localize external dependencies:

### 1. Download Font Awesome 6.4.0
1. Download the **Font Awesome Free for Web** version `6.4.0` [here](https://fontawesome.com/download).
2. Extract the archive and copy the `css` and `webfonts` folders into your project directory (e.g., into a folder named `lib/font-awesome`).
3. Update the link in `index.html`:
   ```diff
   - <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
   + <link rel="stylesheet" href="lib/font-awesome/css/all.min.css">
   ```

### 2. Localize Fonts (Optional)
The app uses the "Inter" font from Google Fonts. For full offline support:
1. Download "Inter" from [Google Fonts](https://fonts.google.com/specimen/Inter).
2. Install it on your system or host it locally using `@font-face` in `styles.css`.
3. Alternatively, remove the Google Fonts link in `index.html` to use system default sans-serif fonts.

### 3. Run Locally
Once the files are downloaded, you can simply open `index.html` in any modern web browser. No local server is required.

---

## 🛠️ Technical Details

- **Framework**: No framework (Vanilla JS).
- **Precision**: Uses `requestAnimationFrame` for high-precision synchronization between audio and UI.
- **Storage**: No data is uploaded to any server. All processing happens locally in your browser.

## 📄 License

MIT License
