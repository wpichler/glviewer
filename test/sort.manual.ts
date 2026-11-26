// Manual benchmark: npx tsx --tsconfig tsconfig.node.json test/sort.manual.ts <big.log>
import { openLocalFile } from '../src/main/sources/files'
async function main() {
  const d = await openLocalFile(process.argv[2], {})
  const base = { include: '', exclude: '', regex: false, caseSensitive: false }
  for (const order of ['asc', 'desc'] as const) {
    const t = performance.now()
    await d.setFilter({ ...base, order })
    console.log(`sorted input, ${order}:`, d.viewCount, Math.round(performance.now() - t), 'ms')
  }
  // shuffle the lines to force a real sort
  const lines = d.lines.slice()
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[lines[i], lines[j]] = [lines[j], lines[i]]
  }
  d.setTextLines(lines)
  for (const order of ['asc', 'desc'] as const) {
    const t = performance.now()
    await d.setFilter({ ...base, order })
    console.log(`shuffled input, ${order}:`, d.viewCount, Math.round(performance.now() - t), 'ms')
  }
}
void main()
