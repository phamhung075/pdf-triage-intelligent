import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord } from '../db/database.js';
import { getCategoriesConfig } from '../categories-store.js';
import { runTriageScan } from '../../application/triage-scan.js';
import { ScanInProgressError } from '../../application/scan-lock.js';
import { relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist, findActualFileOnDisk } from '../../application/relocalize-document.js';
import { isForbiddenSubcategory } from '../../domain/taxonomy.js';
import { syncJSONRegistry } from '../json-registry.js';
import { UpdateDocumentSchema } from '../../domain/document.schema.js';
import { CONFIG, BASE_DIR } from '../settings.js';

// Extracted from the ListToolsRequestSchema/CallToolRequestSchema closures that used to
// live inline inside startMCPServer() so they can be unit-tested directly, without
// spinning up a real Server + StdioServerTransport (which binds real stdin/stdout).
// startMCPServer() below is now a thin wrapper that just registers these with the SDK.
export async function listMcpTools() {
  return {
    tools: [
      {
        name: 'search_documents',
        description: 'Search documents by title, summary, reference registre, category, or full raw text',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or keywords' },
            category: { type: 'string', description: 'Optional category filter' },
            subcategory: { type: 'string', description: 'Optional subcategory filter' },
            fileType: { type: 'string', description: 'Optional document type filter: PDF, IMAGE, TEXT, WORD, EXCEL' },
            limit: { type: 'number', description: 'Max results count (default 20)' }
          }
        }
      },
      {
        name: 'get_full_document_text',
        description: 'Retrieve the complete extracted raw text of a document by document ID',
        inputSchema: {
          type: 'object',
          properties: {
            docId: { type: 'number', description: 'Document ID' }
          },
          required: ['docId']
        }
      },
      {
        name: 'update_document_metadata',
        description: 'Modify title, registre, date, category, subcategory, summary, or tags for a document. If category or subcategory changes, the physical file is relocalized to the new canonical folder (auto-creating the category/subcategory in categories.json first, per Golden Rule #5). subcategory cannot be general/other/divers/a bare year (Golden Rule #4).',
        inputSchema: {
          type: 'object',
          properties: {
            docId: { type: 'number', description: 'Document ID' },
            title: { type: 'string' },
            registre: { type: 'string' },
            date: { type: 'string' },
            category: { type: 'string' },
            subcategory: { type: 'string' },
            summary: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['docId']
        }
      },
      {
        name: 'trigger_triage',
        description: 'Scan the incoming PDFs input folder and process all new documents',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'list_categories',
        description: 'List all available document categories and their description/keywords',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'prepare_dossier',
        description: 'Assemble and validate a complete list of required documents for administrative dossiers (housing, tax, employment, bank, identity). Returns present documents sorted by date and explicitly lists any missing required document types.',
        inputSchema: {
          type: 'object',
          properties: {
            dossierType: { type: 'string', description: 'Type of dossier: housing, tax, employment, bank, or identity' },
            limit: { type: 'number', description: 'Max documents per category' }
          },
          required: ['dossierType']
        }
      },
      {
        name: 'get_document_markdown',
        description: 'Retrieve structured Markdown representation, Executive Summary, amounts, and contact details for a specific document ID',
        inputSchema: {
          type: 'object',
          properties: {
            docId: { type: 'number', description: 'Document ID' }
          },
          required: ['docId']
        }
      },
      {
        name: 'open_document_folder',
        description: 'Open OS File Explorer (Windows Explorer) with the file selected at its exact location on disk',
        inputSchema: {
          type: 'object',
          properties: {
            docId: { type: 'number', description: 'Document ID' }
          },
          required: ['docId']
        }
      },
      {
        name: 'package_documents',
        description: 'Build a .zip package of documents for handing to a third party (e.g. a housing/tax/bank dossier). Provide either an explicit docIds list, or a dossierType free-text query (same matching as prepare_dossier) to resolve the document set automatically. Writes the zip to disk under __packages/ and returns its path plus which requested documents (if any) had no file on disk.',
        inputSchema: {
          type: 'object',
          properties: {
            docIds: { type: 'array', items: { type: 'number' }, description: 'Explicit document IDs to include. Provide this or dossierType.' },
            dossierType: { type: 'string', description: 'Free-text dossier query (e.g. "housing", "3 last pay slips") used to auto-resolve documents when docIds is not given.' },
            zipName: { type: 'string', description: 'Optional filename for the zip (default: an auto-generated name from dossierType or timestamp).' }
          }
        }
      }
    ]
  };
}

