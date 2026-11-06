# Vupia --- Plano de evolução do scraping para workers distribuídos

**Documento de orientação para implementação assistida por IA**\
**Status:** proposta técnica para validação no repositório existente\
**Data:** 31/10/2026\
**Objetivo:** separar a execução pesada de scraping da API principal,
distribuir a carga entre VPS independentes e preservar o funcionamento
atual do Vupia.

------------------------------------------------------------------------

## 1. Instruções para a IA que receber este documento

Antes de alterar qualquer código:

1.  Leia a documentação existente do projeto e inspecione a
    implementação real da API, dos providers, do scraping, do cache, dos
    agendamentos e dos disparos.
2.  Identifique os módulos, nomes, contratos, tipos, padrões de erro e
    convenções já utilizados.
3.  Compare a arquitetura atual com esta proposta e produza uma análise
    de diferenças (*gap analysis*).
4.  Não crie uma segunda arquitetura paralela nem substitua componentes
    que já funcionam sem demonstrar a necessidade.
5.  Preserve os contratos públicos utilizados pelo frontend. A migração
    deve ser incremental e compatível com o comportamento atual.
6.  Não implemente tudo de uma vez. Siga as etapas deste documento,
    entregando em cada etapa um resumo dos arquivos alterados, decisões
    tomadas, riscos e testes realizados.
7.  Quando houver divergência entre este documento e o código real,
    priorize a arquitetura efetivamente existente e proponha o ajuste
    antes de modificar componentes estruturais.
8.  Não introduza Redis, RabbitMQ, Elasticsearch, Kubernetes ou outro
    serviço apenas por preferência. Primeiro avalie se MongoDB/Mongoose
    e a infraestrutura atual atendem à necessidade.
9.  Não presuma que uma VPS com determinada quantidade de vCPUs suporta
    a mesma quantidade de instâncias Chromium. A concorrência deve ser
    definida por benchmark.
10. Não remova o scraping atual até que o fluxo novo esteja validado e
    exista uma forma simples de voltar ao fluxo anterior.

**Primeira entrega esperada da IA:** um diagnóstico da implementação
existente e um plano de adaptação, sem alterar código. A implementação
só deve começar após a validação desse diagnóstico.

------------------------------------------------------------------------

## 2. Contexto do produto

O Vupia é uma plataforma de automação para afiliados. O sistema coleta
ofertas em diferentes lojas e permite que usuários selecionem, organizem
e divulguem essas ofertas em seus grupos de WhatsApp.

Plataformas já trabalhadas ou previstas incluem Shopee, Amazon, Mercado
Livre, AliExpress e Temu. A quantidade de integrações pode crescer.

O usuário precisa ter vínculo com o programa de afiliados da respectiva
loja. O Vupia trabalha com dois modelos gerais de integração:

-   **Integração simplificada por link:** o usuário fornece um link de
    afiliado. O sistema identifica os dados necessários e adapta os
    links das ofertas coletadas para incluir a identificação daquele
    afiliado.
-   **Integração por API/credenciais:** o usuário fornece as credenciais
    exigidas pelo programa de afiliados. Cada plataforma tem suas
    próprias regras, limitações e requisitos de autenticação.

A coleta das ofertas deve ser, sempre que possível, independente do
afiliado. Depois da coleta, o sistema aplica os dados de afiliação do
usuário ao link no formato específico de cada plataforma.

Há particularidades por plataforma. Por exemplo, a integração
simplificada da Shopee foi descontinuada no cenário atual do produto
devido a mudanças nas exigências de sessão/login. Não generalizar o
comportamento de uma plataforma para as demais.

------------------------------------------------------------------------

## 3. Estado atual conhecido

As informações abaixo foram relatadas durante o planejamento e devem ser
confirmadas no código antes da implementação.

### 3.1 Stack e arquitetura

-   API em **Node.js com TypeScript**.
-   Banco de dados **MongoDB**, acessado por **Mongoose**.
-   Arquitetura modular, com organização semelhante a MVC/arquitetura em
    camadas.
-   Dentro de `src` (ou `source`, confirmar o nome real no repositório),
    cada módulo possui:
    -   `router`
    -   `controller`
    -   `service`
    -   `repository`
-   O router encaminha as requisições ao controller.
-   O controller coordena a entrada e a resposta HTTP.
-   O service concentra as regras de negócio.
-   O repository é responsável pelo acesso ao banco.
-   Existem providers/adaptadores para realizar as buscas e integrações
    com cada plataforma.
-   A API principal está hospedada em um Droplet da DigitalOcean. A
    configuração relatada é aproximadamente 2 vCPUs, 8 GB de RAM e 200
    GB de disco, com custo mensal na faixa de US\$ 20--30. Confirmar o
    plano real.
-   Existe uma VPS Oracle Cloud com aproximadamente 4 vCPUs e 12 GB de
    RAM, já disponível para testes. Também existe a intenção de avaliar
    outras VPS de baixo custo ou gratuitas.

Não impor nomes de pastas ou interfaces sem antes verificar as
convenções existentes.

### 3.2 Scraping atual

-   A coleta utiliza Chromium/headless browser porque requisições HTTP
    simples, como Axios/Fetch, não conseguem reproduzir corretamente
    algumas páginas ou são bloqueadas por mecanismos anti-bot.
-   O navegador carrega as páginas e o sistema extrai o HTML
    renderizado.
-   Os providers identificam os padrões dos cards de ofertas, extraem os
    dados e fazem validações.
