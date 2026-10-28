/**
 * Istegin gercek istemci adresi — hiz siniri, IP hash'i ve ulke tahmini icin.
 *
 * OLCULDU (2026-10-27, dwellsh.dev uzerinden, Railway kenari):
 *
 *   istemci basligi yok          → x-forwarded-for: "91.93.229.160, 152.233.12.245"
 *                                   x-real-ip:       "91.93.229.160"
 *   x-forwarded-for: 6.6.6.6     → 6.6.6.6 SILINDI, liste ayni
 *   x-real-ip: 6.6.6.6           → EZILDI, yine "91.93.229.160"
 *
 * Yani Railway istemcinin yazdigi iki basligi da atiyor. `x-real-ip` gercek
 * adres; `x-forwarded-for`'un SAG ucu ise Railway'in kendi kenar sunucusu —
 * genel (public) bir adres ve HER ISTEKTE DEGISIYOR (152.233.12.242,
 * 152.233.13.166, ...).
 *
 * Onceki surum sagdaki ilk genel adresi aliyordu: canlida her istek baska
 * bir kenar adresine, yani baska bir kovaya dustu ve `/v1/auth/*` hiz siniri
 * hic devreye girmedi. Ondan once de ilk degeri okuyorduk — o da Railway
 * onunde degilken istemcinin yazdigi deger demekti.
 *
 * Kural: once `x-real-ip`. Yoksa (Railway'in onunde olmayan bir kurulum)
 * `x-forwarded-for`'u sagdan okuyup ic ag adreslerini atla — istemci
 * listenin yalnizca SOL tarafina yazabilir.
 *
 * Uyari: bir vekilin arkasinda OLMADAN calisan sunucuda `x-real-ip`'i
 * istemci kendisi yazabilir. Uretim Railway'de; yerelde onemi yok.
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
  const real = header('x-real-ip')?.trim()
  if (real && isIP(real) !== 0) return real

  const list = (header('x-forwarded-for') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isInternal(list[i]!)) return list[i]
  }
  // Hepsi ic ag (yerel gelistirme): elde en iyi tahmin en soldaki.
  return list[0]
}
