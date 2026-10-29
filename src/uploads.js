import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { all } from './db.js';

// Files attached to requests. The database only holds their names, so
// whatever deletes requests (directly or by cascade) removes the files too.
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'uploads', 'attachments');

export function removeAttachmentFiles(names) {
  for (const name of names) fs.rm(path.join(ATTACHMENTS_DIR, path.basename(name)), { force: true }, () => {});
}

// Stored names of the attachments on requests matching `where`; read these
// before a delete cascades the rows away.
export function attachmentFilesWhere(where, ...params) {
  return all(`SELECT a.stored_name FROM attachments a JOIN requests r ON r.id = a.request_id WHERE ${where}`, ...params)
    .map((row) => row.stored_name);
}