export async function handleMcpToolCall(name: string, args: Record<string, unknown> | undefined) {
  try {
    if (name === 'search_documents') {
      const query = ((args?.query as string) || '').toLowerCase();
      const category = ((args?.category as string) || '').toLowerCase();
      const subcategory = ((args?.subcategory as string) || '').toLowerCase();
      const fileType = ((args?.fileType as string) || '').toUpperCase();
      const limit = (args?.limit as number) || 20;

      const { detectFileType } = await import('../../domain/taxonomy.js');
      const docs = await getAllDocuments();
      const matches = docs.filter(doc => {
        const catMatch = !category || doc.category.toLowerCase() === category;
        const subMatch = !subcategory || (doc.subcategory || '').toLowerCase() === subcategory;
        const docFileType = (doc.file_type || detectFileType(doc.original_filename)).toUpperCase();
        const typeMatch = !fileType || docFileType === fileType;
        const textMatch = !query ||
          doc.title.toLowerCase().includes(query) ||
          doc.summary.toLowerCase().includes(query) ||
          doc.registre.toLowerCase().includes(query) ||
          doc.tags.toLowerCase().includes(query) ||
          (doc.subcategory || '').toLowerCase().includes(query) ||
          doc.raw_text.toLowerCase().includes(query);
        return catMatch && subMatch && typeMatch && textMatch;
      }).slice(0, limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              count: matches.length,
              results: matches.map(d => ({
                id: d.id,
                title: d.title,
                registre: d.registre,
                date: d.date,
                category: d.category,
                subcategory: d.subcategory,
                file_type: d.file_type || detectFileType(d.original_filename),
                summary: d.summary,
                new_path: d.new_path,
                status: d.status
              }))
            }, null, 2)
          }
        ]
      };
    }

    if (name === 'get_full_document_text') {
      const docId = args?.docId as number;
      const doc = await getDocumentById(docId);
      if (!doc) {
        return {
          content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
          isError: true
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: doc.id,
              title: doc.title,
              registre: doc.registre,
              date: doc.date,
              category: doc.category,
              summary: doc.summary,
              file_path: doc.new_path || doc.original_path,
              raw_text: doc.raw_text
            }, null, 2)
          }
        ]
      };
    }

    if (name === 'update_document_metadata') {
      const docId = args?.docId;
      if (typeof docId !== 'number' || !Number.isInteger(docId) || docId <= 0) {
        return {
          content: [{ type: 'text', text: `Error: docId must be a positive integer, got: ${JSON.stringify(docId)}` }],
          isError: true
        };
      }

      const parsed = UpdateDocumentSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: `Error: invalid arguments — ${parsed.error.message}` }],
          isError: true
        };
      }
      const updates = parsed.data;

      const explicitSubcategory = updates.subcategory ?? updates.subcategorie;
      if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
        return {
          content: [{ type: 'text', text: `Error: '${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` }],
          isError: true
        };
      }

      const docBefore = await getDocumentById(docId);
      if (!docBefore) {
        return {
          content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
          isError: true
        };
      }

      const success = await updateDocumentRecord(docId, updates);
      if (!success) {
        return {
          content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
          isError: true
        };
      }

      // Relocalize the physical file if category/subcategory changed, mirroring
      // PUT /api/documents/:id — this tool previously left the DB and disk out of sync.
      if (docBefore.new_path && fs.existsSync(docBefore.new_path)) {
        const targetCategory = updates.category ?? updates.categorie ?? docBefore.category;
        const targetSubcategory = updates.subcategory ?? updates.subcategorie ?? docBefore.subcategory;
        ensureCategoryAndSubcategoryExist(targetCategory, targetSubcategory);
        const { newPath } = relocalizeFileIfNeeded(
          docBefore.new_path,
          targetCategory,
          targetSubcategory,
          updates.date ?? docBefore.date
        );
        if (newPath !== docBefore.new_path) {
          await updateDocumentRecord(docId, { new_path: newPath });
        }
      }

      await syncJSONRegistry();
      return {
        content: [{ type: 'text', text: `Successfully updated metadata for document ID ${docId}` }]
      };
    }

    if (name === 'trigger_triage') {
      try {
        const result = await runTriageScan();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err: any) {
        if (err instanceof ScanInProgressError) {
          return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true
          };
        }
        throw err;
      }
    }

    if (name === 'list_categories') {
      const config = getCategoriesConfig();
      return {
        content: [{ type: 'text', text: JSON.stringify(config.categories, null, 2) }]
      };
    }

    if (name === 'prepare_dossier') {
      const dossierType = ((args?.dossierType as string) || '').toLowerCase();
      const { searchRelevantDocuments } = await import('../../application/ai-chat-assistant.js');
      const { detectFileType } = await import('../../domain/taxonomy.js');
      const docs = await searchRelevantDocuments(dossierType);
      
      const formatted = docs.map(d => ({
        id: d.id,
        title: d.title,
        date: d.date,
        category: d.category,
        subcategory: d.subcategory,
        file_type: d.file_type || detectFileType(d.original_filename),
        summary: d.summary,
        total_amount: d.total_amount,
        new_path: d.new_path || d.original_path
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            dossierType,
            count: formatted.length,
            documents: formatted
          }, null, 2)
        }]
      };
    }

    if (name === 'get_document_markdown') {
      const docId = args?.docId as number;
      const doc = await getDocumentById(docId);
      if (!doc) {
        return {
          content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
          isError: true
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: doc.id,
            title: doc.title,
            category: doc.category,
            subcategory: doc.subcategory,
            date: doc.date,
            summary: doc.summary,
            total_amount: doc.total_amount,
            contact_name: doc.contact_name,
            contact_email: doc.contact_email,
            contact_phone: doc.contact_phone,
            markdown_content: doc.markdown_content || `# ${doc.title}\n\n${doc.summary}`,
            file_path: doc.new_path || doc.original_path
          }, null, 2)
        }]
      };
    }

    if (name === 'open_document_folder') {
      const docId = args?.docId as number;
      const doc = await getDocumentById(docId);
      if (!doc) {
        return {
          content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
          isError: true
        };
      }
      const { findActualFileOnDisk } = await import('../../application/relocalize-document.js');
      const fileOnDisk = findActualFileOnDisk(doc);
      if (!fileOnDisk || !fs.existsSync(fileOnDisk)) {
        return {
          content: [{ type: 'text', text: `Error: File for doc ID ${docId} does not exist on disk` }],
          isError: true
        };
      }

      const { exec } = await import('child_process');
      if (process.platform === 'win32') {
        exec(`explorer.exe /select,"${fileOnDisk}"`);
      } else if (process.platform === 'darwin') {
        exec(`open -R "${fileOnDisk}"`);
      } else {
        exec(`xdg-open "${path.dirname(fileOnDisk)}"`);
      }

      return {
        content: [{ type: 'text', text: `Opened OS file manager at file: ${fileOnDisk}` }]
      };
    }

    if (name === 'package_documents') {
      const explicitIds = Array.isArray(args?.docIds) ? (args!.docIds as unknown[]).map(Number).filter(Number.isInteger) : [];
      const dossierType = (args?.dossierType as string) || '';

      if (explicitIds.length === 0 && !dossierType) {
        return {
          content: [{ type: 'text', text: 'Error: provide either docIds or dossierType.' }],
          isError: true
        };
      }

      let docs;
      if (explicitIds.length > 0) {
        docs = (await Promise.all(explicitIds.map(id => getDocumentById(id)))).filter((d): d is NonNullable<typeof d> => !!d);
      } else {
        const { searchRelevantDocuments } = await import('../../application/ai-chat-assistant.js');
        docs = await searchRelevantDocuments(dossierType);
      }

      const zipFiles: Array<{ name: string; path: string }> = [];
      const missingDocIds: number[] = [];
      for (const doc of docs) {
        const fileOnDisk = findActualFileOnDisk(doc);
        if (fileOnDisk && fs.existsSync(fileOnDisk)) {
          const ext = path.extname(fileOnDisk) || '.pdf';
          const baseTitle = (doc.title || doc.original_filename || `doc_${doc.id}`).replace(/[\\/?%*:|"<>]/g, '_');
          const fileNameInZip = baseTitle.endsWith(ext) ? baseTitle : `${baseTitle}${ext}`;
          zipFiles.push({ name: fileNameInZip, path: fileOnDisk });
        } else {
          missingDocIds.push(doc.id);
        }
      }

      if (zipFiles.length === 0) {
        return {
          content: [{ type: 'text', text: `Error: none of the ${docs.length} resolved document(s) have a file on disk. Missing IDs: ${missingDocIds.join(', ') || 'n/a'}` }],
          isError: true
        };
      }

      const { createZipArchive } = await import('../zip-builder.js');
      const zipBuffer = createZipArchive(zipFiles);

      const packagesDir = path.join(BASE_DIR, '__packages');
      if (!fs.existsSync(packagesDir)) fs.mkdirSync(packagesDir, { recursive: true });
      const rawName = (args?.zipName as string) || (dossierType ? `${dossierType}_package` : `documents_package_${Date.now()}`);
      const safeName = rawName.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const zipFileName = safeName.endsWith('.zip') ? safeName : `${safeName}.zip`;
      const zipPath = path.join(packagesDir, zipFileName);
      fs.writeFileSync(zipPath, zipBuffer);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            zipPath,
            fileCount: zipFiles.length,
            includedDocIds: docs.filter(d => !missingDocIds.includes(d.id)).map(d => d.id),
            missingDocIds
          }, null, 2)
        }]
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool name: ${name}` }],
      isError: true
    };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error executing ${name}: ${err.message}` }],
      isError: true
    };
  }
}

