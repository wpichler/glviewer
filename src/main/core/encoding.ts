import iconv from 'iconv-lite'
import * as chardet from 'chardet'

export interface DetectedEncoding {
  encoding: string
  confidence: number // 0..100
}

const ALIASES: Record<string, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'iso-8859-1': 'iso-8859-1',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-15': 'iso-8859-15',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'koi8-r': 'koi8-r',
  shift_jis: 'shift_jis',
  'euc-jp': 'euc-jp',
  gb18030: 'gb18030',
  big5: 'big5',
  'euc-kr': 'euc-kr'
}

function isValidUtf8(buf: Buffer): boolean {
  // Ignore a possibly truncated multi-byte sequence at the end of the sample.
  let end = buf.length
  for (let k = 1; k <= 3 && end - k >= 0; k++) {
    const b = buf[end - k]
    if ((b & 0xc0) === 0xc0) {
      end -= k
      break
    }
    if ((b & 0x80) === 0) break
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, end))
    return true
  } catch {
    return false
  }
}

function hasNonAscii(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return true
  return false
}

/** Detect the encoding of a log file from (a sample of) its bytes. */
export function detectEncoding(data: Buffer): DetectedEncoding {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { encoding: 'utf-8', confidence: 100 }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return { encoding: 'utf-16le', confidence: 100 }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return { encoding: 'utf-16be', confidence: 100 }

  const sample = data.length > 4 * 1024 * 1024 ? data.subarray(0, 4 * 1024 * 1024) : data

  // UTF-16 without BOM: lots of zero bytes at even/odd positions
  let zeroEven = 0, zeroOdd = 0
  const n = Math.min(sample.length, 65536)
  for (let i = 0; i < n; i++) if (sample[i] === 0) (i & 1 ? zeroOdd++ : zeroEven++)
  if (n > 16) {
    if (zeroOdd > n * 0.3 && zeroEven < n * 0.05) return { encoding: 'utf-16le', confidence: 80 }
    if (zeroEven > n * 0.3 && zeroOdd < n * 0.05) return { encoding: 'utf-16be', confidence: 80 }
  }

  if (!hasNonAscii(sample)) return { encoding: 'utf-8', confidence: 100 }
  if (isValidUtf8(sample)) return { encoding: 'utf-8', confidence: 99 }

  try {
    const candidates = chardet.analyse(sample)
    for (const c of candidates) {
      const name = c.name.toLowerCase()
      const enc = ALIASES[name]
      if (enc && enc !== 'utf-8' && iconv.encodingExists(enc)) return { encoding: enc, confidence: c.confidence }
    }
  } catch {
    /* fall through */
  }
  return { encoding: 'windows-1252', confidence: 10 }
}

/** BOM length for the given encoding at the buffer start (0 if none). */
export function bomLength(data: Buffer, encoding: string): number {
  if (encoding === 'utf-8' && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return 3
  if (encoding === 'utf-16le' && data[0] === 0xff && data[1] === 0xfe) return 2
  if (encoding === 'utf-16be' && data[0] === 0xfe && data[1] === 0xff) return 2
  return 0
}

/**
 * Decode `data` with `encoding` and split it into lines. Works chunk-wise, so
 * files larger than V8's maximum string length are fine.
 */
export function decodeLines(data: Buffer, encoding: string, out: string[] = []): { lines: string[]; partial: string } {
  const enc = iconv.encodingExists(encoding) ? encoding : 'utf-8'
  const decoder = iconv.getDecoder(enc, { stripBOM: true })
  const CHUNK = 16 * 1024 * 1024
  let carry = ''
  for (let off = 0; off < data.length; off += CHUNK) {
    const text = carry + decoder.write(data.subarray(off, Math.min(data.length, off + CHUNK)))
    carry = splitInto(text, out)
  }
  const tail = decoder.end()
  if (tail) carry = splitInto(carry + tail, out)
  return { lines: out, partial: carry }
}

/** Splits text into lines appended to `out`; returns the trailing partial line. */
function splitInto(text: string, out: string[]): string {
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl < 0) break
    let end = nl
    if (end > start && text.charCodeAt(end - 1) === 13) end--
    out.push(text.slice(start, end))
    start = nl + 1
  }
  return text.slice(start)
}

export function makeStreamDecoder(encoding: string) {
  const enc = iconv.encodingExists(encoding) ? encoding : 'utf-8'
  const decoder = iconv.getDecoder(enc, { stripBOM: true })
  let carry = ''
  return {
    /** Feed bytes, returns complete lines. */
    write(chunk: Buffer): string[] {
      const lines: string[] = []
      carry = splitInto(carry + decoder.write(chunk), lines)
      return lines
    },
    pending(): string {
      return carry
    }
  }
}