-   O sistema combina resultados de diferentes links de busca da mesma
    plataforma.
-   Em alguns casos, cada plataforma pode utilizar de três a quatro URLs
    de busca, que precisam ser processadas.
-   O algoritmo de extração e validação ficou mais robusto, mas passou a
    consumir mais CPU.
-   O resultado atualmente é HTML contendo os cards, que o frontend
    apresenta para o usuário escolher as ofertas.
-   A estimativa relatada de erro de extração é de aproximadamente
    1--2%; esse número deve ser medido com métricas reais, não tratado
    como garantia.
-   Links de scraping são configuráveis pela área administrativa. Quando
    um link deixa de funcionar, o administrador pode substituí-lo ou
    adicionar outro.

### 3.3 Cache atual

-   O HTML extraído é armazenado temporariamente em arquivos no disco da
    API, e não no MongoDB.
-   Há regra de validade/renovação de aproximadamente 30 minutos.
-   Se o mesmo usuário solicita novamente em um intervalo curto --- foi
    citado o exemplo de cinco minutos --- o sistema pode executar uma
    nova coleta para obter ofertas diferentes ou mais atualizadas.
-   Essa regra de freshness é intencional e deve ser preservada ou
    substituída por regra equivalente, não eliminada acidentalmente.
-   O cache atual deve ser analisado antes de criar outro. A proposta é
    evoluir sua localização e seu roteamento, não duplicar caches sem
    necessidade.

### 3.4 Problema observado

Com aproximadamente oito usuários, duas pessoas realizando scraping
simultaneamente já provocaram uso de 70--80% de CPU na API principal e,
em algumas situações, demora ou `network error`.

A hipótese principal é que o Chromium e a validação dos cards estejam
pressionando a CPU. Isso precisa ser confirmado com métricas, mas
justifica isolar o processamento pesado da API que atende o restante do
produto.

A API também executa outras responsabilidades, como autenticação,
usuários, assinaturas, notificações, administração, agendamentos e
operações relacionadas aos disparos. O scraping não deve comprometer
essas funções.

### 3.5 WhatsApp e automações

-   Cada usuário conecta sua própria conta/instância por meio da
    integração WASAP.
-   Os grupos e conexões são individualizados; não existe uma única
    conta central enviando mensagens por todos os usuários.
-   O backend controla intervalos mínimos e o agendamento dos disparos.
-   Disparos manuais também passam pelas regras de
    agendamento/limitação.
-   O sistema possui notificações e registros administrativos
    relacionados aos disparos.

**Escopo desta proposta:** distribuir a coleta de ofertas. Não alterar
as regras de disparo do WhatsApp, os limites de envio ou a integração
WASAP, exceto se uma dependência direta for identificada e aprovada.

------------------------------------------------------------------------

## 4. Objetivos da mudança

1.  Retirar o processamento pesado de Chromium da API principal.
2.  Executar scraping em processos/serviços independentes, chamados
    **workers**.
3.  Permitir adicionar ou remover VPS sem reescrever a API.
4.  Distribuir trabalhos conforme a disponibilidade real dos workers.
5.  Evitar que dois workers processem o mesmo job.
6.  Recuperar jobs quando um worker cair ou ficar indisponível.
7.  Preservar os providers, validadores e regras de negócio já
    existentes, adaptando-os para execução no worker.
8.  Manter o HTML temporário fora do MongoDB.
9.  Preservar o comportamento de cache e freshness do produto.
10. Evitar que uma falha no scraping derrube ou deixe lenta a API
    principal.
11. Manter o custo operacional baixo e a infraestrutura simples.
12. Permitir monitoramento administrativo de workers, filas e falhas.

### Fora do escopo inicial

-   Reescrever todos os providers.
-   Mudar o frontend sem necessidade contratual.
-   Alterar as integrações de afiliados.
-   Alterar o sistema de WhatsApp.
-   Migrar toda a infraestrutura para AWS.
-   Adotar Kubernetes ou Elasticsearch.
-   Criar uma plataforma complexa de observabilidade antes de haver
    necessidade comprovada.

------------------------------------------------------------------------

## 5. Arquitetura proposta

### 5.1 Visão geral

A proposta é manter a API principal na DigitalOcean e executar o
scraping em workers independentes nas VPS disponíveis.

``` mermaid
flowchart TD
    FE[Frontend Vupia] --> API[API principal - Node.js / TypeScript]
    API --> DB[(MongoDB / Mongoose)]
    API --> JOBS[Registro de jobs de scraping]
    JOBS --> DB

    DB --> W1[Worker 1 - Oracle Cloud]
    DB --> W2[Worker 2 - VPS adicional]
    DB --> W3[Worker 3 - VPS adicional]
    DB --> W4[Worker 4 - VPS adicional]

    W1 --> CH1[Chromium + Providers]
    W2 --> CH2[Chromium + Providers]
    W3 --> CH3[Chromium + Providers]
    W4 --> CH4[Chromium + Providers]

    W1 --> CACHE1[(Cache temporário local)]
    W2 --> CACHE2[(Cache temporário local)]
    W3 --> CACHE3[(Cache temporário local)]
    W4 --> CACHE4[(Cache temporário local)]

    W1 --> DB
    W2 --> DB
    W3 --> DB
    W4 --> DB

    API -->|Consulta resultado no worker proprietário| W1
    API -->|Consulta resultado no worker proprietário| W2
    API -->|Consulta resultado no worker proprietário| W3
    API -->|Consulta resultado no worker proprietário| W4
```

