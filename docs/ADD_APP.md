# Adicionar uma app, passo a passo

Vais criar `apps/<id>.json`. O `id` é um slug estável em minúsculas e passa a ser
a identidade da app no cliente: mudá-lo depois faz a app parecer nova.

## 1. Reconhecimento

```bash
node tools/probe.mjs owner/repo
```

Mostra licença, se está arquivado, o último release e **os nomes dos assets**. É
aqui que descobres se o projeto publica APKs e como se chamam.

```bash
node tools/discover.mjs --seed owner/repo --inspect
```

Descarrega um APK, corre `aapt2` para obter o **package name real** (não adivinhes:
um `applicationId` diferente do que está no README é o erro mais comum) e verifica
se existe na Play Store.

## 2. Escrever a entrada

```json
{
  "id": "exemplo",
  "name": "Exemplo",
  "summary": "Uma linha sobre o que faz, sem ponto final",
  "description": {
    "en": "What it does, and what makes it different.",
    "pt": "O que faz e o que a distingue."
  },
  "packageName": "com.exemplo.app",
  "license": "GPL-3.0-or-later",
  "sourceCode": "https://github.com/owner/repo",
  "author": "Quem a faz",
  "categories": ["utilities"],
  "tags": ["exemplo", "offline"],
  "icon": { "repo": "owner/repo", "path": "fastlane/metadata/android/en-US/images/icon.png" },
  "screenshots": [
    { "repo": "owner/repo", "path": "fastlane/metadata/android/en-US/images/phoneScreenshots/1.png" }
  ],
  "links": { "website": "https://exemplo.org", "donate": "https://exemplo.org/donate" },
  "release": {
    "provider": "github",
    "repo": "owner/repo",
    "assetPattern": "Exemplo-v*.apk",
    "versionScheme": "semver"
  },
  "playStore": { "present": false },
  "addedAt": "2026-10-07"
}
```

O ícone e os screenshots são **caminhos dentro do repositório**, não URLs. O build
descarrega-os e re-aloja-os em `icons/` e `screenshots/`, para que o cliente só
fale com um host. Aceita PNG, JPEG, WebP e GIF; SVG não (o cliente não tem
descodificador de vetores).

## 3. Escolher o APK certo

Este é o passo onde é fácil errar. Regras:

- **Um único APK universal** → `"assetPattern": "Exemplo-*.apk"`.
- **APKs por ABI** → usa `abiAssets`, com um padrão por arquitetura. É explícito e
  o cliente escolhe o certo para o dispositivo:

```json
"release": {
  "provider": "github",
  "repo": "owner/repo",
  "abiAssets": {
    "universal": "Exemplo-*-universal-release.apk",
    "arm64-v8a": "Exemplo-*-arm64-v8a-release.apk",
    "armeabi-v7a": "Exemplo-*-armeabi-v7a-release.apk"
  }
}
```

- **Há builds de debug no release** → `"excludePattern": "*debug*"`.
- **Há variantes que não interessam** (WebView ao lado do browser, versão
  `proprietary` ao lado da `libre`) → `excludePattern` ou padrões específicos.
- **O projeto publica noturnas num tag móvel** (KOReader faz isto com o tag `ota`)
  → usa `tagPattern: "v*"` para restringir aos releases estáveis.

Se o padrão casar com mais do que um asset e as ABIs não forem óbvias, o build
avisa e escolhe o maior. Lê os avisos: normalmente querem dizer que falta
configuração.

Releases sem APK não contam para o limite `--deep`: o builder procura os últimos
releases elegíveis que publicam APKs. Um APK antigo mantém a data original de
publicação no índice, para que o cliente possa mostrar o aviso de versão antiga.

## 3.1 Licenças que não são livres

Se o projeto tem o código público mas a licença impõe limitações (uso comercial,
concorrência, oferta como serviço), não é software livre e não pode ser declarado
como tal. Ainda assim pode entrar, se valer a pena para quem usa a loja:

```json
{
  "license": "LicenseRef-SustainableUse-1.0",
  "licenseNote": {
    "en": "Not a free licence. The source is public, but it may not be sold or hosted as a service.",
    "pt": "Não é uma licença livre. O código é público, mas não pode ser vendido nem oferecido como serviço."
  },
  "antiFeatures": ["restrictedLicense"]
}
```

O `node tools/validate.mjs` recusa a entrada se faltar qualquer uma das três
partes, e a app mostra a nota **antes** do botão de instalar. O identificador tem
de começar por `LicenseRef-` e dizer qual é a licença: nunca escrevas "MIT" (nem
outra licença livre) num projeto que não a tem.

Duas coisas a pesar antes de propor uma entrada destas: o catálogo existe para
software livre, e cada exceção tem de ser justificável em `notes`. Código fechado
não entra, com ou sem aviso: isso não é uma licença estranha, é ausência de
licença.

## 4. Validar e fixar o certificado

```bash
node tools/validate.mjs
node tools/build-index.mjs --only exemplo --deep 3 --update-pins
```

O primeiro corre o mesmo que o CI. O segundo descarrega o APK, confirma o package
name, lê o certificado de assinatura e **grava-o** em `verification.signingCertSha256`.
Revê esse diff: é a partir daqui que uma mudança de chave futura falha o build.

Que `--update-pins` só deve ser usado quando *sabes* que o pin está correto (a
primeira vez de uma app, ou depois de confirmares uma rotação anunciada).

## 5. Pull request

Preenche o template. Se o teu PR altera um pin, explica a mudança e liga ao
anúncio do projeto de origem.
