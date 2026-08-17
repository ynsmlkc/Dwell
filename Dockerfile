# Dwell sunucusu.
#
# Iki asamali: birinci asama derler, ikinci asama yalnizca sonucu tasir.
# Sebep guvenlik ve boyut — yayinlanan imajda kaynak kod, test, pnpm ve
# derleyici YOK. Calisan konteynerde ne kadar az sey varsa, saldiri
# yuzeyi o kadar kucuk.

# ─────────────────────────── derleme ───────────────────────────
FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

# Once yalnizca manifest'ler kopyalanir.
#
# Docker katmanlari icerige gore onbelleklenir: kaynak kod degistiginde
# `pnpm install` yeniden calismaz, cunku bu katmandaki dosyalar ayni. Her
# deploy'da bagimliliklari yeniden indirmek dakikalar eder.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json  packages/protocol/
COPY packages/payments/package.json  packages/payments/
COPY packages/server/package.json    packages/server/
COPY packages/cli/package.json       packages/cli/

# `--frozen-lockfile`: lock dosyasi ile package.json uyusmuyorsa PATLA.
# Sessizce farkli bir surum kurmasindansa deploy'un basarisiz olmasi iyidir.
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @dwell/server build

# ─────────────────────────── calisma ───────────────────────────
FROM node:24-alpine

WORKDIR /app

# root DEGIL. Konteynerden kacan bir aciğin makineyi de ele gecirmemesi icin.
#
# Ama `USER dwell` BURADA verilmiyor: Railway diski root'a ait baglaniyor ve
# sahipligini duzeltmek icin bir an root olmak gerekiyor. Entrypoint bunu
# yapip hemen `dwell` kullanicisina duserek node'u calistiriyor.
RUN addgroup -S dwell && adduser -S dwell -G dwell \
 && apk add --no-cache su-exec

# Tek dosya. Butun bagimliliklar esbuild ile iceri gomulu, bu yuzden
# `node_modules` TASINMIYOR — imaj ~150 MB yerine ~50 MB.
COPY --from=build --chown=dwell:dwell /app/packages/server/dist/server.mjs ./server.mjs
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Konteynerde 0.0.0.0 SART: 127.0.0.1'e baglanan bir sunucuya disaridan
# ulasilamaz ve platform "saglik kontrolu basarisiz" der.
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV DWELL_ENV=production

# Platform kendi PORT'unu verir; bu yalnizca yerelde calistirmak icin.
ENV PORT=8787
EXPOSE 8787

# Entrypoint diskin sahipligini duzeltip `exec` ile node'a devreder.
# `exec` sayesinde node 1 numarali surec olur ve SIGTERM'i dogrudan alir.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