O diagrama é conceitual. A IA deve ajustá-lo aos contratos e ao fluxo
real do repositório.

### 5.2 Responsabilidades

**API principal** - Continua recebendo as requisições do frontend. -
Continua responsável por autenticação, autorização e regras de
negócio. - Valida os parâmetros do pedido de scraping. - Verifica se
existe resultado de cache válido conforme as regras atuais. - Quando
precisa de uma nova coleta, cria um job no MongoDB. - Acompanha o estado
do job e entrega o resultado ao frontend. - Não deve iniciar Chromium no
fluxo novo. - Não deve depender da memória local de um worker para saber
o estado do processamento.

**Workers** - Executam o processo de scraping. - Utilizam os providers e
validadores compatíveis com a implementação atual. - Abrem e controlam o
Chromium. - Processam as URLs necessárias para a plataforma. - Produzem
o HTML/resultado esperado pela API. - Armazenam temporariamente os
arquivos no disco local do worker, se essa estratégia for mantida. -
Atualizam o estado do job no MongoDB. - Enviam heartbeat e métricas de
saúde. - Não devem acessar diretamente os módulos internos da API nem
assumir responsabilidades de autenticação do usuário.

**MongoDB** - Mantém os registros de jobs, estado dos workers e
metadados pequenos de cache. - Não deve armazenar páginas HTML grandes
como padrão. - O acesso deve continuar encapsulado em repositories,
respeitando a arquitetura atual.

------------------------------------------------------------------------

## 6. Modelo de distribuição: workers buscam jobs disponíveis

A recomendação inicial é avaliar o modelo **pull**: a API registra jobs
pendentes e os workers consultam a fila compartilhada para assumir
trabalhos quando estiverem disponíveis.

Esse modelo evita que a API tenha que escolher um IP com base em uma
fotografia de CPU que pode ficar desatualizada.

### 6.1 Fluxo proposto

1.  O frontend solicita uma coleta à API.
2.  A API valida o pedido e verifica o cache.
3.  Se uma coleta nova for necessária, a API cria um job com estado
    `pending`.
4.  Um worker disponível consulta a fila.
5.  O worker tenta assumir atomicamente um job pendente.
6.  O MongoDB garante que apenas um worker consiga alterar aquele job de
    `pending` para `processing`.
7.  O worker executa o scraping.
8.  O worker salva o resultado temporário no local definido.
9.  O worker atualiza o job com o estado final e os metadados do
    resultado.
10. A API consulta o estado e entrega o resultado ao frontend.

### 6.2 Aquisição atômica

A aquisição do job deve ser feita por uma operação atômica do
MongoDB/Mongoose, como `findOneAndUpdate`, filtrando jobs elegíveis.

A operação deve: - Selecionar somente jobs `pending` ou jobs
`processing` cujo lease tenha expirado. - Atualizar o estado para
`processing`. - Registrar `workerId`. - Registrar `lockedAt` e
`lockedUntil`. - Incrementar `attempts`. - Registrar `startedAt`. -
Retornar o documento atualizado.

Não implementar o fluxo como `find()` seguido de `save()` separado, pois
dois workers poderiam ler o mesmo job antes de qualquer um atualizá-lo.

### 6.3 Polling

O worker consulta a fila quando tiver capacidade disponível. O intervalo
deve ser configurável e ajustado após testes.

Evitar consultas excessivamente frequentes ao MongoDB. É possível
começar com polling curto e controlado, aplicando pequeno backoff quando
não houver jobs.

O worker não deve buscar novos jobs quando todos os seus slots de
execução estiverem ocupados.

### 6.4 Lease e recuperação de jobs

Um job não pode permanecer eternamente em `processing` se o worker cair.

-   `lockedUntil` define até quando o worker possui a reserva do job.
-   Enquanto executa, o worker renova o lease/heartbeat do job em
    intervalos configuráveis.
-   Se o worker cair e não renovar, outro worker pode recuperar o job
    após a expiração.
-   Antes de recuperar, verificar se o job ainda pode ser executado e se
    não foi concluído.
-   Definir número máximo de tentativas.
-   Aplicar backoff entre tentativas.
-   Ao esgotar tentativas, marcar como `failed` e registrar a causa.

O tempo do lease deve ser maior que os intervalos normais entre
renovações e considerar a duração de uma coleta. Não fixar valores sem
observar a duração real.

### 6.5 Idempotência e duplicidade

Um job pode ser reexecutado após falha. Portanto: - A conclusão deve ser
idempotente. - O worker deve conferir se o job ainda pertence a ele
antes de atualizar o resultado. - Um worker antigo não pode sobrescrever
o resultado de um job que já foi recuperado e concluído por outro. -
Usar `jobId` como identificador estável. - Definir uma chave de
deduplicação para pedidos equivalentes, caso o comportamento atual
permita compartilhar uma mesma coleta. - Não deduplicar pedidos que,
pelas regras de freshness ou personalização, precisem gerar resultados
diferentes.

------------------------------------------------------------------------

## 7. Modelo de dados conceitual

Os nomes abaixo são sugestões. A IA deve adaptar aos schemas e
convenções existentes.

### 7.1 ScrapingJob

