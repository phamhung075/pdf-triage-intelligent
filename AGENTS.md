# 🤖 AGENT INSTRUCTIONS & RULES

> **CRITICAL**: Before performing any task, code edit, or server command in this repository, you MUST read and obey all specifications defined in:
> 📄 [AGENT_REQUIREMENTS.md](./AGENT_REQUIREMENTS.md)

---

### 🧠 Golden Rule: Think First Before Action
> ⚠️ **THINK FIRST BEFORE DOING ANYTHING**: Always thoroughly analyze the problem, inspect the codebase, trace dependencies, verify data schemas, and plan your implementation steps carefully before editing files or running commands. Never make assumptions or guess implementation details.

---

### 📋 Summary of Key Directives:
1. **Think First**: Analyze context, trace imports, and plan thoroughly before writing code or running operations.
2. **Server Command Rule**: NEVER run `npm run dev` or server background tasks automatically. ALWAYS ask/instruct the user to run `npm run dev` on their PC terminal.
3. **Structured Error Reason Dropdowns for AI Training**: The Relocalize Modal includes two dedicated dropdown controls allowing users to select the exact reason why the Category or Subcategory location was wrong:
   - **Why is Category Wrong?** (e.g. *Bank Statement misclassified as Vendor Invoice*, *Tax form misclassified as Courriers*, *Pay Slip misclassified as Invoice*).
   - **Why is Subcategory Wrong?** (e.g. *Generic fallback used*, *Wrong Employer / Enterprise name*, *Wrong Bank Society*, *Date numbers inside folder name*).
   - These structured error reasons are automatically formatted and passed to local Qwen 3.5 AI as feedback training notes!
4. **Interactive Relocalize Controls**: Clicking **📍 Relocalize** opens an interactive modal with Category dropdown, Subcategory dropdown (with `➕ Add New Subcategory...`), and AI Feedback Note input. Users can explicitly pick/create the correct location or teach local AI what was wrong.
5. **Pre-Move Dynamic Auto-Creation (Zero-Block Workflow)**: BEFORE moving any PDF file to `__archive`, the system/agent MUST check `categories.json`. If the category or subcategory slug is missing, the system MUST dynamically auto-create and permanently save the new category/subcategory slug in `categories.json` BEFORE constructing folders and moving the file!
6. **Mandatory Deep Semantic Reading (Content over Keyword Matching)**: Local AI and subagents MUST read and analyze the full semantic context, legal purpose, and primary issuing entity. DO NOT rely on simple string keyword matching or isolated word occurrences!
7. **STRICT NO-SUBCATEGORY FAIL GUARD**: If a document fails to resolve to a specific, non-generic subcategory (i.e. if subcategory is empty `""`, `general`, `other`, or `divers`), the document is marked as **FAILED / BLOCKED**. It MUST NOT be saved to SQLite DB and MUST NOT be moved to `__archive`. It **MUST REMAIN IN `__raws`** for manual review!
8. **Master AI Classification Decision Flow (Strict Priority Order)**:
   - **Step 1: Bank Statements**: Check header for Bank Name / IBAN ➔ Category `bank`, Subcategory = Bank Name (`credit_mutuel`, `societe_generale`, `bnp_paribas`, `boursobank`, `lcl`, `la_banque_postale`, `paypal`). **IGNORE** internal transaction rows (SFR, PayPal, Amazon).
   - **Step 2: Tax Documents**: Check `Avis d'impôt`, `DGFIP`, `Impôts` ➔ Category `administrative`, Subcategory `impot`. **NEVER** `correspondence`.
   - **Step 3: Pay Slips**: Check `Bulletin de salaire`, `fiche de paie` ➔ Category `bulletin_salaire`, Subcategory = the slugified Employer/Enterprise Name printed on the slip.
   - **Step 4: Health**: Check `Ameli`, `CPAM`, `Mutuelle` ➔ Category `health`.
   - **Step 5: Identity**: Check Passports, CNI, Titre de Séjour, Carte Vitale ➔ Category `identity`.
   - **Step 6: Housing**: Check Domicile proofs, property-manager statements, Rent ➔ Category `housing`.
   - **Step 7: Insurance**: Check Allianz, Auto, Habitation policies ➔ Category `insurance`.
   - **Step 8: Invoices**: Check Factures, SFR, EDF ➔ Category `invoices`.
   - **Step 9: Contracts**: Check CDI, CDD, Work Contracts ➔ Category `contracts`.
   - **Step 10: Education**: Check Scolarité, Diplôme, Relevé de notes, school/training-provider names ➔ Category `education`.
   - **Step 11: Recruitment**: Check Lettres de motivation, CV ➔ Category `recruitment`.
9. **Structured Executive Summary (`💡 Executive Summary`)**: Generate a 3-5 sentence searchable Executive Summary for every document capturing: Issuing Organization, Key Identifiers/Ref #s, Financial Amounts/Dates, and Core Purpose. Displayed in a prominent highlight box on UI cards and indexed in SQLite FTS5 for instant search.
10. **Clear Registry Rule (Move `__archive` files back to `__raws`)**: Clicking **🗑️ Clear Registry** (`DELETE /api/documents`) MUST move all PDF files currently in `__archive` back to `__raws` (`CONFIG.INPUT_DIR`), clean up empty folders, and purge SQLite database records!
11. **Separation by Exact Bank Society & Company**: Never lump all banks into a generic `banque` subcategory. Separate by exact bank society (`credit_mutuel`, `societe_generale`, `bnp_paribas`, `boursobank`, `lcl`, `la_banque_postale`). Apply the same company-level separation for all categories.
12. **Single Exact Category Titles (NO MERGED NAMES)**: Category and subcategory names MUST be single, clear, exact titles.
13. **STRICT NO FULL-DISK SCAN RULE**: The application and agent MUST scan ONLY inside `__raws` (`CONFIG.INPUT_DIR`).
14. **Nested Subcategories (Sub on Sub)**: Support multi-level nested subcategories on disk & UI.
15. **Real-Time Live Auto-Update**: Broadcast live SSE events on all mutations.
16. **Markdown Representation (.md)**: Qwen 3.5 AI formats raw PDF text into clean structured Markdown.
17. **10s Auto-Scan Watcher**: The backend checks `__raws` every 10 seconds.
18. **Non-Blocking 1-by-1 Scan**: Sequential non-blocking scans.
19. **No-Text Block Guard**: Block zero-text PDFs.
20. **Toast Notifications**: Use Toast service for all notifications.
