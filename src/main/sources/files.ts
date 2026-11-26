import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import zlib from 'node:zlib'
import { LogDoc } from '../core/LogDoc'
import { decodeLines, detectEncoding, makeStreamDecoder } from '../core/encoding'
import { hostCommand } from './host'
import type { DocSource } from '@shared/types'

/** Decompress if the content is gzip / zstd / bzip2-less; returns the plain bytes. */
export function maybeDecompress(buf: Buffer, name: string): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf)
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
    const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }
    if (z.zstdDecompressSync) return z.zstdDecompressSync(buf)
    throw Object.assign(new Error('zstd compressed files are not supported by this runtime'), { code: 'EUNSUPPORTED' })
  }
  if (/\.(xz|bz2|lz4)$/i.test(name)) {
    throw Object.assign(new Error('Compression format of ' + name + ' is not supported (gzip and zstd are)'), { code: 'EUNSUPPORTED' })
  }
  return buf
}

export function isCompressed(buf: Buffer): boolean {
  return (buf[0] === 0x1f && buf[1] === 0x8b) || (buf[0] === 0x28 && buf[1] === 0xb5)
}

/** Fill a document from raw bytes. */
export function loadBytes(doc: LogDoc, raw: Buffer, encoding?: string): void {
  doc.raw = raw
  const det = detectEncoding(raw)
  doc.detectedEncoding = det.encoding
  doc.encodingConfidence = det.confidence
  doc.encoding = encoding && encoding !== 'auto' ? encoding : det.encoding
  decodeInto(doc)
}

export function decodeInto(doc: LogDoc): void {
  const { lines, partial } = decodeLines(doc.fullRaw(), doc.encoding!)
  if (partial.length > 0) lines.push(partial)
  doc.setTextLines(lines)
}

/** Read a file using pkexec (polkit) for files that need root. */
function readElevated(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = hostCommand(['pkexec', 'cat', '--', path])
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => (err += c.toString()))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else if (code === 126 || code === 127) reject(Object.assign(new Error('Authorization was cancelled or denied'), { code: 'ECANCELED' }))
      else reject(Object.assign(new Error(err.trim() || 'pkexec failed with code ' + code), { code: 'EACCES' }))
    })
  })
}

export async function openLocalFile(path: string, opts: { encoding?: string; elevated?: boolean }): Promise<LogDoc> {
  const source: DocSource = { kind: 'file', path, elevated: opts.elevated }
  const doc = new LogDoc(source, basename(path))
  doc.subtitle = dirname(path)
  let raw: Buffer
  try {
    const st = await fsp.stat(path)
    doc.refMs = st.mtimeMs
    if (st.isDirectory()) throw Object.assign(new Error(path + ' is a directory'), { code: 'EISDIR' })
    raw = opts.elevated ? await readElevated(path) : await fsp.readFile(path)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EACCES' && !opts.elevated && process.platform === 'linux') {
      throw Object.assign(new Error('Permission denied: ' + path), { code: 'EACCES' })
    }
    throw err
  }
  const plain = maybeDecompress(raw, path)
  loadBytes(doc, plain, opts.encoding)
  doc.loading = false
  return doc
}

/**
 * Follow a growing local file (like tail -f). Handles truncation / rotation by
 * reloading from the start of the new file.
 */
export function followLocalFile(doc: LogDoc, onAppend: (n: number) => void, onReset: () => void): () => void {
  const path = doc.source.path!
  let offset = doc.fullRaw().length
  let decoder = makeStreamDecoder(doc.encoding ?? 'utf-8')
  let busy = false
  let again = false
  let watcher: FSWatcher | null = null
  let stopped = false

  const poll = async (): Promise<void> => {
    if (stopped) return
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      const st = await fsp.stat(path)
      if (st.size < offset) {
        // truncated or rotated: start over
        offset = 0
        decoder = makeStreamDecoder(doc.encoding ?? 'utf-8')
        doc.raw = Buffer.alloc(0)
        doc.setTextLines([])
        onReset()
      }
      if (st.size > offset) {
        const fh = await fsp.open(path, 'r')
        try {
          const len = st.size - offset
          const buf = Buffer.alloc(len)
          const { bytesRead } = await fh.read(buf, 0, len, offset)
          offset += bytesRead
          const chunk = buf.subarray(0, bytesRead)
          doc.appendRaw(Buffer.from(chunk))
          const lines = decoder.write(chunk)
          const n = doc.appendTextLines(lines)
          if (n) onAppend(n)
        } finally {
          await fh.close()
        }
      }
    } catch {
      /* file may be temporarily missing during rotation */
    } finally {
      busy = false
      if (again) {
        again = false
        void poll()
      }
    }
  }

  // The last line of the initial load may have been incomplete; we keep it as
  // is (it was shown) and continue from the end of the file.
  try {
    watcher = watch(path, { persistent: false }, () => void poll())
  } catch {
    watcher = null
  }
  const timer = setInterval(() => void poll(), 1000) // fallback for network fs / rotation
  return () => {
    stopped = true
    watcher?.close()
    clearInterval(timer)
  }
}