Campos possíveis:

  -----------------------------------------------------------------------
  Campo                   Tipo sugerido           Finalidade
  ----------------------- ----------------------- -----------------------
  `jobId`                 string/UUID             Identificador da
                                                  aplicação

  `status`                enum/string             `pending`,
                                                  `processing`,
                                                  `completed`, `failed`,
                                                  `cancelled`

  `platform`              string                  Plataforma solicitada

  `provider`              string                  Provider responsável,
                                                  se aplicável

  `parameters`            objeto                  Parâmetros necessários
                                                  à coleta

  `requestedBy`           string                  Identificador do
                                                  usuário, se necessário

  `workerId`              string/null             Worker que assumiu o
                                                  job

  `attempts`              number                  Quantidade de
                                                  tentativas

  `maxAttempts`           number                  Limite de tentativas

  `lockedAt`              Date/null               Início da reserva

  `lockedUntil`           Date/null               Expiração do lease

  `createdAt`             Date                    Criação

  `startedAt`             Date/null               Início do processamento

  `completedAt`           Date/null               Conclusão

  `errorCode`             string/null             Código de erro

  `errorMessage`          string/null             Mensagem sanitizada

  `resultLocation`        objeto/null             Localização do
                                                  resultado

  `durationMs`            number/null             Duração total

  `correlationId`         string                  Rastreamento entre API
                                                  e worker
  -----------------------------------------------------------------------

Não armazenar credenciais sensíveis desnecessárias nos parâmetros do
job. Quando uma credencial for indispensável, definir um mecanismo
seguro de referência/obtenção, sem gravá-la em logs.

### 7.2 ScrapingWorker

  -----------------------------------------------------------------------
  Campo                   Tipo sugerido           Finalidade
  ----------------------- ----------------------- -----------------------
  `workerId`              string/UUID             Identificador estável

  `name`                  string                  Nome legível

  `host`                  string                  Host/DNS, se necessário

  `status`                enum/string             `online`, `busy`,
                                                  `offline`, `draining`,
                                                  `error`

  `lastHeartbeatAt`       Date                    Último heartbeat

  `cpuUsage`              number                  Uso de CPU observado

  `memoryUsage`           number                  Memória utilizada ou
                                                  percentual

  `memoryAvailable`       number                  Memória disponível, com
                                                  unidade definida

  `activeJobs`            number                  Jobs em execução

  `maxConcurrency`        number                  Limite configurado de
                                                  jobs simultâneos

  `version`               string                  Versão do worker

  `lastError`             string/null             Último erro sanitizado

  `startedAt`             Date                    Início do processo

  `updatedAt`             Date                    Última atualização
  -----------------------------------------------------------------------

Não usar IP como identidade principal do worker: IP pode mudar. Usar
`workerId` estável e manter host/IP como metadados operacionais.

### 7.3 CacheEntry / metadados do cache

Se o cache passar a ser distribuído entre workers, manter no banco
somente metadados pequenos:

  Campo               Tipo sugerido   Finalidade
  ------------------- --------------- -------------------------------
  `cacheId`           string/UUID     Identificador
  `cacheKey`          string          Chave que representa a coleta
  `workerId`          string          Worker que contém o arquivo
  `filePath`          string          Caminho local no worker
  `createdAt`         Date            Criação
  `expiresAt`         Date            Expiração
  `platform`          string          Plataforma
  `freshnessPolicy`   objeto/string   Regra de atualização aplicada

A chave deve considerar todos os parâmetros que realmente alteram o
resultado. Não incluir dados pessoais ou credenciais em texto puro.

------------------------------------------------------------------------

## 8. Estratégia de cache e entrega do HTML

Esta é uma decisão arquitetural importante e deve ser validada antes da
implementação distribuída.

### 8.1 O que preservar

-   A regra atual de cache e atualização de aproximadamente 30 minutos
    deve ser considerada.
-   A regra de nova coleta em intervalos menores, como o exemplo de
    cinco minutos, deve continuar funcionando conforme a lógica atual do
    produto.
-   A decisão de reutilizar ou atualizar um resultado deve considerar
    plataforma, parâmetros de busca, usuário quando relevante e política
    de freshness.
-   Não servir conteúdo vencido como se fosse atual.

### 8.2 HTML local no worker

Manter o HTML em disco local evita enviar páginas grandes ao MongoDB.
Porém, cria uma dependência importante: o resultado fica no worker que o
produziu.

Se a próxima requisição chegar à API, ela precisa saber qual worker
possui o arquivo. Portanto: - A API consulta os metadados do cache. - Se
o cache ainda for válido, identifica o `workerId` proprietário. - A API
solicita o conteúdo ao endpoint interno daquele worker. - O worker
valida a autorização da chamada e retorna o arquivo. - Se o worker
estiver offline ou o arquivo não existir, a API invalida o metadado e
agenda nova coleta. - O caminho local nunca deve ser exposto ao
frontend. - O endpoint interno não pode ficar aberto publicamente sem
autenticação.

O worker deve aplicar limites de tamanho, timeout e validação do arquivo
solicitado. Não aceitar caminhos arbitrários enviados pelo cliente;
preferir buscar o arquivo por `cacheId` conhecido.

### 8.3 Alternativas a avaliar

A IA deve comparar estas alternativas com o código atual:

**Alternativa A --- arquivo local no worker + metadados no MongoDB** -
Menor tráfego e não exige serviço de armazenamento adicional. - A API
precisa buscar o resultado no worker proprietário. - Se o worker cair ou
perder o disco, o cache fica indisponível e será necessário refazer a
coleta. - Boa opção inicial se os arquivos forem temporários e puderem
ser recriados.

