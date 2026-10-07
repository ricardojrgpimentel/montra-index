# Arquitetura

## A decisão central

Não há backend. O catálogo é um ficheiro num repositório git, e a confiança vem de
assinaturas em vez de infraestrutura. Tudo o resto decorre disto.

```
apps/*.json ──build──► index.json ──sign──► index.json.sig
                            │
                       HTTPS (estático, cacheável, espelhável)
                            │
                    app verifica e instala
```

## Onde vive a confiança

```
chave privada (CI secret, cópia offline)
        │ assina
        ▼
   index.json.sig  ──►  chave pública (dentro do APK do cliente)
                              │
                              ├──► sha256 de cada APK  ──► integridade do binário
                              └──► certificado de cada APK ──► identidade do publisher
```

Três verificações independentes, todas falham fechadas:

1. **Assinatura do índice** (`security/IndexVerifier`): ECDSA P-256/SHA-256 sobre
   os bytes exatos de `index.json`. Também confirma o `signingKeyId` declarado,
   que denuncia uma rotação de chave inesperada.
2. **SHA-256 do APK** (`security/ApkVerifier` + `install/ApkDownloader`): calculado
   em streaming durante o download. Um ficheiro diferente nem chega a ser guardado.
3. **Certificado de assinatura do APK**: lido com `PackageManager.getPackageArchiveInfo`
   e comparado com o fingerprint fixado no índice.

Escolhas explicáveis:

- **ECDSA P-256 em vez de Ed25519.** `SHA256withECDSA` existe em todas as versões
  de Android suportadas (`java.security`, sem dependências) e o Node assina
  nativamente. Ed25519 só existe a partir da API 28 e obrigaria a uma biblioteca de
  criptografia dentro do APK.
- **SHA-256 calculado durante o download, não depois.** O maior APK do catálogo tem
  309 MB; ler o ficheiro duas vezes num telemóvel é tempo e bateria desperdiçados.
- **A cache em disco é re-verificada a cada arranque.** É barato (128 KB) e evita
  confiar num ficheiro só porque foi escrito por nós.
- **Política de falha assimétrica.** Uma falha de rede é rotina: mantém-se o último
  catálogo verificado e mostra-se um erro discreto. Uma falha de *verificação* é um
  sinal de ataque: nunca substitui o que já temos e é mostrada de forma explícita.

## O índice gerado

`index.json` é auto-contido e não tem URLs absolutos:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-07T...",
  "signingKeyId": "4009b8eb68228f4020e56ddfcfd5b625",
  "apps": [{
    "id": "newpipe",
    "name": "NewPipe",
    "packageName": "org.schabi.newpipe",
    "license": "GPL-3.0-or-later",
    "icon": "icons/newpipe.png",
    "screenshots": ["screenshots/newpipe/1.png"],
    "signingCertSha256": "cb:84:06:...",
    "release": {
      "versionName": "0.29.1", "versionCode": 997,
      "tag": "v0.29.1", "publishedAt": "...", "changelog": "...",
      "assets": [{
        "abi": "universal",
        "url": "https://github.com/.../NewPipe_v0.29.1.apk",
        "sha256": "...", "size": 11534664,
        "signingCertSha256": "cb:84:06:...",
        "versionCode": 997, "minSdk": 21, "targetSdk": 35
      }]
    },
    "artifact": { "url": "...", "sha256": "...", "size": 11534664, "abi": "universal" }
  }]
}
```

**Caminhos relativos de propósito.** `icons/newpipe.png` é resolvido contra o URL
de onde o índice veio, não contra um host fixo. Um fork do repositório, um espelho
ou um servidor de testes local funcionam sem qualquer configuração — só se muda o
URL do índice na app.

**`versionCode` por asset, não só por release.** Projetos que publicam splits
atribuem versionCodes diferentes por ABI (o Obtainium faz isto: 2356 no universal,
23563 no arm64). O cliente compara a versão instalada com a do *asset* que
instalaria, não com o máximo do release.

**`artifact`** é a escolha preferida do builder, para clientes simples; a app usa
`bestAssetFor()` (ABIs do dispositivo, depois universal).

## O cliente

```
data/
  IndexSource     rede (ETag), cache em disco, snapshot nos assets, resolução de URLs relativas
  IndexRepository descarrega → verifica → publica estado; decide a política de falha
  Settings        DataStore (URL do índice, ETag). Nunca a chave de confiança.
security/
  TrustStore      a chave pública incluída no APK + o key id esperado
  IndexVerifier   assinatura do índice
  ApkVerifier     sha256 + certificado do APK
install/
  ApkDownloader   download com hash em streaming, retoma de cache
  InstallManager  verifica antes de criar a sessão; PackageInstaller; resultado por broadcast
ui/               Compose: lista, detalhe, definições (sem bibliotecas de UI de terceiros)
```

O snapshot incluído nos assets significa que a app funciona offline no primeiro
arranque. Foi gerado com a mesma chave que a app confia, por isso passa a mesma
verificação; se não passasse, a app recusava-o — e um teste unitário falhava.

## Escala

O modelo aguenta bem mais do que 30 apps: `index.json` são ~4 KB por app. Se um
dia forem milhares, o schema já permite partir o índice em shards (o cliente
resolve tudo contra o URL do índice, portanto `index.json` pode passar a apontar
para `shards/<letra>.json`). Enquanto couber num ficheiro, a simplicidade vale
mais do que a elegância.
