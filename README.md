# 📁 Smart PDF Triage Dashboard

> **AI-Powered PDF Classification, Entity Extraction & Folder Sorting System**

An intelligent, privacy-first PDF classification, entity extraction, and automated document sorting system powered by local AI (**Qwen 3.5 via Ollama**).

---

## ⚙️ How the Application Mechanism Works

```mermaid
flowchart TD
    A[📥 Drop PDF or photo into input_dir] --> B[⏱️ 10s Auto-Scan Watcher Detects File]
    B -->|📷 Photo| P["🖼️ Vision Pipeline: orient → crop → enhance → OCR"]
    P --> Q[📄 Archivable A4 PDF + extracted text]
    B -->|📄 PDF| C[📄 3-Tier Text Extraction & SHA256 Checksum]
    C -->|Tier 1: Digital PDF| D[pdf-parse Stream]
    C -->|Tier 2: Corrupted XRef| E[pdfjs-dist Repair]
    C -->|Tier 3: Scanned / Vector PDF| F["Canvas Render + PaddleOCR (Tesseract fallback)"]
    D & E & F & Q --> G[🧠 Local Qwen 3.5 AI / Rule Classifier]
    G --> H[🔍 Grounding Verification Check]
    H -->|✅ Valid & Grounded Entity| I[💾 Auto-Register Subcategory in .categories.private.json]
    H -->|❌ Ungrounded or Generic| J[📁 Move to input_dir/.blocked_files]
    H -->|🔁 Duplicate Checksum| K[📂 Move to input_dir/.duplicates_files]
    I --> L[📁 Move PDF to output_root_dir/category/subcategory/YYYY/]
    L --> M[🧹 Auto-Clean Empty Input Subfolders]
    M --> N[📊 Live SSE Broadcast to Dashboard UI]
```

### 1. Automated Background Monitoring
The backend runs a **10-second non-blocking auto-scan watcher** monitoring your `input_dir` (e.g. `./input` or `__raws`). Any new PDF **or photo** dropped into the input folder is detected automatically — phone photos of documents (`.jpg`, `.png`, `.webp`, `.bmp`, `.tiff`) are converted to PDFs before triage (see below).

### 2. 3-Tiered PDF Extraction & Fallback Pipeline
- **Tier 1 — Standard PDF Parse**: Fast text stream extraction for native digital PDFs.
- **Tier 2 — `pdfjs-dist` Stream Repair**: Automatically repairs corrupted cross-reference tables (`bad XRef entry`) from web portal downloads.
- **Tier 3 — High-Fidelity Canvas Rasterization & OCR**: Renders full PDF pages onto an in-memory 2D Canvas via `@napi-rs/canvas` and runs offline OCR — **PaddleOCR** first (materially better on real scanned and photographed documents), falling back to **Tesseract.js** only when the local PaddleOCR service is unreachable. Captures vector path PDFs (e.g. Tax Notices & Government Statements), sliced image strips, scanned passports, and paper receipts without memory errors.

### 2b. Photo → Archivable PDF (Vision Pipeline)
A photographed document is not an archivable document, so photos are converted before they ever reach the classifier:

1. **Orient** — corrects rotation from EXIF-normalized pixels, using PaddleOCR's document-orientation classifier with the vision model as backup.
2. **Crop** — detects the page against its background and crops the desk away. If the document already fills the frame (scans, close-ups, re-runs), the crop is **vetoed** rather than cutting into the page.
3. **Enhance** — auto-levels and sharpening, used **only** to help OCR read the page.
4. **Extract** — OCR + markdown conversion.

The archived PDF holds the **cropped, natural-toned** page (not the enhanced one, whose hard contrast can crush faint stamps and signatures), fitted to A4. Every stage degrades safely — a failed crop still yields an upright PDF, a failed OCR still archives the page.