**Alternativa B --- API recebe o HTML do worker** - Worker envia o
resultado à API, e a API mantém o cache temporário local como hoje. -
Mais simples para a API servir o conteúdo e não depende de consultar o
worker posteriormente. - Aumenta tráfego entre worker e API e mantém uso
de disco na API. - Pode ser uma etapa intermediária de migração.

**Alternativa C --- armazenamento compartilhado de objetos** - Todos os
workers e a API acessam o mesmo armazenamento. - Evita dependência do
disco de um worker específico. - Acrescenta custo e configuração. - Só
adotar se a indisponibilidade do cache local ou o tráfego entre serviços
justificar.

**Recomendação inicial:** não decidir isso por suposição. Fazer uma
prova de conceito com um worker. Se o HTML for temporário, pequeno o
suficiente e puder ser refeito, a Alternativa A é viável. Se a
simplicidade operacional for mais importante no primeiro estágio, a
Alternativa B pode facilitar a migração. Não armazenar HTML grande no
MongoDB como solução padrão.

### 8.4 Limpeza

Implementar rotina de expiração no worker para remover arquivos vencidos
e metadados órfãos. A limpeza não deve apagar arquivos ainda associados
a jobs em andamento nem arquivos dentro do período de validade.

------------------------------------------------------------------------

## 9. Métricas e seleção de capacidade

A proposta inicial de escolher o worker com menor CPU e atualizar os
dados a cada três minutos é simples, mas pode ficar desatualizada. Uma
leitura de CPU isolada não mostra quantos jobs já foram enviados e ainda
não começaram.

No modelo pull, o próprio worker controla quantos jobs pode assumir.
Ainda assim, as métricas são úteis para monitoramento e para impedir
novas aquisições quando o worker estiver sob pressão.

### 9.1 Métricas mínimas

-   Heartbeat e tempo desde o último contato.
-   Jobs ativos.
-   Limite de concorrência.
-   CPU.
-   Memória disponível/uso de memória.
-   Duração média e percentis de execução.
-   Quantidade de jobs pendentes.
-   Quantidade de jobs com falha e tentativas.
-   Tempo de espera na fila.
-   Último erro e versão do worker.

### 9.2 Frequência inicial sugerida

-   Heartbeat: a cada 15--30 segundos.
-   Atualização de métricas: a cada 15--30 segundos.
-   Painel/histórico administrativo: agregação a cada poucos minutos, se
    necessário.

Os intervalos são pontos de partida, não requisitos rígidos. Ajustar
após medir carga no MongoDB e comportamento das VPS.

### 9.3 Concorrência

Começar conservadoramente, por exemplo, com **um job Chromium simultâneo
por worker**. Fazer benchmark em cada VPS e aumentar apenas quando: -
CPU não permanecer saturada; - memória tiver margem suficiente; - não
houver crescimento anormal de erros/timeouts; - latência permanecer
aceitável; - o processo não comprometer a estabilidade do host.

Não assumir que quatro vCPUs significam quatro scrapes simultâneos.
Chromium pode criar múltiplos processos e consumir memória/CPU de forma
variável.

------------------------------------------------------------------------

## 10. Organização do código e respeito à arquitetura existente

A IA deve preservar o padrão modular atual:

``` text
src/
  modules/
    <existing-modules>/
      router/
      controller/
      service/
      repository/
```

O nome real pode ser `source` ou outra convenção; confirmar no
repositório.

### 10.1 Possíveis módulos envolvidos

Apenas se fizer sentido na estrutura atual:

-   **scraping**: entrada e coordenação das solicitações de scraping.
-   **scraping-jobs**: ciclo de vida e consulta dos jobs.
-   **workers**: registro, heartbeat e estado dos workers.
-   **scraping-cache**: metadados e regras de cache.
-   **providers**: integrações e extração específicas por plataforma.

Esses nomes são sugestões. Se os módulos ou serviços equivalentes já
existirem, reutilizá-los.

### 10.2 Responsabilidades por camada

**Router** - Define endpoints e middlewares. - Não contém regra de
negócio.

**Controller** - Valida/normaliza a entrada HTTP conforme os padrões
existentes. - Chama o service. - Formata a resposta.

**Service** - Coordena a criação/acompanhamento de jobs. - Aplica regras
de cache/freshness. - Não executa consultas Mongoose diretamente.

**Repository** - Encapsula operações Mongoose. - Implementa aquisição
atômica, atualização de lease, busca por status e metadados. - Não
contém regras de apresentação HTTP.

**Provider** - Implementa o comportamento específico de uma
plataforma. - Deve ser reutilizável pelo worker. - Evitar duplicar
lógica de extração na API e no worker.

**Worker runtime** - Inicializa o processo, verifica configuração, envia
heartbeat, adquire jobs e executa os providers. - Não deve importar
controllers ou routers da API apenas para reutilizar lógica. -
Reutilizar serviços/providers compartilháveis por uma fronteira de
código clara.

### 10.3 Processo separado

Avaliar se o worker deve ser: - um processo Node.js separado no mesmo
repositório, com entrypoint próprio; ou - um serviço/repositório
independente, compartilhando um pacote interno com providers e
contratos.

Para a primeira implementação, preferir a opção que exija menos
duplicação e menor mudança no repositório. Não misturar o processo HTTP
da API com o loop contínuo de execução de jobs.

------------------------------------------------------------------------

## 11. Comunicação e segurança entre API e workers