// One MCP tool-server instance per transport connection — the SDK's Server.connect() is
// 1:1 with a transport. stdio gets a single long-lived instance (one client for the whole
// process lifetime); each stateless HTTP request gets its own short-lived instance (see
// startMcpHttpTransport below) since there is no persistent client to keep it alive for.
function createToolServer(): Server {
  const server = new Server(
    { name: 'pdf-triage-agent-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => listMcpTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleMcpToolCall(name, args);
  });
  return server;
}

const MCP_TOKEN_FILE = path.join(BASE_DIR, '.mcp-api-token');

// Every HTTP MCP call is authenticated by this token (stdio has no equivalent because
// spawning the process locally is itself the access boundary there). Generated once and
// persisted to a gitignored file rather than settings.json, matching the dedicated-file
// pattern .categories.private.json / .prompts.private.json already use for secrets that
// must never be committed. Printed to the console on every `npm run mcp` start so it's
// easy to copy into an agent's config; never logged anywhere else.
function getOrCreateMcpApiToken(): string {
  if (fs.existsSync(MCP_TOKEN_FILE)) {
    const existing = fs.readFileSync(MCP_TOKEN_FILE, 'utf-8').trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(MCP_TOKEN_FILE, token, 'utf-8');
  return token;
}

function startMcpHttpTransport(): void {
  const token = getOrCreateMcpApiToken();
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const presented = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const authorized = presented.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(token));
    if (!authorized) {
      res.status(401).json({ error: 'Unauthorized — missing or invalid Bearer token.' });
      return;
    }

    // Stateless mode: no session ID, no server-initiated push — every request gets a fresh
    // Server + Transport pair, torn down once the response completes. This project's tools
    // are all simple request/response calls, so there's nothing a persistent session would
    // buy over this, and it avoids having to manage a session-ID map across requests.
    const server = createToolServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('MCP HTTP request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // The HTTP transport is a SECONDARY surface: stdio has already connected by the time this runs,
  // and `npm run mcp` is spawned once per client, so two clients (Claude Desktop + Claude Code) —
  // or one stale process — both try to bind MCP_HTTP_PORT. Without a listener, Node turns that
  // EADDRINUSE into an uncaught exception and kills the process, taking the perfectly healthy
  // stdio transport down with it. Degrade to stdio-only instead.
  const httpServer = app.listen(CONFIG.MCP_HTTP_PORT, CONFIG.MCP_HTTP_HOST, () => {
    const displayHost = CONFIG.MCP_HTTP_HOST === '0.0.0.0' ? '<this-machine-LAN-IP>' : CONFIG.MCP_HTTP_HOST;
    console.error(`PDF Triage MCP Server listening over HTTP at http://${displayHost}:${CONFIG.MCP_HTTP_PORT}/mcp`);
    console.error(`  Auth: send header  Authorization: Bearer ${token}`);
    console.error(`  Token file: ${MCP_TOKEN_FILE} (gitignored — do not commit or share)`);
    if (CONFIG.MCP_HTTP_HOST === '0.0.0.0') {
      console.error('  Reachable from any device on your LAN. Set MCP_HTTP_HOST=127.0.0.1 to restrict to this machine only.');
    }
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `PDF Triage MCP Server: port ${CONFIG.MCP_HTTP_PORT} is already in use — continuing with stdio only. ` +
        `Another MCP client is probably already serving HTTP on it; set MCP_HTTP_PORT to use a different one.`
      );
      return;
    }
    console.error(`PDF Triage MCP Server: HTTP transport failed to start (${err.code || 'unknown'}: ${err.message}) — continuing with stdio only.`);
  });
}

export async function startMCPServer(): Promise<void> {
  const stdioServer = createToolServer();
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);
  console.error('PDF Triage MCP Server connected via stdio');

  startMcpHttpTransport();
}