**Your original photo is never deleted.** Once the PDF is confirmed on disk, the source moves to `__raws/.delete_files/img_converted/` rather than being unlinked: the PDF holds a cropped, re-encoded rendition, so if the crop detector ever clips part of a page the untouched original is the only way back. Nothing prunes that folder — it grows until you clear it.

**Multi-page documents: drop a folder.** A folder in `__raws` holding only photos (2 or more) is bundled into **one** multi-page PDF named after the folder, instead of becoming several unrelated one-page documents:

```
__raws/
  contrat-bail/          →  contrat-bail.pdf   (3 pages, one document)
    IMG_1.jpg
    IMG_2.jpg
    IMG_3.jpg
  facture-edf.jpg        →  facture-edf.pdf    (1 page, as before)
```

Pages are ordered numerically, so `IMG_2` comes before `IMG_10` — plain alphabetical sorting silently shuffles any document with ten or more photos. Each page's OCR text is concatenated so the classifier reads the whole document at once, and the source pages stay grouped under `.delete_files/img_converted/contrat-bail/`.

A folder qualifies only if it holds **2+ images and nothing else**. A lone photo isn't a multi-page document, and a folder where you also keep a PDF is storage you're using — fusing its photos would be a destructive guess, so it's left alone and triaged file by file.

### 3. Duplicate & Blocked File Relocation
- **Duplicates**: Files matching existing database checksums are safely relocated to `input_dir/.duplicates_files/` with automatic collision handling (`filename_dup1.pdf`).
- **Blocked Files**: Files failing taxonomy rules or without extractable text are safely moved to `input_dir/.blocked_files/` for user inspection.
- **Folder Cleanup**: `cleanEmptyDirectories` automatically prunes empty input subfolders after processing using Windows-safe file lock retries.

### 4. Intelligent Automatic Document Renaming
When a document has a generic or unhelpful input filename (e.g. `QPtmp001.PDF`, `invoice (8).pdf`, `scan_001.pdf`, `13320220423-recap.pdf`, or random hashes), the system automatically renames it using extracted AI metadata into a standardized human-readable format:
```text
YYYY-MM-DD_EntityName_CleanTitle.pdf
```
*Example: `QPtmp001.PDF` $\rightarrow$ `2023-07-31_AcmeCorp_Pay_Slip_July.pdf`*

### 5. Modular Local AI Pipeline (Qwen 3.5 via Ollama)
Rather than one giant prompt trying to do everything at once, each document runs through three focused local-model passes:
- **Step A — Entity Extraction**: a narrow, dedicated pass identifies the issuing entity and document type first, more reliably than hoping a single freeform call gets both the entity *and* the category right.
- **Step B — Zero-Loss Markdown Conversion**: raw extracted text is chunked and converted into clean, structured GFM Markdown (headers, tables) — this becomes the document's `markdown_content`, used for display, search, and export.
- **Step C — Classification**: the converted Markdown, plus Step A's entity as a grounded hint, drives the final category/subcategory/summary/metadata decision.

### 6. Dynamic Auto-Registration & Fail Guard
- **Public/Private Taxonomy Split**: `categories.json` (committed, generic starter categories) stays clean and shareable; every category/subcategory actually auto-created from *your* documents (real bank branches, employers, etc.) is written to `.categories.private.json` instead — gitignored, never leaves your machine if you fork or publish your own copy of this project.
- **Pre-Move Auto-Creation**: a new valid subcategory slug is registered BEFORE moving the file.
- **Strict Fail Guard**: if a document fails to resolve to a grounded, specific subcategory (e.g. receives `general` or ungrounded gibberish), it is moved to `.blocked_files/` — preventing generic folder clutter.

### 7. Physical Folder Filing & Real-Time Sync
Accepted PDFs are moved to canonical folder paths on disk:
```text
output_root_dir/category/subcategory/YYYY/filename.pdf
```
The SQLite FTS5 database (configured with WAL mode for non-blocking concurrent reads) and `registry.json` are updated in real-time, broadcasting live Server-Sent Events (SSE) to your browser dashboard.