A fila no MongoDB pode ser o mecanismo inicial de coordenação. A entrega
do HTML, caso fique local no worker, exige comunicação HTTP interna ou
mecanismo equivalente.

Requisitos: - Toda comunicação interna deve ser autenticada. - Usar
segredo/token próprio por ambiente ou mecanismo de assinatura. - Não
expor endpoints de administração de worker ao frontend. - Restringir
acesso por firewall/rede sempre que possível. - Usar HTTPS/TLS quando o
tráfego atravessar redes públicas. - Aplicar timeout em chamadas entre
API e worker. - Validar `workerId`, `jobId` e `cacheId`. - Não aceitar
caminhos de arquivo arbitrários. - Não registrar API keys, senhas,
cookies ou tokens em logs. - Rotacionar segredos quando necessário. -
Limitar tamanho de payload e de resposta. - Validar os parâmetros do job
antes da execução.

As credenciais dos programas de afiliados devem continuar sob as regras
de segurança existentes. O worker deve receber apenas o necessário para
a tarefa e pelo menor tempo possível.

------------------------------------------------------------------------

## 12. Tratamento de falhas

  -----------------------------------------------------------------------
  Situação                            Comportamento esperado
  ----------------------------------- -----------------------------------
  Worker fica offline                 Heartbeat expira; worker é marcado
                                      como offline

  Worker cai durante um job           Lease expira e job pode ser
                                      recuperado

  Chromium trava                      Timeout, encerramento controlado do
                                      processo e falha/retry

  Provider retorna erro               Registrar erro específico e aplicar
                                      política de retry

  Todos os workers ocupados           Job permanece pendente na fila

  MongoDB indisponível                Worker não assume novos jobs;
                                      registra erro local e tenta
                                      reconectar com backoff

  API não consegue consultar worker   Invalidar ou marcar cache como
  proprietário                        indisponível e decidir se refaz a
                                      coleta

  Arquivo de cache não existe         Remover/inutilizar metadado e gerar
                                      nova coleta

  Job excede tempo máximo             Encerrar execução conforme política
                                      e liberar/reclassificar job

  Resultado chega após lease perdido  Worker antigo não pode sobrescrever
                                      o resultado atual
  -----------------------------------------------------------------------

Não repetir automaticamente erros permanentes, como parâmetros inválidos
ou credenciais recusadas, sem uma política específica.

------------------------------------------------------------------------

## 13. Observabilidade e administração

Criar somente o necessário para operar com segurança.

### 13.1 Logs estruturados

Cada execução deve permitir correlacionar: - `jobId` - `workerId` -
plataforma/provider - horário de criação/início/fim - duração -
quantidade de páginas/URLs processadas - quantidade de cards extraídos e
aprovados/rejeitados - tentativa - código de erro

Não registrar conteúdo sensível, cookies, credenciais ou dados pessoais
desnecessários.

### 13.2 Painel administrativo futuro

Informações úteis: - workers online/offline; - CPU e memória; - jobs
ativos por worker; - slots livres; - tamanho da fila; - tempo médio de
espera; - duração média por plataforma; - taxa de sucesso/falha; -
workers em manutenção (`draining`).

A ausência do painel não deve bloquear a primeira prova de conceito.
Logs e consulta controlada ao MongoDB podem ser suficientes no começo.

------------------------------------------------------------------------

## 14. Plano de implementação por etapas

### Etapa 0 --- diagnóstico do repositório

**Objetivo:** entender o que já existe e evitar reescrita.

Tarefas: 1. Ler a documentação `.md` existente. 2. Mapear módulos e
camadas. 3. Localizar providers e código Chromium. 4. Mapear como os
links de busca são configurados. 5. Mapear extração, validação e
combinação de cards. 6. Mapear cache atual e rotina de limpeza. 7.
Identificar formato de resposta consumido pelo frontend. 8. Identificar
timeouts, limites e tratamento de erros. 9. Identificar como o scraping
é chamado e quais outros fluxos dependem dele. 10. Medir uso atual de
CPU, memória e duração por plataforma, se houver dados.

**Entrega:** relatório de arquitetura atual, diferenças em relação à
proposta e plano detalhado de mudanças. Nenhum código alterado nesta
etapa.

### Etapa 1 --- preparar o scraping para execução isolada

**Objetivo:** desacoplar o núcleo de scraping do ciclo HTTP da API.

Tarefas: 1. Separar a execução do scraping de controllers e routers. 2.
Identificar serviços/providers que podem ser reutilizados. 3. Definir
contratos tipados de entrada e saída. 4. Padronizar timeout,
cancelamento e erros. 5. Criar um entrypoint de worker sem ainda
distribuir jobs. 6. Permitir executar um scraping localmente por esse
entrypoint. 7. Manter o endpoint antigo funcionando.

**Critério de aceite:** o worker executa uma coleta e produz o mesmo
formato de resultado esperado pelo fluxo atual.

### Etapa 2 --- primeiro worker na Oracle

**Objetivo:** provar a execução fora da API principal.

Tarefas: 1. Preparar a VPS Oracle existente. 2. Instalar/runtime Node.js
compatível com o projeto. 3. Instalar dependências e Chromium conforme a
biblioteca já utilizada. 4. Configurar variáveis de ambiente e segredos.
5. Criar serviço de execução e reinicialização automática. 6. Configurar
logs e health check. 7. Executar testes de uma plataforma por vez. 8.
Medir CPU, RAM, tempo e estabilidade. 9. Testar reinicialização da VPS e
do processo.

