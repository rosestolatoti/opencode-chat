import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch { /* sem .env — usa padrões */ }
  return out;
}

const env = loadEnv();
const str = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d);

export const PORT = parseInt(str('NEXUS_PORT', '3777'), 10);
export const BOOTSTRAP_TOKEN = str('NEXUS_TOKEN', '');
export const UPLOAD_DIR = str('NEXUS_UPLOAD_DIR', path.join(__dirname, 'Compartilhado'));
export const DB_PATH = str('NEXUS_DB', path.join(__dirname, 'nexus.db'));
export const LINUX_IP = str('LINUX_TAILSCALE_IP', 'LINUX_TAILSCALE_IP');
export const WINDOWS_IP = str('WINDOWS_TAILSCALE_IP', 'WINDOWS_TAILSCALE_IP');
export const ANDROID_IP = str('ANDROID_TAILSCALE_IP', 'ANDROID_TAILSCALE_IP');
export const WINDOWS_SSH_USER = str('WINDOWS_SSH_USER', 'nexus-agent');
export const WINDOWS_WORKDIR = str('WINDOWS_WORKDIR', 'C:\\NexusWork');
export const SESSION_TTL_MS = parseInt(str('NEXUS_SESSION_TTL_DAYS', '30'), 10) * 86400000;