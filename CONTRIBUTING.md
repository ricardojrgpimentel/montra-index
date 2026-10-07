# Contribuir para o catálogo

Toda a contribuição é um pull request que altera ficheiros em `apps/`. Não há
base de dados, não há painel de administração: o repositório é o sistema.

## O que entra

Uma app entra se cumprir **todos** estes critérios:

1. **Código-fonte público** num repositório legível, com licença aprovada pela OSI
   ou FSF, numa das que o schema aceita.
2. **O projeto publica APKs** em releases do GitHub (ou GitLab). Se só publica na
   Play Store ou em F-Droid sem URLs estáveis, não é indexável hoje.
3. **Está mantido**: commits nos últimos 12 meses. Projetos arquivados ou sem
   manutenção podem entrar com `status: "unmaintained"` ou `"archived"`, mas
   precisam de uma razão no `notes`.
4. **É útil a alguém.** Apps abandonadas, forks mortos e projetos pessoais vazios
   ficam de fora.
5. **Preferimos apps que não estão na Play Store** — é o ponto do projeto — mas
   apps que estão lá também entram, marcadas com `playStore.present: true`. Isso
   permite ao utilizador ver a diferença.

Não entram: apps com publicidade ou rastreadores sem aviso, apps que reempacotam
software proprietário sem o dizer, nem nada que exista só para contornar licenças.

## Como adicionar uma app

```bash
cd index
node tools/probe.mjs owner/repo        # confirma que o projeto publica APKs
node tools/discover.mjs --seed owner/repo --inspect   # package name real + Play Store
$EDITOR apps/a-minha-app.json          # escreve a entrada (ver docs/ADD_APP.md)
node tools/validate.mjs                # o mesmo que o CI corre
```

Se quiseres ser tu a resolver o release e a fixar o certificado:

```bash
node tools/build-index.mjs --only a-minha-app --deep 3 --update-pins
git diff apps/a-minha-app.json         # o pin aparece aqui, revisível
```

## Regras de revisão

Dois pontos são tratados como fronteira de confiança e exigem review explícita:

- **Um pin de certificado novo ou alterado.** Se um PR muda
  `verification.signingCertSha256`, o autor tem de explicar *porquê* e ligar ao
  anúncio do projeto de origem. Uma rotação de chave silenciosa é indistinguível
  de um release comprometido, e tratamo-la como suspeita até prova em contrário.
- **Uma alteração a `release.assetPattern`/`abiAssets`** que passe a escolher um
  APK diferente. O CI descarrega e verifica, mas quem revê deve confirmar que é o
  artefacto certo (e não, por exemplo, uma build de debug).

O CI corre `validate.mjs` e `build-index.mjs --dry` em cada PR. Um PR que não os
passe não é revisto.

## Estilo das entradas

- `summary`: uma linha, sem ponto final, até 160 caracteres, sem marketing.
- `description`: `en` obrigatório, `pt` bem-vindo. Diz o que a app faz e o que a
  distingue, sem superlativos.
- `categories`: da taxonomia fixa do schema, no máximo três.
- `tags`: minúsculas, com hífens.
- `license`: SPDX moderno (`GPL-3.0-or-later`, não `GPL-3.0`).
- `notes`: para quem mantém o catálogo. Não aparece na app.

## Alterar o schema ou as ferramentas

`schema/app.schema.json` é um contrato público: os clientes toleram campos novos
(ignoram o que não conhecem) mas não a ausência dos obrigatórios. Uma alteração que
parta um cliente instalado exige subir `schemaVersion` do índice e coordenar com
uma versão nova da app.
