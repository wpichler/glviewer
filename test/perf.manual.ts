import { openLocalFile } from '../src/main/sources/files'
// Manual benchmark: npx tsx --tsconfig tsconfig.node.json test/perf.manual.ts <big.log>
async function main() {
  const p = process.argv[2]
  let t = performance.now()
  const d = await openLocalFile(p, {})
  console.log('load', d.lineCount, Math.round(performance.now() - t), 'ms', 'fmt', d.detectedTsFormat, 'mem MB', Math.round(process.memoryUsage().rss / 1e6))
  t = performance.now()
  await d.setFilter({ include: 'worker-3]', exclude: '', regex: false, caseSensitive: false })
  console.log('filter substring', d.viewCount, Math.round(performance.now() - t), 'ms')
  t = performance.now()
  await d.setFilter({ include: 'took 9\\d\\dms', exclude: '', regex: true, caseSensitive: false, levels: [3] })
  console.log('filter regex+level', d.viewCount, Math.round(performance.now() - t), 'ms')
  await d.setFilter(null)
  t = performance.now()
  console.log('search', await d.search({ query: 'id=2999990 ', regex: false, caseSensitive: false }, 0, 1), Math.round(performance.now() - t), 'ms')
  t = performance.now()
  d.setSourceTz('America/New_York')
  console.log('tz change', Math.round(performance.now() - t), 'ms')
  t = performance.now(); for (let i = 0; i < 1000; i++) d.findTime(1795700000000 + i * 100000); console.log('1000 findTime', Math.round(performance.now() - t), 'ms')
}
void main()
