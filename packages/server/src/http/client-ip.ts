/**
 * Istegin gercek istemci adresi.
 *
 * `x-forwarded-for` her vekilin SONA ekledigi bir liste. Ilk deger istemcinin
 * kendi yazdigi seydir — `curl -H 'x-forwarded-for: 1.2.3.4'` ile istenen
 * adres taklit edilebilir. Onceden ilk deger okunuyordu; IP hash'i, hiz
 * siniri ve ulke tahmini istemcinin sectigi adrese gore calisiyordu.
 *
 * Guvenilir olan, bizim vekillerimizin ekledigi kisim: listenin SAG ucu.
 * Sagdan baslayip ozel/ic ag adreslerini (Railway'in kendi vekilleri) atlar,
 * ilk genel adresi aliriz. Istemci listenin yalnizca SOL tarafina yazabilir;
 * vekilin ekledigi gercek adresin saginda bir sey uyduramaz.
 */

import { BlockList, isIP } from 'node:net'

/** Ic ag, geri donus, CGNAT ve link-local — istemci adresi olamazlar. */
const INTERNAL = new BlockList()
for (const [net, prefix] of [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['127.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['0.0.0.0', 8],
] as const) INTERNAL.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]] as const) {
  INTERNAL.addSubnet(net, prefix, 'ipv6')
}

const isInternal = (ip: string): boolean => {
  const v = isIP(ip)
  return v === 0 ? false : INTERNAL.check(ip, v === 4 ? 'ipv4' : 'ipv6')
}

export function clientIp(header: (name: string) => string | undefined): string | undefined {
  const list = (header('x-forwarded-for') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isInternal(list[i]!)) return list[i]
  }
  // Hepsi ic ag (yerel gelistirme): elde en iyi tahmin en soldaki.
  if (list.length > 0) return list[0]
  return header('x-real-ip')?.trim() || undefined
}