**Critério de aceite:** um worker Oracle executa scraping de forma
estável sem Chromium rodando na API principal.

### Etapa 3 --- fila de jobs no MongoDB

**Objetivo:** criar coordenação confiável entre API e workers.

Tarefas: 1. Criar/ajustar schema e repository de jobs. 2. Criar service
para registrar e consultar jobs. 3. Implementar aquisição atômica. 4.
Implementar lease e renovação. 5. Implementar tentativas, backoff e
timeout. 6. Implementar estados e transições válidas. 7. Criar polling
controlado no worker. 8. Garantir que um job não seja processado
simultaneamente por dois workers. 9. Criar logs com `jobId` e
`workerId`.

**Critério de aceite:** jobs são processados uma única vez por vez; jobs
abandonados são recuperados após expiração do lease.

### Etapa 4 --- integrar API e worker sem alterar o frontend

**Objetivo:** fazer a API encaminhar a coleta para o worker mantendo o
contrato atual.

Tarefas: 1. Adaptar o service atual para criar job. 2. A API acompanhar
o job com timeout e estratégia de espera adequada. 3. Definir como o
frontend recebe resultado, processamento pendente ou erro. 4. Preservar
o formato de resposta atual sempre que possível. 5. Se necessário, usar
polling interno da API ou endpoint de consulta de job. 6. Não manter
requisição HTTP aberta indefinidamente. 7. Criar fallback controlado
para o scraping antigo durante a migração. 8. Testar cancelamento e
timeout.

**Critério de aceite:** o frontend continua funcionando sem precisar
conhecer os workers.

### Etapa 5 --- cache e entrega do resultado distribuído

**Objetivo:** definir e implementar a propriedade do cache.

Tarefas: 1. Comparar as alternativas da seção 8. 2. Escolher formalmente
onde os arquivos temporários ficam. 3. Se forem locais ao worker,
registrar `workerId`, `cacheId` e expiração. 4. Criar endpoint interno
autenticado para recuperar o arquivo. 5. Validar existência, validade e
integridade do arquivo. 6. Implementar limpeza de arquivos expirados. 7.
Tratar worker offline e cache perdido. 8. Preservar a regra de freshness
atual. 9. Testar requisição seguinte chegando à API enquanto o arquivo
está em outro worker.

**Critério de aceite:** a API consegue entregar um resultado válido
independentemente de qual worker o produziu, ou refazer a coleta de
maneira controlada.

### Etapa 6 --- heartbeat e controle de capacidade

**Objetivo:** conhecer a saúde e capacidade de cada worker.

Tarefas: 1. Registrar worker no início do processo. 2. Enviar heartbeat
periódico. 3. Atualizar CPU, memória e jobs ativos. 4. Definir slots e
concorrência máxima configurável. 5. Marcar worker como offline após
ausência de heartbeat por período definido. 6. Permitir estado
`draining` para parar de aceitar novos jobs durante manutenção. 7.
Iniciar com concorrência conservadora. 8. Executar benchmark para
ajustar concorrência.

**Critério de aceite:** workers indisponíveis não recebem jobs novos e
workers ocupados não ultrapassam o limite configurado.

### Etapa 7 --- múltiplas VPS

**Objetivo:** adicionar capacidade horizontal.

Tarefas: 1. Preparar segunda VPS. 2. Implantar exatamente a mesma versão
do worker. 3. Usar `workerId` distinto e configuração própria. 4.
Validar aquisição concorrente de jobs. 5. Adicionar demais VPS
gradualmente. 6. Testar desligamento de um worker durante carga. 7.
Observar fila, latência, erros e custo. 8. Documentar procedimento para
adicionar/remover worker.

**Critério de aceite:** adicionar uma VPS aumenta a capacidade sem
alteração no código da API.

### Etapa 8 --- operação e otimização

**Objetivo:** tornar o sistema operável em produção.

Tarefas: 1. Criar visão administrativa mínima. 2. Definir alertas para
fila acumulada, worker offline e falha elevada. 3. Revisar logs e
métricas. 4. Ajustar polling e leases com dados reais. 5. Revisar
política de cache e limpeza. 6. Fazer teste de carga gradual. 7.
Documentar deploy, rollback e recuperação. 8. Desativar o fluxo antigo
somente após estabilidade comprovada.

------------------------------------------------------------------------

## 15. Testes obrigatórios

A IA deve propor testes compatíveis com a estrutura de testes existente.
Se o projeto não possuir suíte automatizada, começar pelos testes de
integração essenciais e logs verificáveis.

1.  Um worker adquire um job pendente.
2.  Dois workers tentam adquirir simultaneamente; apenas um vence.
3.  Worker conclui job com sucesso.
4.  Worker falha e job pode ser repetido.
5.  Worker cai e lease expira.
6.  Worker antigo tenta atualizar job após perder o lease.
7.  Job excede o número máximo de tentativas.
8.  Todos os workers estão ocupados.
9.  Worker fica offline e deixa de receber jobs.
10. API recebe resultado do worker correto.
11. Cache aponta para worker que está offline.
12. Arquivo expirado é removido.
13. Arquivo inexistente não é servido.
14. HTML retornado mantém compatibilidade com o frontend.
15. Duas solicitações equivalentes respeitam a política de
    cache/deduplicação.
