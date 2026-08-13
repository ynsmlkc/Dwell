import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImpressionQueue } from '../src/daemon/queue.js'
import type { CompletedImpression } from '../src/daemon/turns.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dwell-q-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const imp = (id: string): CompletedImpression => ({
  id, campaignId: 'c1', nonce: '0'.repeat(32), sessionId: 's1',
  surface: 'statusline', durationMs: 12_000, clientTs: 1_700_000_000_000,
  rejectedReason: null,
})

describe('gosterim kuyrugu', () => {
  it('yazilan okunur', () => {
    const q = new ImpressionQueue({ dir })
    q.add(imp('a')); q.add(imp('b'))
    expect(q.pending().map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('daemon yeniden baslarsa kuyruk KAYBOLMAZ', () => {
    new ImpressionQueue({ dir }).add(imp('a'))
    // yeni ornek — daemon carpip yeniden basladi
    expect(new ImpressionQueue({ dir }).pending().map((i) => i.id)).toEqual(['a'])
  })

  it('gonderilenler bir daha gonderilmez', () => {
    const q = new ImpressionQueue({ dir })
    q.add(imp('a')); q.add(imp('b')); q.add(imp('c'))
    q.markSent(['a', 'c'])
    expect(q.pending().map((i) => i.id)).toEqual(['b'])
  })

  it('yarim yazilmis son satir tum kuyrugu bozmaz', () => {
    const q = new ImpressionQueue({ dir })
    q.add(imp('a')); q.add(imp('b'))
    // guc kesintisi: satir yarida kaldi
    appendFileSync(join(dir, 'impressions.jsonl'), '{"id":"c","campai')

    expect(q.pending().map((i) => i.id), 'saglam satirlar okunmali').toEqual(['a', 'b'])
  })

  it('tamamen bozuk dosya daemon\'i dusurmez', () => {
    writeFileSync(join(dir, 'impressions.jsonl'), 'bu\nhic\njson degil\n')
    const q = new ImpressionQueue({ dir })
    expect(q.pending()).toEqual([])
    expect(() => q.add(imp('a'))).not.toThrow()
    expect(q.pending().map((i) => i.id)).toEqual(['a'])
  })

  it('compact gonderilenleri atar, bekleyenleri korur', () => {
    const q = new ImpressionQueue({ dir })
    for (const id of ['a', 'b', 'c', 'd']) q.add(imp(id))
    q.markSent(['a', 'b'])
    q.compact()

    expect(q.pending().map((i) => i.id)).toEqual(['c', 'd'])
    // dosya gercekten kuculmus olmali
    expect(readFileSync(join(dir, 'impressions.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('compact sonrasi yeni kayit eklenebilir', () => {
    const q = new ImpressionQueue({ dir })
    q.add(imp('a')); q.markSent(['a']); q.compact()
    q.add(imp('b'))
    expect(q.pending().map((i) => i.id)).toEqual(['b'])
  })

  it('esik asilinca kendiliginden sikisir', () => {
    const q = new ImpressionQueue({ dir, compactAfter: 5 })
    for (let i = 0; i < 5; i++) q.add(imp(`x${i}`))
    q.markSent(['x0', 'x1', 'x2', 'x3', 'x4'])
    for (let i = 5; i < 11; i++) q.add(imp(`x${i}`))
    expect(q.pending().length).toBeLessThan(11)
  })

  it('kuyruk sisince EN ESKI kayitlar dusurulur — disk dolmasin', () => {
    const q = new ImpressionQueue({ dir, maxEntries: 10, compactAfter: 100 })
    for (let i = 0; i < 25; i++) q.add(imp(`x${String(i).padStart(2, '0')}`))
    q.compact()

    const ids = q.pending().map((i) => i.id)
    expect(ids).toHaveLength(10)
    expect(ids[0], 'en yeniler kalmali').toBe('x15')
    expect(ids.at(-1)).toBe('x24')
  })

  it('dosya izinleri 0600 — baska kullanici okuyamaz', () => {
    const q = new ImpressionQueue({ dir })
    q.add(imp('a'))
    expect(statSync(join(dir, 'impressions.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('reddedilen gosterimler de saklanir — red orani fraud girdisi', () => {
    const q = new ImpressionQueue({ dir })
    q.add({ ...imp('a'), rejectedReason: 'sure 3000ms < 10000ms' })
    expect(q.pending()[0]!.rejectedReason).toBe('sure 3000ms < 10000ms')
  })

  it('bos markSent hicbir sey yapmaz', () => {
    const q = new ImpressionQueue({ dir })
    q.add(imp('a')); q.markSent([])
    expect(q.pending()).toHaveLength(1)
  })
})
