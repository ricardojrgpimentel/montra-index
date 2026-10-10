# montra-index

> Visão geral do sistema (arquitetura, modelo de confiança, estado atual):
> [docs/OVERVIEW.md](docs/OVERVIEW.md).

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
| `license` / `licenseNote` | Licença livre, ou `LicenseRef-*` com nota obrigatória | os autores |
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
- `build-index.yml` — noturno, após alterações ao catálogo e manual: reconstrói, assina, verifica e faz commit.
  Precisa do secret `INDEX_SIGNING_KEY`.
- `discover-apps.yml` — segunda-feira às 07:29 UTC e manual: pesquisa apps novas,
  incluindo Shizuku/root, e inspeciona até 20 APKs de 120 repositórios avaliados.
  Mostra um resumo na execução e guarda JSON, resumo e log num artefacto durante
  90 dias. Usa apenas o `GITHUB_TOKEN` automático; não precisa da chave de assinatura.
  As candidatas não entram no catálogo até serem revistas.
- `propose-apps.yml` — manual: escolhe até cinco repositórios no formulário e recebe
  um PR em rascunho por app. Verifica APKs de todas as ABIs selecionadas, propõe o
  primeiro pin e procura imagens de fastlane. Não assina nem publica o catálogo.
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

### Consultar a descoberta de apps

Em **Actions → discover-apps**, abre a execução mais recente: o resumo lista as
candidatas e distingue APKs inspecionados de apps ainda por verificar. Descarrega
o artefacto `discovery-<número>` para consultar o relatório completo, incluindo
falhas e motivos de exclusão. **Run workflow** permite mudar os limites, acrescentar
pesquisas ou indicar repositórios específicos (`owner/repo`).

A ferramenta exclui repositórios já indexados, arquivados, sem manutenção nos
últimos 12 meses, bibliotecas, licenças não aceites e releases sem APK. Após a
inspeção, exclui também packages já indexados e APKs cuja assinatura não consiga
verificar. Requisitos de root/Shizuku, variantes e licença exata continuam a
precisar de confirmação na documentação oficial; uma correspondência na pesquisa
não prova esses requisitos. Para promover uma candidata, segue [docs/ADD_APP.md](docs/ADD_APP.md).

Para produzir o mesmo relatório localmente sem alterar `discovery-report.json`:

```bash
node tools/discover.mjs --inspect --limit 120 --inspect-limit 20 \
  --output .cache/discovery/report.json --summary .cache/discovery/summary.md
```

### Preparar e aprovar candidatas no GitHub

1. Em **Actions → propose-apps → Run workflow**, mantém a branch `main` e indica
   os repositórios escolhidos, por exemplo `z-huang/InnerTune,plainhub/plain-app`.
2. A execução cria um PR em rascunho por app e mostra as ligações no seu resumo.
   Cada PR inclui versões, hashes, certificado e referências ao projeto e licença.
   Uma proposta já aberta é preservada, incluindo as tuas edições. Repetir o
   formulário não recria PRs que já fechaste; para retomar uma proposta, reabre o PR.
3. No PR, usa **editar a entrada** para rever nome, resumo, categorias, tags e
   imagens, completar `description.pt` e declarar requisitos de acesso quando
   aplicável. A categoria inicial é `utilities`, uma sugestão genérica para rever.
   A identificação GPL do GitHub não prova "or later": confirma o SPDX exato na
   licença de origem. O pin é observado nos APKs, mas a sua origem também precisa
   de confirmação humana.
4. Marca a checklist no corpo do PR e escolhe **Ready for review**. O check de
   revisão exige todas as confirmações e uma descrição portuguesa preenchida;
   é normal falhar enquanto a proposta estiver em rascunho. Se o GitHub mostrar
   **Approve and run** para o workflow do PR criado pelo bot, autoriza essa execução.
5. Depois de os checks passarem, faz merge. O `build-index` reconstrói, assina e
   publica a app no catálogo; não é necessário copiar a chave privada.

Permissões: o job que descarrega e inspeciona APKs tem apenas leitura. Só o job
que cria branches e PRs recebe `contents: write` e `pull-requests: write`.
Nenhum deles recebe `INDEX_SIGNING_KEY`. Em **Settings → Actions → General**,
deve estar ativa a opção **Allow GitHub Actions to create and approve pull
requests**; o fluxo só cria PRs, nunca os aprova nem faz merge automaticamente.

## Licenças

O catálogo exige **código-fonte público**. Dentro disso há duas camadas:

- **Livre** (o caso normal, e quase todo o catálogo): uma das licenças OSI/FSF que
  o schema lista.
- **Restritiva** (`LicenseRef-*`): código disponível, uso limitado. Só entra com
  `antiFeatures: ["restrictedLicense"]` **e** uma `licenseNote` — as duas exigidas
  pelo validador, e ambas mostradas na app antes de instalar. Uma destas entradas
  é uma decisão explícita do projeto e tem de estar justificada em `notes`.

Código fechado não entra. Uma licença restritiva declarada não é o mesmo que
licença nenhuma, e a diferença é o que este catálogo insiste em tornar visível.

## Contribuir

Ver [CONTRIBUTING.md](CONTRIBUTING.md) e [docs/ADD_APP.md](docs/ADD_APP.md). Em
resumo: um ficheiro por app, licença livre, APK publicado em releases, mantido, e
o package name verdadeiro.
