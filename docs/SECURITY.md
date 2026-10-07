# Modelo de ameaças

Uma loja fora da Play Store distribui APKs que ninguém reviu linha a linha. O
objetivo deste documento é dizer, sem otimismo, o que o desenho protege e o que
não protege.

## O que o desenho garante

**1. O índice não pode ser alterado por quem serve os bytes.**

`index.json` é assinado (ECDSA P-256 / SHA-256) e a app traz a chave pública
dentro do APK. Um atacante que controle o DNS, um proxy, um CDN ou o próprio host
do repositório pode servir um índice falso — e a app rejeita-o, mantém o último
índice válido e diz ao utilizador que recebeu algo inválido. O mesmo para a cache
em disco: é re-verificada a cada arranque, não é confiada por vir de nós.

**2. O APK instalado é o APK que o índice descreve.**

Durante o download, o SHA-256 é calculado em streaming e comparado com o valor
assinado. Um ficheiro trocado no host de origem, um download truncado ou um CDN a
devolver outra coisa falham antes de o ficheiro chegar ao instalador.

**3. Um release assinado com outra chave falha no build, não no telefone.**

O fingerprint do certificado de assinatura é fixado por app (`verification.signingCertSha256`).
Se o repositório de origem publicar um APK assinado com outra chave — o cenário
realista quando alguém obtém direitos de publicação ou quando um projeto faz uma
rotação silenciosa —, `tools/build-index.mjs` **falha** em vez de atualizar o
índice. Mudar um pin é um ato explícito e aparece como diff num pull request.

**4. Nada é instalado sem verificação prévia.**

A verificação (sha256 + certificado) acontece antes de `PackageInstaller` abrir
uma sessão. A app não pede instalação silenciosa: o diálogo do sistema é sempre
mostrado ao utilizador.

## O que o desenho **não** garante

- **Que a app indexada seja benéfica.** Um APK pode ser livre, estar bem assinado
  e ser malware. O que garantimos é *origem*: vem do repositório que o catálogo
  refere e é o artefacto que o build verificou. Curação é humana, feita em PRs.
- **Que o código-fonte corresponda ao APK.** Fixamos o binário, não a
  reprodutibilidade do build. Um projeto pode publicar um APK que não corresponde
  ao código. Fechar isto exige builds reprodutíveis (modelo F-Droid), que é
  trabalho por app e está fora do âmbito da versão atual.
- **Que a chave do índice não seja comprometida.** A chave privada vive num
  secret de CI e numa cópia offline. Se for comprometida, um atacante pode
  publicar índices válidos. Contra isso resta a rotação de chave + atualização da
  app, e o histórico git do repositório, que é público.
- **Que o dispositivo do utilizador seja seguro.** Um dispositivo comprometido
  (root, sistema modificado) pode intercetar `PackageInstaller`.
- **Anonimato nas leituras.** O índice é servido por HTTPS de um host público,
  pelo que esse host vê o endereço IP de quem atualiza o catálogo. As imagens são
  re-alojadas no mesmo host precisamente para não haver pedidos a terceiros (nem
  uma fuga de informação para `githubusercontent` de cada app).
- **Privacidade do utilizador contra nós.** Não há analytics, não há conta, não há
  telemetria; a app fala apenas com o host do índice que o utilizador configurou.

## Rotação de chave

A chave de assinatura do índice está fixada no APK. Rodá-la exige:

1. gerar um novo par (`node tools/keys.mjs init` noutro diretório),
2. publicar uma versão da app que aceite **as duas** chaves,
3. esperar que a base instalada atualize,
4. passar a assinar só com a nova.

O passo 2 ainda não está implementado (`TrustStore` tem uma chave). É a limitação
conhecida mais importante e está registada no README.

## Reportar um problema

Se encontrares um APK que não corresponde ao índice, um pin de certificado que
mudou sem explicação, ou qualquer forma de contornar as verificações, abre uma
issue privada ou um security advisory no repositório. Não publiques provas de
conceito antes de haver correção.
