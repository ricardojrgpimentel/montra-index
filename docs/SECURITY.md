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

A chave de assinatura do índice está fixada no APK: uma chave fixada não se substitui
sem uma atualização da app. Com uma chave só, uma chave comprometida não tinha
substituição possível — quem a tivesse podia servir índices válidos a toda a base
instalada, para sempre. O cliente aceita agora **mais do que uma** chave, e é isso que
transforma a rotação num procedimento em vez de num beco.

O procedimento, por ordem, sem saltar passos:

1. gerar um novo par (`node tools/keys.mjs init` noutro diretório) e guardar a privada
   onde o segredo de CI passa a estar;
2. pôr a chave pública nova em `keys/`, com o nome `index-signing-<nome>.pub.pem`. A
   principal continua a ser `index-signing.pub.pem`, e é o nome do ficheiro que o diz;
3. publicar uma versão da app que traga as duas chaves. O
   `android/scripts/sync-index-assets.sh` copia todas as `keys/*.pub.pem`, e a app
   aceita um índice assinado por qualquer delas — dizendo nas Definições que a
   assinatura não é da chave principal, porque durante uma rotação isso é verdade e é
   útil sabê-lo;
4. esperar que a base instalada atualize. **Este passo demora o que demorar.** Uma app
   que não atualize continua a confiar só na chave antiga, e é por isso que a chave
   antiga não sai da lista a seguir;
5. passar a assinar com a nova (trocar o segredo de CI) e confirmar que o índice
   publicado é aceite;
6. só então tirar a chave antiga de `keys/`, numa versão da app que já não a precise.

O que isto **não** resolve: uma chave comprometida numa altura em que ainda não existe
uma versão publicada que aceite a nova. Nessa janela, a única defesa é o histórico git
do repositório, que é público, e a rapidez da rotação.

**O que falta:** correr isto uma vez, de verdade, numa chave de ensaio. Está escrito e
implementado; não está exercitado.

## A decisão sobre `provider: fdroid`

O `schema/app.schema.json` já prevê `release.provider: "fdroid"` e o validador já
exige `release.fdroidRepo` para ele, mas o builder só resolve `github`. Uma
entrada com outra fonte — `fdroid`, `gitlab` ou `direct` — não produz artefacto
nenhum: o build escreve um aviso no log e a app fica de fora do índice. Isto não
é uma tarefa em falta, é uma decisão de produto por tomar. Enquanto não estiver
escrito o que passa a estar garantido e o que deixa de estar, não se constrói
nada: um segundo modelo de confiança publicado em silêncio é pior do que uma
ausência.

### O que o modelo atual garante

O build fixa o artefacto que **ele próprio** inspecionou. Descarrega o APK do URL
do release, calcula o SHA-256 dos bytes que recebeu e lê o certificado de
assinatura do próprio ficheiro com o `apksigner`. Só depois é que o sha256 e o
fingerprint entram no índice, e é esse índice que a chave de assinatura cobre.
Nada aqui confia no que o host de origem afirma — nem no `versionCode`, nem no
nome do asset, nem no texto da release: o `aapt2` lê o package name real do
binário e o build falha se não corresponder à entrada. O pin de certificado é,
por app, o que o build observou no APK que guardou; um release assinado com
outra chave **falha o build** em vez de atualizar o índice.

### O que mudaria com o F-Droid como fonte de releases

O download deixava de vir do projeto de origem e passava a vir do que o índice do
F-Droid diz: que versão existe, em que URL, e o que ele afirmar sobre o
artefacto. Passa a confiar-se na chave que assina esse índice e na afirmação de
que o APK apontado foi construído a partir do código declarado. O pin de
certificado continua a ser nosso, mas muda de significado: passa a fixar a chave
com que o F-Droid assina, não a do projeto de origem. É por isso que uma mesma app
não pode ter, ao mesmo tempo, o pin da origem e o pin do F-Droid — são dois
binários diferentes para o mesmo package.

### Por decidir

- **Quem assina o APK.** Muitos projetos publicam assinados por si e o F-Droid
  republica com a chave do F-Droid. Se a entrada apontar para o F-Droid, o pin
  passa a ser o do F-Droid, e a versão assinada pelo projeto deixa de ser
  instalável por cima. Qual das duas o catálogo promete?
- **O que acontece a quem já tem a app instalada.** O Android recusa instalar por
  cima um APK assinado com outra chave: a atualização falha, e a saída é
  desinstalar (perdendo os dados) e reinstalar. Trocar de fonte obriga a essa
  escolha; se o catálogo não a explicar antes, o utilizador descobre-a com um erro
  do instalador.
- **Quem responde quando um APK do F-Droid não corresponde ao esperado.** Com a
  origem, o `verify-published.yml` volta a descarregar e compara, e quem publicou
  o ficheiro é o projeto. Com um intermediário, um sha256 que não bate certo pode
  ser do índice deles, do build deles ou de um espelho. Quem é avisado, e o que
  fica publicado até haver resposta?
- **Se o catálogo passa a ter duas fontes por app.** Manter origem e F-Droid ao
  mesmo tempo exige dizer ao cliente qual instalar; hoje o cliente recebe um
  artefacto preferido por app e não tem como escolher entre dois com chaves
  diferentes.
- **O que se indexa quando o F-Droid está atrasado.** O F-Droid acompanha as
  versões com atraso variável. A entrada passa a mostrar uma versão mais antiga do
  que a que o projeto publicou, e é essa que a app anuncia como disponível.

A implementação do builder fica pendente desta decisão.

## Reportar um problema

Se encontrares um APK que não corresponde ao índice, um pin de certificado que
mudou sem explicação, ou qualquer forma de contornar as verificações, abre uma
issue privada ou um security advisory no repositório. Não publiques provas de
conceito antes de haver correção.
