import fs from 'fs';
import path from 'path';

export const SUBDIRS = { fotos: 'fotos', documentos: 'documentos', projetos: 'projetos', outros: 'outros' };

const CAT_BY_EXT = {
  image: ['.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg','.ico','.avif','.heic'],
  video: ['.mp4','.mkv','.webm','.mov','.avi','.m4v'],
  audio: ['.mp3','.wav','.ogg','.flac','.m4a','.aac','.opus'],
  pdf: ['.pdf'],
  archive: ['.zip','.rar','.7z','.tar','.gz','.bz2','.xz','.tgz'],
  spreadsheet: ['.xls','.xlsx','.csv','.ods','.tsv'],
  code: ['.js','.ts','.py','.html','.css','.json','.md','.sh','.rb','.go','.rs','.java','.c','.cpp','.h','.sql','.yml','.yaml','.xml','.toml','.bat','.ps1','.php','.kt','.swift'],
  doc: ['.doc','.docx','.txt','.rtf','.odt','.pptx','.ppt'],
};

export function fileCategory(originalName) {
  const ext = path.extname(originalName || '').toLowerCase().replace('.', '');
  const fotos = ['jpg','jpeg','png','gif','webp','heic','bmp'];
  const docs = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv'];
  const proj = ['zip','rar','7z','tar','gz','tgz','py','js','ts','html','css','json','sh','java','c','cpp','go','rs','sql'];
  if (fotos.includes(ext)) return SUBDIRS.fotos;
  if (docs.includes(ext)) return SUBDIRS.documentos;
  if (proj.includes(ext)) return SUBDIRS.projetos;
  return SUBDIRS.outros;
}

export function fileCategoryType(name) {
  const ext = path.extname(name).toLowerCase();
  for (const [cat, exts] of Object.entries(CAT_BY_EXT)) if (exts.includes(ext)) return cat;
  return 'other';
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Resolve `rel` dentro de `base` com validação real (cobre .. e symlinks).
 * Retorna o caminho absoluto se seguro, ou null.
 */
export function resolveInside(base, rel) {
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { return null; }
  const full = path.resolve(realBase, rel);
  if (full !== realBase && !full.startsWith(realBase + path.sep)) return null;
  try {
    const realFull = fs.realpathSync(full);
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) return null;
  } catch { /* arquivo ainda não existe — deixa o 404 natural */ }
  return full;
}

export function truncateText(text, max = 4000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncado: ${s.length - max} caracteres não repassados]`;
}

export const MAX_MESSAGE_CHARS = 65536;

/** Normaliza mensagem de chat: rejeita vazia/só espaços e acima do limite. */
export function normalizeMessage(text) {
  const s = String(text ?? '').trim();
  if (!s) {
    const e = new Error('mensagem vazia');
    e.status = 400;
    throw e;
  }
  if (s.length > MAX_MESSAGE_CHARS) {
    const e = new Error(`mensagem muito longa (máx ${MAX_MESSAGE_CHARS} caracteres)`);
    e.status = 413;
    throw e;
  }
  return s;
}

/** Lê o corpo de um JSON com limite de tamanho. resolve(obj) ou reject({status, message}). */
export function parseJsonBody(body, maxBytes = 1024 * 1024) {
  if (!body) return {};
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    const e = new Error('corpo muito grande');
    e.status = 413;
    throw e;
  }
  try {
    return JSON.parse(body);
  } catch {
    const e = new Error('JSON inválido');
    e.status = 400;
    throw e;
  }
}