### 8. Interactive HTML5 Web PDF Reader (`public/viewer.html`)
Clicking **`🌐 Open`** on document cards or **`🌐 Open in Chrome`** in the Grand Viewer launches a dedicated, full-screen Web PDF Reader tab powered by **Mozilla PDF.js**. PDF pages render cleanly on HTML5 canvas elements in dark mode without triggering browser "Save As" download prompts.

---

## 📥 How to Input Documents for Triage

### Method A: Drop Files into Input Folder (Automatic)
1. Copy or drop any PDF files (or nested subfolders containing PDFs) into your configured input directory (e.g. `./input` or `__raws`).
2. The background watcher detects them within 10 seconds, parses their text, classifies them, and moves them to `./organized` (`__archive`).

### Method B: Manual Scan Trigger from Dashboard
1. Open the Web Dashboard at `http://localhost:3971`.
2. Click **⚡ Scan & Triage PDFs** in the top navigation bar to trigger an instant triage scan across all unindexed files in your input directory.

---

## 📊 How to Open & Use the Web Dashboard

### 1. Launch the Server
Ensure Ollama is running, then start the web server in your terminal:
```bash
npm run dev
```

> **OCR service**: text recognition uses a small local **PaddleOCR** service (`paddleocr-server/`, Python + FastAPI on port `8871`). The app **auto-spawns it** on first use, so there is usually nothing to do — see [`paddleocr-server/README.md`](paddleocr-server/README.md) for the one-time dependency install. If Python or the dependencies are missing, OCR silently falls back to the bundled `Tesseract.js`, so the app keeps working with slightly lower text quality.

### 2. Open the Dashboard in Browser
Navigate to **`http://localhost:3971`** in Google Chrome, Microsoft Edge, Firefox, or Safari.

### 3. Interactive Dashboard Features

- 📂 **Category & Subcategory Pills**: Click any category pill (e.g. `Sales Invoices`, `Pay Slips`, `Identity & Legal`) or subcategory pill to instantly filter your document grid. Easily remove unused categories with zero documents using the interactive `❌` action buttons.
- 🌐 **Web PDF Reader**: Click **`🌐 Open`** on any document card to open a full-screen HTML5 canvas viewer tab powered by Mozilla PDF.js.
- 🔍 **Instant Full-Text Search (FTS5)**: Type keywords, reference numbers, or text content into the search bar to search across titles, summaries, tags, and raw PDF text in milliseconds.
- 📍 **📍 Relocalize & AI Feedback Button**:
  - Click **📍 Relocalize** on any document card to open the interactive modal.
  - Re-assign the category/subcategory, rename/edit subcategories, or select structured error reasons (*"Wrong Employer Name"*, *"Tax misclassified as Invoice"*) to teach and refine the local AI classifier.
