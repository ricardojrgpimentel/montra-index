# OpenShelf

Uma loja de aplicações Android **sem backend**. O catálogo é um ficheiro JSON num
repositório git; a app descarrega-o, verifica a assinatura digital e verifica cada
APK antes de o instalar. Não há servidor para manter, nem base de dados para
operar, nem conta para criar.

```
                    repositório git "openshelf-index" (público, só dados)
   apps/<id>.json ──► build-index ──► index.json ──► sign-index ──► index.json.sig
   (um ficheiro por   (resolve releases,  (48 apps)   (ECDSA P-256)   (+ chave pública
    app, via PR)       descarrega APKs,                                   no repositório)
                       calcula sha256,
                       lê certificados)
                              │
        ┌─────────────────────┴─────────────────────┐
        │  icons/ e screenshots/ re-alojados        │
        └───────────────────────────────────────────┘
                              │
                     HTTPS GET index.json + .sig
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ app Android (Kotlin + Compose, 1,6 MB)                       │
   │  1. verifica a assinatura do índice com a chave no APK       │
   │  2. mostra a lista, com cache em disco e snapshot offline    │
   │  3. ao instalar: descarrega → sha256 → certificado → instala │
   │     (em primeiro plano, com progresso na barra de notificações) │
   └──────────────────────────────────────────────────────────────┘
```

## Porque é que isto funciona sem servidor

Um catálogo é **dados + confiança**. Os dados cabem num ficheiro (128 KB para 30
apps) e o git já é um sistema de edição, revisão, histórico e distribuição
gratuito. O que falta é confiança, e isso resolve-se com criptografia em vez de
infraestrutura:

| Problema | Como é resolvido |
| --- | --- |
| Alguém altera o índice em trânsito ou no host | `index.json.sig`: assinatura ECDSA P-256 verificada contra uma chave pública incluída no APK |
| Alguém substitui o APK no repositório de origem | `sha256` fixado no índice, verificado durante o download |
| Alguém publica um APK diferente no mesmo repositório | Fingerprint do certificado de assinatura fixado em `apps/<id>.json`; um release assinado com outra chave **falha o build do índice** |
| A app é privada e precisa de token para ler o índice | O repositório do índice é público desde o primeiro dia: um token dentro de um APK é um token público |
| Alterar uma entrada sem deixar rasto | Cada app é um ficheiro; cada alteração é um pull request revisável, incluindo os pins de certificado |

## Estado atual

| | |
| --- | --- |
| Apps no catálogo | **48**, todas com release real, sha256 e certificado fixados |
| Fora da Google Play | **27** (verificado package a package contra a Play Store) |
| Categorias | **24 de 24** preenchidas, da taxonomia fixa do schema |
| Tamanho do índice | 208 KB (assinado) + 2,0 MB de ícones + 26 MB de screenshots |
| APKs indexados | 2,3 GB |
| Cliente | APK de release **1,67 MB** (R8), minSdk 26, sem dependências de UI de terceiros |
| Testes | 27 unitários (JVM) + 3 instrumentados num dispositivo real (rede, verificação e recusa de índice adulterado) |

Verificado com `node tools/check-play.mjs`: das 48 apps, 27 não existem na Play
Store (404 para o package name) e 21 existem (incluindo casos em que a versão da
Play está desatualizada, como o Termux).

## Estrutura

```
openshelf/
├── index/                     repositório do catálogo (público, dados)
│   ├── apps/*.json            fonte de verdade: 1 ficheiro por app
│   ├── schema/*.json          contrato, validado em CI
│   ├── index.json(.sig)       gerado + assinado, nunca editado à mão
│   ├── icons/ screenshots/    re-alojados para a app não falar com terceiros
│   ├── keys/*.pub.pem         chave pública de confiança (a privada vive em CI)
│   └── tools/                 validador, builder, assinador, verificador, descoberta
└── android/                   repositório da app (pode ser privado durante o desenvolvimento)
    └── app/src/main/java/dev/openshelf/
        ├── security/          verificação da assinatura e dos certificados
        ├── data/              índice: rede, cache, snapshot incluído
        ├── install/           download com hash em streaming + PackageInstaller
        └── ui/                Compose: lista, detalhe, definições
```

## Começar

```bash
# 1. catálogo
cd index
pnpm install
node tools/keys.mjs init                 # gera o par de chaves (a privada fica fora do git)
node tools/build-index.mjs --update-pins # descarrega APKs, calcula hashes, fixa certificados
node tools/sign-index.mjs                # index.json.sig
node tools/verify-index.mjs              # verifica como um cliente verificaria

# 2. app
cd ../android
./scripts/sync-index-assets.sh           # copia índice + chave pública para os assets
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Descobrir apps novas:

```bash
cd index
node tools/discover.mjs                       # procura no GitHub, filtra e classifica
node tools/discover.mjs --inspect --limit 10   # confirma package names e a Play Store
node tools/discover.mjs --inspect --write --limit 5   # cria rascunhos em apps/
```

## Verificado num dispositivo real

- O APK instala, arranca e não lança exceções (Samsung SM-G975F, Android 16).
- O índice publicado no GitHub é descarregado pela app, a assinatura é verificada
  **no processo da app** com a chave incluída no APK, e só depois é guardada em
  cache — com os bytes em cache a corresponderem exatamente aos verificados.
- Um índice com um byte alterado é recusado, tanto pelo verificador como pelo
  repositório (que não substitui um índice bom por um adulterado e explica porquê).
- O sha256 do `index.json` em `raw.githubusercontent.com` é idêntico ao do ficheiro
  assinado localmente.

## O que falta

- Rotação de chave de assinatura do índice (hoje exige uma atualização da app; é
  uma decisão deliberada, documentada em `index/docs/SECURITY.md`).
- Verificação de assinatura *antes* de mostrar o ícone de uma app nova (hoje o
  índice é verificado primeiro; as imagens são conteúdo não confiável servido do
  mesmo host, sem consequências de segurança).
- Verificação de atualizações em segundo plano (hoje acontece quando a app abre).
- Suporte a `provider: fdroid` no builder (o schema já o prevê).
- Repositório de índice federado: a app já aceita qualquer URL de índice, portanto
  um fork é uma loja nova.

Licença: AGPL-3.0-or-later para o catálogo e para a app.
