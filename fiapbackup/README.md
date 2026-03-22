# FIAP Backup

Este diretorio guarda um snapshot versionavel do projeto antes da fase de correcao arquitetural.

Objetivo:
- preservar o estado atual do produto publicado e do codigo fonte em um commit dedicado;
- manter uma base de restauracao segura antes de mexer na arquitetura;
- evitar regressos enquanto o produto ja esta em producao.

Conteudo principal:
- `project/`: snapshot recuperavel do codigo e dos artefatos publicados;
- `backup-manifest.json`: manifesto do snapshot, com origem, exclusoes e observacoes.

Observacoes importantes:
- este backup foi preparado para caber em Git e subir ao GitHub sem explodir limite de tamanho;
- por isso, caches, sessoes locais, runtime bruto e segredos locais nao foram versionados aqui;
- o estado desses itens excluidos foi registrado no manifesto como referencia operacional;
- o codigo, frontend publicado, backend, launcher e artefatos relevantes do produto foram copiados para `project/`.
