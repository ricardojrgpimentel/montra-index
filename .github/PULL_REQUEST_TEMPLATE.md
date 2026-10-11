## Que app(s) estou a adicionar ou alterar

<!-- ex.: adiciona apps/foo.json -->

## Checklist

- [ ] `node tools/validate.mjs` passa localmente
- [ ] A licença em `license` corresponde ao repositório (é software livre, SPDX correto)
- [ ] `packageName` é o applicationId real do APK (não uma suposição)
- [ ] `release.assetPattern`/`abiAssets` escolhe exatamente o APK certo
      (sem builds de debug, sem variantes de outra app)
- [ ] `summary` e `description.en` estão em inglês; a língua original está preservada e as traduções usam etiquetas BCP-47
- [ ] `categories` vem da taxonomia fixa do schema
- [ ] Corri `node tools/build-index.mjs --update-pins` e revi o diff dos pins

## Se este PR altera um fingerprint de certificado

<!-- Obrigatório: explica porque é que a chave de assinatura mudou. -->

- [ ] Confirmei, no repositório de origem, que a mudança de chave é intencional
      e anunciada pelo projeto (não é um release comprometido)
