<div align="center">
  
# LyricsEditor - Premium Lyrics & Subtitle Tool

<img src="favicon.svg" width="80" height="80" alt="LyricsEditor Logo">

A professional-grade, browser-based word-level lyrics and subtitle editor. Designed for precision, efficiency, and broad format compatibility.

</div>

https://github.com/user-attachments/assets/2eed0d00-c213-4737-b9e3-c4cf02fc6884

## ✨ Features

- **Word-Level Precision**: Adjust timings for individual words using an intuitive drag-and-drop timeline.
- **Multi-Format Support**: Import and export a wide variety of subtitle and karaoke formats.
- **Advanced Timeline**:
    - Interactive waveform-style word blocks.
    - Drag edges to resize or drag the center to move words.
    - Automatic gap filling and overlapping prevention.
- **Smart Tools**:
    - **Global Tools**: Shift Time, Find & Replace, Remove Overlaps, Merge/Split Selected Lines, Sync Line to Words, Sort by Time.
    - **Word Tools**: Auto-Generate Word Timings, Fill Gaps, Remove Empty Words, Compact Whitespace, Clear Word Timings, Distribute Words Evenly.
    - **Text Formatting**: Change Case (Title, Sentence, Upper, Lower), Remove Punctuation.
    - **Hot Fix**: One-click cleanup (compact whitespace, remove empty words, fill gaps).
- **Visual Feedback**:
    - **Word-Block Highlighting**: Words illuminate in real-time as the playback cursor passes over them, ensuring perfect synchronization.
    - **Toggle Control**: Easily enable or disable the highlighting feature using the toggle button in the toolbar.
- **Playback & Editing**:
    - High-precision audio playback with granular seeking.
    - Line repeat mode for focused timing adjustments on a single line.
    - Progress bar seeking and volume control (with shortcut support).
- **Professional UI**:
    - Dark mode by default with a premium aesthetic.
    - Responsive layout (works on tablets and desktops).
    - Compact and Default view modes.
    - Fullscreen support.
- **Workspace Management**:
    - **Add New Line**: Quick insertion button directly in the timeline header.
    - **Clear All**: One-click cleanup to start a new project from scratch.
    - **Asset Eject/Reload**: Easily remove or re-load audio and lyrics files.
    - **Smart Tooltips**: Full filename display on hover for easy identification.
- **Session Persistence**:
    - **Auto-Save**: Progress is automatically saved to local storage.
    - **True Persistence**: Uses **IndexedDB** to store audio and lyrics references, allowing for instant project restoration even after a page refresh (F5) without re-browsing files.
    - **Session Reset**: Clear your workspace and cache with a single "Reset Session" button.
- **Export Configuration**:
    - **Toggle Empty Lines**: Optional automatic insertion of empty "clear screen" lines in LRC and TTML exports to match the editor's visual state.
- **Undo/Redo**: Full history support for all editing actions, including file loading and removal (up to 50 steps).

![LyricsEditor Screenshot](screenshot.png)

## 📥 Supported Formats

### Import
- LRC (Standard & Enhanced)
- SRT (SubRip)
- VTT (WebVTT)
- TTML (Timed Text Markup Language)
- YouTube XML (SRV1, SRV2, SRV3)
- YouTube JSON3
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
| `N` | Add New Line |
| `Delete` | Delete Selected Lines |
| `R` | Toggle Repeat (Loop current line) |
| `M` | Mute / Unmute |
| `E` | Quick Export (uses same format as imported) |
| `F` | Focus Search Box |
| `G` | Find & Replace |
| `T` | Shift Time... |
| `K` | Keyboard Shortcuts Info |
| `L` | Toggle Fullscreen |
| `Esc` | Close Modal / Blur Search |
| `H` | Hot Fix (Cleanup lyrics) |
| `D` | Default View Mode |
| `C` | Compact View Mode |
| `Up` / `Down` | Jump to Previous / Next Line |
| `Left` / `Right` | Seek Backward / Forward (2 seconds) |
| `Ctrl/Cmd + Up` / `Down` | Volume Up / Down |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` / `Y` | Redo |
| `[` / `{` | Shift Time -100ms |
| `]` / `}` | Shift Time +100ms |
| `Ctrl/Cmd + [` | Shift Time -500ms |
| `Ctrl/Cmd + ]` | Shift Time +500ms |

---

## 🔌 Offline Mode Setup

To use LyricsEditor without an internet connection, you need to localize external dependencies:

### 1. Download Font Awesome 6.7.2
1. Download the **Font Awesome Free for Web** version `6.7.2` [here](https://fontawesome.com/download).
2. Extract the archive and copy the `css` and `webfonts` folders into your project directory (e.g., into a folder named `lib/font-awesome`).
3. Update the link in `index.html`:
   ```diff
   - <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
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
- **Persistence**: Implements a dual-storage system:
    - **LocalStorage**: Stores text metadata, editing lines, and UI preferences.
    - **IndexedDB**: Persists large binary assets (Audio & Lyrics files) to allow instant re-loading without server-side storage.
- **Privacy & Security**: 100% Client-Side. No data is ever uploaded to a server. All processing and storage happen locally within your browser's private sandbox.

## 📄 License

MIT License
