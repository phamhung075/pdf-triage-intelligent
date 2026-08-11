import { Request, Response } from 'express';
import { Container } from '../../di/container.js';
import { deleteDocumentAndMoveToTrash } from '../../../application/relocalize-document.js';

export class DocumentController {
  private container = Container.getInstance();

  public getAllDocuments = async (req: Request, res: Response): Promise<void> => {
    try {
      const docs = await this.container.documentRepository.getAllDocuments();
      res.json(docs.map(d => ({
        id: d.getId()?.getValue(),
        checksum: d.getChecksum().getValue(),
        title: d.getTitle(),
        category: d.getCategory().getId(),
        subcategory: d.getSubcategory().getSlug(),
        date: d.getDate(),
        summary: d.getSummary(),
        tags: d.getTags(),
        raw_text: d.getRawText(),
        markdown_content: d.getMarkdownContent(),
        contact_name: d.getContact().getName(),
        contact_email: d.getContact().getEmail(),
        contact_phone: d.getContact().getPhone(),
        contact_address: d.getContact().getAddress(),
        contact_website: d.getContact().getWebsite(),
        original_filename: d.getOriginalFilename(),
        original_path: d.getOriginalPath(),
        new_path: d.getNewPath(),
        status: d.getStatus()
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  public relocalizeDocument = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const { category, subcategory, userFeedbackReason } = req.body || {};
      const result = await this.container.relocalizeDocumentUseCase.execute(id, category, subcategory, userFeedbackReason);
      if (!result.success) {
        res.status(400).json({ error: result.error, staleCleaned: result.staleCleaned });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  public deleteDocument = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const result = await deleteDocumentAndMoveToTrash(id);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
}