- 📂 **Open Physical Explorer Folder**: Click **📂 Open Folder** on any document card to open Windows Explorer / OS File Manager directly at the exact PDF path on your computer.
- 💬 **AI Chat Assistant**: Ask questions in plain language ("my last 3 pay slips", "any documents from URSSAF this year?") and get answers grounded in your own indexed archive — runs entirely through the local Ollama model, nothing sent to the cloud.
- 📝 **Markdown Export**: Download any single document's converted Markdown as a `.md` file from the Grand Viewer, or export every indexed document's Markdown at once as a ZIP.
- 📊 **Group by Document Session**: The Logs modal groups every log line by the document that produced it, so you can see exactly what happened (extraction → entity → classification → filing) for one specific file.
- 🔧 **System Tools**:
  - **⚡ Scan & Triage PDFs**: Run immediate scan (with a live Stop button while it's running).
  - **🔧 Repair Registry**: Re-verify archive files and sync database.
  - **🗑️ Clear Registry**: Reset document records and return archive PDFs to input directory.
  - **⚙️ System Config**: Adjust input/output paths, language options (English / French), Ollama model hosts, and manage categories/subcategories.

### 4. MCP Server — Connect External AI Agents

`npm run mcp` starts a stdio-based [Model Context Protocol](https://modelcontextprotocol.io) server exposing your document registry as tools: `search_documents`, `get_full_document_text`, `update_document_metadata`, `trigger_triage`, `list_categories`, `prepare_dossier`. Point Claude Desktop (or any other MCP-capable client) at it to query and reason over your archive directly — your documents never leave your machine; only the MCP client's own queries and the tool results cross that boundary, and both stay local since the tool itself runs locally.

---

## 🌟 Key Features

- 🧠 **100% Local AI Classification**: Runs locally using Ollama (`qwen3.5:9b`). Zero document data sent to external cloud APIs.
- 📐 **Modular TypeScript Frontend Architecture**: Clean, strongly-typed factory class design (`public/ts/`) compiled into standard browser scripts (`public/js/`).
- 📄 **HTML5 Canvas Web PDF Reader**: Embedded Mozilla PDF.js viewer page (`viewer.html`) for instant, high-definition inline page viewing without download dialogs.
- 🌐 **Multi-Language Support (EN & FR)**: Full internationalization for English and French UI labels, category display names, and AI prompt outputs.
- ✏️ **Intelligent Automatic Document Renaming**: Converts generic scanner dumps and temporary files (e.g. `QPtmp001.PDF`) into standardized, descriptive filenames (e.g. `2023-07-31_AcmeCorp_Pay_Slip_July.pdf`).
- 🖼️ **Full-Page Canvas Rasterization & Offline OCR**: Automatically extracts text from scanned photos, passports, sliced images, and vector path PDFs using `@napi-rs/canvas` with **PaddleOCR** (offline, `Tesseract.js` fallback).
- 📷 **Phone Photos Become PDFs**: Drop a photo of a document and it is auto-oriented, cropped to the page, OCR'd and filed as a clean single-page A4 PDF alongside your other documents.
- 🏢 **Multi-Tenant & Generic Architecture**: Built for Individuals, Families, Freelancers, SMBs, and Enterprise Corporations. Zero hardcoded personal names.
- 🧾 **Dual Invoice Triage**: Automatically distinguishes between **Client Sales Invoices** (`factures_clients`) and **Supplier Purchase Invoices** (`invoices`).
- 💳 **Payment Status Tracking**: Automatically extracts payment signals and tags invoices as `PAID` or `UNPAID / PENDING`.
- 🏦 **Dedicated Banking & Statements Category (`bank`)**: Cleanly separates Bank Statements (Crédit Mutuel, Société Générale, BNP Paribas, BoursoBank, LCL, La Banque Postale, PayPal) into a dedicated top-level category out of `administrative`.
- 🪪 **Identity & Legal Document Sorting**: Intelligent routing for Residence Permits, Passports, ID Cards, Tax Notices, and Pay Slips.
- ⚡ **High Performance Grid**: SQLite WAL mode + lightweight 300-char preview snippets for 100x faster API response times and instant 0ms reader modal feedback.
- 🛡️ **Strict Fail Guard & Duplicate Relocation**: Automatically separates duplicates (`.duplicates_files/`) and unclassified files (`.blocked_files/`), keeping input directories completely clean.
- 💬 **Local AI Chat Assistant**: Query your own document registry in natural language, answered by the local model.
- 🔌 **MCP Server**: Exposes your archive to any MCP-capable AI agent (Claude Desktop and others) via `search_documents`, `get_full_document_text`, `update_document_metadata`, `trigger_triage`, `list_categories`, `prepare_dossier`.
- 📝 **Markdown Export**: Per-document `.md` download, or a one-click ZIP of every document's converted Markdown.
- 🔒 **Locked to localhost by default**: the web server binds to `127.0.0.1` only and has no wide-open CORS — reachable from your machine, not your network, unless you explicitly opt in via `PDF_TRIAGE_HOST`.

---

## 🔐 Privacy & Security

This project exists because sending ID cards, bank statements, and tax records to a third-party cloud API wasn't an option. A few concrete things that back that up, not just marketing copy:

- **Every AI call stays local.** Classification, entity extraction, embeddings, and the chat assistant all run through your own local Ollama instance. Nothing about a document's content is ever sent anywhere else.
- **No auth, so it's locked to your machine instead.** The dashboard has no login system — rather than build one, it binds to `127.0.0.1` only and ships with no CORS headers, so it's not reachable from your network or from other tabs in your browser. This is deliberate: for a single-user local tool, "not reachable at all" is a stronger guarantee than "reachable but password-protected."
- **Personal taxonomy stays out of git.** If you fork this repo for your own use, every category/subcategory your documents actually create goes to `.categories.private.json` (gitignored) — the committed `categories.json` never picks up your real bank branches, employers, or any other entity extracted from your documents.
- **So do your classification prompts.** The files in `prompts/` are committed and deliberately generic. Anything that identifies you — your bank's statement filename codes, your employers, your scanner's filename prefix, your clinic — lives in `.prompts.private.json` (gitignored), injected into the prompt at build time and matched by the offline fallback classifier from that same file, so the two never drift apart. A test (`src/domain/prompt-hygiene.test.ts`) fails the build if a name from your denylist reappears anywhere in the committed tree.
- **No telemetry, no update pings, no analytics.** The only network calls this app makes are to your own local Ollama instance.

If you do want to expose the dashboard beyond your own machine (e.g. to reach it from your phone on the same network), that's an explicit opt-in via `PDF_TRIAGE_HOST` in `.env` — and worth knowing there's still no authentication layer if you do.

---

## 🛠️ Technology Stack

- **Core Engine**: TypeScript, Node.js, Express
- **Frontend Architecture**: Modular TypeScript (`public/ts/`) compiled to Vanilla JS (`public/js/`), SCSS compiled to `style.css`, Mozilla PDF.js Reader (`viewer.html`), `marked` (vendored locally, not loaded from a CDN)
- **AI / LLM**: Ollama (`qwen3.5:9b`), Local Embeddings (`nomic-embed-text`)
- **Agent Integration**: Model Context Protocol server (`@modelcontextprotocol/sdk`)
- **Database**: SQLite3 with WAL Mode & FTS5 Full-Text Search
- **PDF Extraction**: `pdf-parse`, `pdfjs-dist`, `@napi-rs/canvas`, **PaddleOCR** (offline, local FastAPI service) with `Tesseract.js` fallback
- **Photo → PDF**: `pdf-lib` + `@napi-rs/canvas` (orientation, crop, enhancement)
- **Desktop Shell**: Electron, Electron-Builder
- **Testing & Build**: Vitest, ESBuild, TypeScript Compiler (`tsc`)

---

## 🚀 Quick Start

### 💻 System Requirements

Smart PDF Triage runs 100% locally on your computer using Node.js, Electron, SQLite, `@napi-rs/canvas`, **PaddleOCR** and `Tesseract.js` (both offline OCR), and local AI LLMs via **Ollama**.

#### 🔹 Minimum System Requirements (CPU-only Ollama)
| Component | Requirement |
| :--- | :--- |
| **Operating System** | Windows 10/11 (64-bit), macOS 11+, or Linux (Ubuntu 20.04+) |
| **CPU** | Quad-Core x86-64 / ARM processor (with AVX2 support) |
| **System RAM** | **16 GB** — the 9.7B model needs ~6.6 GB of it when Ollama has no GPU, on top of ~1.5 GB for the app's own processes |
| **Graphics (GPU)** | None — Ollama falls back to CPU. Expect classification to go from seconds to minutes per document. |
| **Free Storage** | **12 GB** (see the breakdown below) |
| **Python** *(optional)* | 3.10+ — powers the local PaddleOCR service. Without it the app falls back to `Tesseract.js` automatically, at a real cost in OCR quality. |

#### 🚀 Recommended System Requirements (GPU accelerated)
| Component | Requirement |
| :--- | :--- |
| **Operating System** | Windows 11 (64-bit) or macOS Apple Silicon (M1/M2/M3) |
| **CPU** | 8-Core or better. OCR is the throughput bottleneck and runs **on CPU** — the GPU does not accelerate it. |
| **System RAM** | **16 GB** or higher |
| **Graphics (GPU)** | NVIDIA GPU with **8 GB VRAM** (CUDA) or Apple Silicon Unified Memory |
| **Free Storage** | **20 GB+** NVMe SSD, plus room for your archived documents |

> ⚠️ **8 GB VRAM is the real floor, not 6 GB.** `qwen3.5:9b` is 6.6 GB resident and the app runs it
> at `num_ctx: 16384`. Measured on an RTX 3060 Ti (8 GB): the model loads at **100% GPU** and leaves
> **582 MB free** — it fits, but only just. On a 6 GB card Ollama offloads layers to CPU and
> classification slows by roughly an order of magnitude. Anything else competing for VRAM (a game, a
> video call, a second model) causes the same demotion.

#### 💾 Storage breakdown (measured)

| Item | Size | |
| :--- | ---: | :--- |
| `qwen3.5:9b` (Ollama) | 6.6 GB | required |
| `minicpm-v4.6` (Ollama vision) | 1.6 GB | photo pipeline only — the orientation/crop cascade falls back to EXIF, PaddleOCR orientation and flood-fill crop without it |
| `node_modules/` | 0.9 GB | |
| Python OCR deps (`paddlepaddle`, `opencv`, `numpy`) | 0.5 GB | only with the PaddleOCR service |
| PaddleOCR model cache (`~/.paddlex`) | 0.2 GB | downloaded on first OCR request |
| SQLite DB + JSON registry | **≈158 KB per document** | 139 documents measured at 21.5 MB |
| `logs/triage_debug.log` | grows unbounded | no rotation — prune it yourself |

**≈ 9.8 GB** for a full install before you archive a single document. The archive itself is your own
PDFs, wherever `settings.json` points.

#### ⏱️ Measured throughput

On the reference machine (20 cores, RTX 3060 Ti, PaddleOCR on CPU): **58 documents in 119 minutes**,
about **2 minutes per document**. The split matters more than the average:

| Document type | Share | Time each | Bound by |
| :--- | ---: | :--- | :--- |
| Digital text layer | 63% | 30–60 s | Ollama (GPU) |
| Needs OCR (scans, photos) | 37% | 120–230 s | **PaddleOCR (CPU)** |

So adding VRAM speeds up the fast half; adding CPU cores speeds up the slow half.

> 💡 **The model is not configurable.** Setting `ollama_model` in `settings.json` to anything other
> than `qwen3.5:9b` is **ignored** — `sanitizeOllamaModel()` logs a warning and forces it back, per
> Golden Rule #14. A lighter model is not a supported way to fit a smaller machine; use CPU mode and
> more RAM instead.

---

### 1. Prerequisites
- **Node.js v22.12+** installed (required by the Electron version this project bundles; the web dashboard itself has no hard Node version requirement if you're not using the desktop shell).
- **Ollama** installed locally ([ollama.com](https://ollama.com)).
- Pull the classifier (required — this exact tag, see Golden Rule #14):
  ```bash
  ollama pull qwen3.5:9b
  ```
- Pull the vision model (optional, 1.6 GB — only used by the photo pipeline's orientation and crop
  cascade, which falls back to EXIF, PaddleOCR orientation and flood-fill crop without it):
  ```bash
  ollama pull minicpm-v4.6
  ```
- **Optional, only if you plan to build the desktop `.exe`**: Visual Studio Build Tools with the "Desktop development with C++" workload (Windows). The desktop build compiles `sqlite3`'s native binding against Electron's own Node ABI, which needs a C++ toolchain available. Not needed for `npm run dev` or the web dashboard.

### 2. 🚀 Initial Setup & Startup for a New Repository (From Zero)
When setting up `smart-pdf-triage` on a new computer or for a new user starting from scratch:

#### Step 1: Install Ollama & Start Local AI Service
Download and install [Ollama](https://ollama.com). Ensure the local AI service is running and pull the Qwen 3.5 9B model:
```bash
ollama serve
ollama pull qwen3.5:9b
```

#### Step 2: Clone Repository & Install Node Dependencies
```bash
git clone https://github.com/phamhung075/smart-pdf-triage-local-ai.git
cd smart-pdf-triage-local-ai
npm install
```

#### Step 3: Configure Settings & Directories
Copy the template `settings.json.example` to `settings.json`:
```bash
cp settings.json.example settings.json
```
Customize `input_dir` (where incoming PDFs arrive) and `output_root_dir` (where organized PDFs are filed) in `settings.json`:
```json
{
  "language": "EN",
  "input_dir": "./input",
  "output_root_dir": "./organized",
  "ollama_model": "qwen3.5:9b",
  "ollama_host": "http://127.0.0.1:11434"
}
```
> 💡 **Automatic Directory Initialization**: On launch, the server automatically initializes all necessary folder structures (`./input`, `./organized`, `.blocked_files`, `.duplicates_files`, `.delete_files`) and the SQLite database (`pdf_triage.db`) if they do not exist yet.

Alternatively (or in addition), copy `.env.example` to `.env` and set any of `PDF_TRIAGE_BASE_DIR`, `PDF_INPUT_DIR`, `PDF_OUTPUT_DIR`, `PDF_TRIAGE_HOST`, `PORT`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL`, `SYSTEM_LANGUAGE` — see the file for what each one does. `settings.json` (via the Settings modal in the UI) is the friendlier way to change input/output folders and language day-to-day; `.env` is for things you set once per install.

`categories.json` (the generic starter taxonomy) is committed and needs no setup. Everything auto-created from your own documents goes to `.categories.private.json` instead, which is gitignored — see [`categories-store.ts`](src/infrastructure/categories-store.ts) if you're curious how the two get merged.

**Optional — teach the classifier about your own documents.** If your bank writes statement filenames as codes, or your scanner prefixes files, or you want a specific employer always filed a certain way, copy the template and edit it:
```bash
cp prompts.private.json.example .prompts.private.json
```
It holds a list of known entities and a set of keyword → category/subcategory overrides that are evaluated *before* the generic decision flow. The file is gitignored, it is read fresh on every classification (so edits take effect without restarting), and an invalid file is logged and ignored rather than breaking triage. Skipping this is completely fine — the prompts work generically without it.

#### Step 4: Run the Application
- **Development Mode** (API & Web Dashboard on `http://localhost:3971`):
  ```bash
  npm run dev
  ```
- **Build Frontend TypeScript** (run this after editing any `public/ts/*.ts` file — nothing recompiles it automatically):
  ```bash
  npm run build:frontend
  ```
- **Desktop Electron App Mode** (Native Window with System Tray):
  ```bash
  npm run desktop
  ```
- **Build Portable Desktop Installer (.exe)** — requires Visual Studio Build Tools, see Prerequisites above:
  ```bash
  npm run build
  npm run dist:exe
  ```

---

## 🧪 Testing & Code Quality

```bash
# Run the full unit test suite
npm test

# Type-check both backend and frontend (no emit)
npm run typecheck
```

---

## 📄 License

[MIT License](LICENSE). Free for personal, commercial, and enterprise use.
