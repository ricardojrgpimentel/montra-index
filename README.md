# openshelf-index

O catálogo. Um repositório de dados: ficheiros JSON que descrevem aplicações
Android de código aberto, um índice gerado e assinado, e as ferramentas que
mantêm tudo isso honesto.

**Este repositório é público de propósito.** O cliente não tem backend: se o
índice estivesse num repositório privado, a app precisaria de um token para o ler,
e um token dentro de um APK é um token público. Dados abertos, código da app
separado.

## O que está aqui

| Caminho | O que é | Editado por |
| --- | --- | --- |
| `apps/<id>.json` | Uma app. A fonte de verdade. | humanos, via pull request |
| `schema/app.schema.json` | O contrato que cada entrada cumpre | raramente |
| `index.json` | O catálogo resolvido e instalável | `tools/build-index.mjs` |
| `index.json.sig` | Assinatura destacada do índice | `tools/sign-index.mjs` |
| `icons/`, `screenshots/` | Média re-alojada (a app não fala com terceiros) | o build |
| `keys/index-signing.pub.pem` | Chave pública de confiança | `tools/keys.mjs init` |
| `tools/` | Validador, builder, assinador, verificador, descoberta | código |
| `discovery-report.json` | Último resultado de `tools/discover.mjs` | o build |

`index.json` nunca é editado à mão. Se editares, o CI rejeita.

## Comandos

```bash
pnpm install

node tools/validate.mjs                  # schema + regras cruzadas (o que o CI corre em cada PR)
node tools/build-index.mjs --dry         # resolve releases sem descarregar APKs (rápido)
node tools/build-index.mjs --only newpipe --deep 3 --update-pins
node tools/sign-index.mjs                # requer a chave privada
node tools/verify-index.mjs              # verifica a assinatura como um cliente faria
node tools/verify-index.mjs --artifact newpipe --rehash   # volta a descarregar e compara
node tools/verify-index.mjs --all --rehash                # tudo (1,3 GB, semanal em CI)

node tools/check-play.mjs --update       # grava "está na Play Store?" em cada entrada
node tools/probe.mjs owner/repo ...      # inspeciona repositórios candidatos
node tools/discover.mjs                  # procura apps novas no GitHub e classifica-as
node tools/keys.mjs show                 # chave pública + key id
```

## O ciclo de vida de uma entrada

```
apps/foo.json                     escrito à mão (ou por discover.mjs)
        │  --dry                    resolve o release e escolhe os assets
        │  build-index              descarrega os APKs, calcula sha256, lê o
        │                           manifest com aapt2 e o certificado com apksigner
        │  --update-pins           grava o certificado observado em apps/foo.json
        ▼
index.json + index.json.sig       assinado, verificado, commitado pelo CI
```

Três coisas que o builder verifica e que **falham o build** se não baterem certo:

1. o `packageName` real do APK (lido com `aapt2`) tem de ser o que a entrada diz;
2. o certificado de assinatura tem de corresponder ao pin em `apps/<id>.json`;
3. todas as ABIs do mesmo release têm de estar assinadas com a mesma chave.

O APK é a fonte de verdade. Nada aqui confia nos metadados do GitHub.

## GitHub Actions

- `validate.yml` — em cada pull request: schema, regras cruzadas, e cada app tem
  de resolver para um asset real (`--dry`). Não descarrega APKs, por isso é rápido
  e pode ser um check obrigatório.
- `build-index.yml` — noturno e manual: reconstrói, assina, verifica e faz commit.
  Precisa do secret `INDEX_SIGNING_KEY`.
- `verify-published.yml` — semanal: volta a descarregar tudo o que foi publicado e
  compara hashes e certificados. É a deteção de um asset substituído à posteriori.

### Secrets

| Nome | Obrigatório | Para quê |
| --- | --- | --- |
| `INDEX_SIGNING_KEY` | sim (build-index) | chave privada ECDSA P-256, conteúdo completo do PEM |
| `GITHUB_TOKEN` | automático | evita o limite de 60 pedidos/hora da API do GitHub |

A chave privada nunca entra no repositório (`.gitignore`). Guarda uma cópia
offline: se a perderes, os clientes instalados deixam de aceitar índices novos até
sair uma versão com outra chave.

## Contribuir

Ver [CONTRIBUTING.md](CONTRIBUTING.md) e [docs/ADD_APP.md](docs/ADD_APP.md). Em
resumo: um ficheiro por app, licença livre, APK publicado em releases, mantido, e
o package name verdadeiro.