16. Solicitações que exigem freshness não recebem resultado antigo.
17. Falha de scraping não afeta autenticação e outros endpoints da API.
18. Reiniciar API não perde jobs pendentes.
19. Reiniciar worker não deixa job permanentemente preso.
20. Segredos não aparecem em logs ou respostas.

------------------------------------------------------------------------

## 16. Segurança e confiabilidade operacional

-   Usar variáveis de ambiente para configuração e segredos.
-   Não versionar `.env` nem credenciais.
-   Validar parâmetros e URLs antes de iniciar Chromium.
-   Restringir destinos de navegação aos domínios/plataformas
    autorizados, evitando que o serviço seja usado para acessar
    endereços internos ou arbitrários.
-   Definir limites de navegação, tamanho, tempo e quantidade de
    páginas.
-   Encerrar processos Chromium órfãos após falha.
-   Limitar o número de jobs simultâneos.
-   Aplicar timeout de execução e de comunicação.
-   Não confiar em métricas reportadas sem validar heartbeat e
    identidade do worker.
-   Manter logs sem credenciais e tokens.
-   Proteger endpoints internos com autenticação e restrições de rede.
-   Garantir que a atualização de estado do job verifique o `workerId` e
    a posse válida do lease.

------------------------------------------------------------------------

## 17. Decisões que precisam ser confirmadas no repositório

A IA deve responder estas perguntas no diagnóstico:

1.  O Chromium é iniciado a cada requisição ou existe um
    processo/browser persistente que cria novas páginas?
2.  As URLs de busca de uma plataforma são processadas sequencialmente
    ou em paralelo?
3.  Qual biblioteca controla Chromium (Puppeteer, Playwright ou outra)?
4.  Qual é o formato exato do HTML retornado ao frontend?
5.  O frontend precisa receber HTML completo ou poderia consumir um
    contrato JSON de cards em uma evolução futura?
6.  O cache atual é por usuário, plataforma, busca ou combinação desses
    parâmetros?
7.  O que exatamente determina a nova coleta em cinco minutos e a
    validade de 30 minutos?
8.  Há tarefas de scraping que dependem de credenciais individuais?
9.  Como são configurados e atualizados os links de busca?
10. A API e os workers terão acesso ao mesmo MongoDB Atlas/instância?
    Quais limites de conexão existem?
11. Qual é o volume médio e máximo de HTML por coleta?
12. Qual o tempo médio e o percentil 95 de execução por plataforma?
13. O processo atual usa concorrência interna entre URLs?
14. Como o frontend trata uma requisição demorada ou um erro
    `network error`?
15. O worker será executado no mesmo repositório, em um processo
    separado, ou em repositório próprio?

Não bloquear a primeira prova de conceito por perguntas que possam ser
respondidas depois. Priorizar as que alteram o contrato de execução,
concorrência e armazenamento do resultado.

------------------------------------------------------------------------

## 18. Estratégia de migração e rollback

A migração deve ser gradual:

1.  Manter o scraping atual disponível.
2.  Adicionar o worker e testar diretamente.
3.  Habilitar o novo fluxo apenas em ambiente de
    desenvolvimento/homologação.
4.  Comparar resultados do fluxo antigo e do novo em amostras
    controladas.
5.  Habilitar o novo fluxo para uma plataforma ou grupo restrito de
    usuários.
6.  Monitorar erros, latência e consumo.
7.  Aumentar gradualmente o tráfego.
8.  Só então tornar o worker o caminho padrão.
9.  Manter possibilidade de voltar temporariamente ao fluxo antigo até
    comprovar estabilidade.

O rollback deve ser controlado por configuração/feature flag, não exigir
uma reversão emergencial de várias mudanças no banco.

------------------------------------------------------------------------

## 19. Critérios gerais de sucesso

A implementação será considerada bem-sucedida quando:

-   A API principal não executar mais Chromium no fluxo padrão.
-   O scraping puder ser executado em workers independentes.
-   Uma VPS puder ser adicionada sem alterar a lógica da API.
-   Jobs não forem processados simultaneamente por workers diferentes.
-   Jobs abandonados forem recuperados.
-   A API conseguir entregar o resultado mesmo quando ele estiver
    armazenado em outro worker, ou refazer a coleta com segurança.
-   O cache e as regras de freshness continuarem corretos.
-   O frontend mantiver compatibilidade.
-   Falhas de scraping não derrubarem os demais módulos.
-   Houver métricas suficientes para identificar saturação e falhas.
-   A concorrência de Chromium estiver baseada em benchmark real.
-   O custo e a complexidade permanecerem proporcionais ao volume do
    produto.

------------------------------------------------------------------------

## 20. Orientação final para a IA implementadora

Não trate este documento como autorização para reescrever a aplicação.
Ele descreve o destino desejado e os problemas que precisam ser
resolvidos, mas a implementação deve partir do código real.

**Ordem de trabalho obrigatória:**

1.  Diagnosticar o repositório e a documentação.
2.  Apresentar a arquitetura atual e o que já existe.
3.  Apontar divergências e riscos desta proposta.
4.  Sugerir o menor conjunto de mudanças compatível com o projeto.
5.  Confirmar as decisões de cache, comunicação e execução.
6.  Implementar uma etapa por vez.
7.  Ao final de cada etapa, listar arquivos alterados, comportamento
    novo, testes, limitações e próximo passo.

A prioridade é **isolar o Chromium da API principal sem perder as
funcionalidades atuais**, usando a infraestrutura disponível e mantendo
a solução simples, observável, segura e expansível.
