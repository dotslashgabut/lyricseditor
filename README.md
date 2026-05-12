<div align="center">
  
# LyricsEditor - Premium Lyrics & Subtitle Tool

<img src="favicon.svg" width="80" height="80" alt="LyricsEditor Logo">

A professional-grade, browser-based word-level lyrics and subtitle editor. Designed for precision, efficiency, and broad format compatibility.

</div>

![LyricsEditor Screenshot](screenshot.png)

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
    - **Drag & Drop**: Seamlessly load audio or lyrics files by dragging them anywhere into the editor.
    - **Add New Line**: Quick insertion button directly in the timeline header.
    - **Delete Selected**: Mass-deletion of checked lines for faster cleanup.
    - **Clear All**: One-click cleanup to reset the entire timeline.
    - **Asset Eject/Reload**: Easily remove or re-load audio and lyrics files.
    - **Smart Tooltips**: Full filename display on hover for easy identification.
    - **Improved Line Editing**: Automatic whitespace and newline normalization when editing text to ensure a clean, one-line structure.
- **Session Persistence**:
    - **Auto-Save**: Progress is automatically saved to local storage.
    - **True Persistence**: Uses **IndexedDB** to store audio and lyrics references, allowing for instant project restoration even after a page refresh (F5) without re-browsing files.
    - **Session Reset**: Clear your workspace and cache with a single "Reset Session" button.
- **Export Configuration**:
    - **Toggle Empty Lines**: Optional automatic insertion of empty "clear screen" lines in LRC and TTML exports to match the editor's visual state.
- **Undo/Redo**: Full history support for all editing actions, including file loading and removal (up to 50 steps).

| | |
|:-:|:-:|
| ![screenshot1](https://github.com/user-attachments/assets/702b5201-a5ec-46b4-b5d1-4ae86ab47761) | ![screenshot2](https://github.com/user-attachments/assets/82583a9a-a04c-45de-bad5-d7efea0b9929) |
| ![screenshot3](https://github.com/user-attachments/assets/ade078b0-a961-469c-a319-0e526cfc9854) | ![screenshot4](https://github.com/user-attachments/assets/d506e9bf-3961-4de9-a63a-6d4e908e7957) |

https://github.com/user-attachments/assets/2eed0d00-c213-4737-b9e3-c4cf02fc6884

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

## 🎵 Audio Precision & Sync

For professional, high-precision work, please consider the following:

- **Format Choice**: Use **WAV** or **FLAC** whenever possible for sample-accurate synchronization.
- **MP3 Limitations**: Standard MP3s may have encoder padding (silence) at the start, causing offsets.
- **Global & Partial Shift**: Use the **`[`** and **`]`** keys (or the UI buttons) to shift timings. If lines are selected, only those will be shifted.
- **Flexible Step**: Adjust the millisecond value in the shift input to control how much time is shifted per click.

## ⌨️ Keyboard Shortcuts

### Playback & Volume
| Shortcut | Action |
| :--- | :--- |
| **Space** | Play / Pause Audio |
| **S** | Stop Audio (Reset to start) |
| **R** | Toggle Line Repeat (Loop current line) |
| **M** | Mute / Unmute Audio |
| **Ctrl + Up / Down** | Increase / Decrease Volume |
| **Left / Right** | Seek Audio (-2s / +2s) |

### Editing & Selection
| Shortcut | Action |
| :--- | :--- |
| **N** | Insert New Blank Line |
| **Delete** | Delete Selected Lines |
| **Up / Down** | Select Previous / Next Line |
| **Ctrl + Z / Y** | Undo / Redo Changes |
| **[ / ]** | Shift Time Backward / Forward (100ms) |
| **Ctrl + [ / ]** | Shift Time (Large Step: 500ms) |

### Tools & UI
| Shortcut | Action |
| :--- | :--- |
| **1 / 2** | Load Audio / Load Lyrics |
| **E** | **Quick Export** (Prioritizes Word-Level/Karaoke formats) |
| **F** | Focus Search Box |
| **G** | Open Find & Replace |
| **T** | Open Global Time Shift modal |
| **H** | **Hot Fix** (One-click cleanup: compact, remove empty, fill gaps) |
| **D / C** | Default View / Compact View Mode |
| **L** | Toggle Fullscreen |
| **K** | Open Keyboard Shortcuts help |
| **Esc** | Close Modals / Clear Search focus |

## 🌟 What's New

- **Flexible Shift Control**: Added a new UI widget to shift time by custom millisecond amounts. Now supports shifting only selected lines or the whole timeline.
- **Improved Search UI**: Moved the search box to the timeline header for better focus. Added a minimal "x" button to clear filters instantly.
- **Safe Drag & Drop**: Refined the loading logic to prevent accidental file overwrites and limit drops to 1 audio + 1 lyrics file at a time.
- **Selection Feedback**: Added a live count of selected lines to the "Select All" label and implemented the indeterminate checkbox state.
- **Tablet-First Optimization**: Increased the mobile breakpoint to `1024px` to provide full "Icon-Only" support for iPad Air, iPad Pro (portrait), Surface Pro, and other mid-sized tablets.
- **Branded Logo Integration**: Replaced generic icons with the official `favicon.svg`, featuring a premium orange glow effect for better brand identity.
- **Global Icon-Only Mode**: Extended the smart icon transformation to the primary **Export** button and **App Logo**, ensuring zero layout overflow on narrow screens.
- **Zero-Overflow Header**: Grouped filenames and navigation controls ergonomically. Implemented thumb-friendly top-row navigation for arrows and dynamic filename widths (200px on desktop, 100px on mobile).
- **Track-Level Play/Stop Toggle**: Play buttons in the timeline rows now act as dynamic toggles (switching to a Stop icon when active) for faster playback control.
- **Auto-Scroll Navigation**: The Up/Down navigation buttons now automatically scroll and center the active lyrics line in view, even when paused.
- **UI structural Integrity**: Wrapped all button labels in spans to ensure robust responsive behavior and clean layout resets.
- **UI Polish**: Added "Pro Tips" for audio precision and improved the placeholder instructions for new users.

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
