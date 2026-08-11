export interface IFileSystemGateway {
  relocalizeFile(filePath: string, category: string, subcategory?: string, dateStr?: string, title?: string): { newPath: string; moved: boolean };
  moveBackToRaws(filePath: string, checksum?: string): Promise<string>;
  findFileOnDisk(doc: { original_filename?: string; original_path?: string; new_path?: string }): string | null;
  deleteFileToTrash(filePath: string): string;
  getRawPdfFiles(): string[];
  cleanEmptyDirectories(dir: string): void;
}
