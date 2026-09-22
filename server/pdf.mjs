import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function createMockPdf(job) {
  const python = process.env.HB_PYTHON || 'python';
  const script = fileURLToPath(new URL('../scripts/demo_pdf.py', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const chunks = []; let size = 0; let errorText = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PDF_TIMEOUT')); }, 20000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-2000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      if (code !== 0 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) reject(new Error(errorText || 'PDF_GENERATION_FAILED'));
      else resolve(bytes);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ id: job.id, version: job.version, params: job.params, createdAt: job.createdAt }));
  });
}
