# Painel Mercado Agrícola — Maringá/PR

Painel para TV (1920×1080) com cotações, tempo e notícias do agro, trocando de slide sozinho.

```
index.html            o painel (HTML, CSS e JS num arquivo só)
sw.js                 guarda a página para abrir mesmo sem internet
coletor/coletar.mjs   busca as fontes e gera o data.json
.github/workflows/    roda o coletor no GitHub e publica o site
```

## Slides (ordem e tempo)

| # | Slide | Tempo |
|---|---|---|
| 1 | Previsão 7 dias + chuva (30 dias atrás e 14 à frente) | 20 s |
| 2 | Nuvens sobre o Paraná (satélite animado) + cidades | 10 s |
| 3 | Tempo hoje: agora, alertas, próximas 24 h, janela de pulverização | 30 s |
| 4 | Soja: Paranaguá, Paraná, Maringá, Chicago, B3 | 20 s |
| 5 | Dólar + soja e milho de Chicago convertidos em reais | 10 s |
| 6 | Insumos: diesel S10, ureia, DAP, KCl | 20 s |
| 7 | Notícias do agro | 30 s |

A ordem é a das `<section class="slide">` no `index.html`: para mudar, basta mover o bloco inteiro.
O tempo de cada slide fica no atributo `data-seg="…"` da `<section>` correspondente. O padrão é `segundosPorSlide` no topo do script.
O topo (relógio, clima e alerta) e o rodapé (soja, milho e dólar) ficam visíveis em todos os slides.

## Publicar de graça (GitHub Pages)

1. Crie uma conta em <https://github.com> (se ainda não tiver).
2. Crie um repositório **público** chamado `painel-agro` (botão **New**). Não marque nenhuma opção de README.
3. Envie esta pasta para lá. No terminal, dentro da pasta `painel-agro`:
   ```bash
   git remote add origin https://github.com/SEU-USUARIO/painel-agro.git
   git push -u origin main
   ```
4. No repositório: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. Aba **Actions** → **Atualizar cotações** → **Run workflow**. Em 1 ou 2 minutos o site fica no ar.
6. Endereço fixo: `https://SEU-USUARIO.github.io/painel-agro/`. No Fully Kiosk use `https://SEU-USUARIO.github.io/painel-agro/?nome=SeuNome`. O nome da saudação vem do endereço e não fica no código público.

O coletor roda sozinho a cada 15 min (seg–sex, 06h–21h) e a cada 3 h no resto do tempo.
Uma vez por mês ele faz um commit vazio, porque o GitHub desliga agendamentos de repositórios parados há 60 dias.
Quando o `index.html` muda, a TV recarrega sozinha em até 1 h.

## Testar no PC antes

```bash
cd coletor && npm install && node coletar.mjs --out ../data.json && cd ..
python -m http.server 8080
```

Abra <http://localhost:8080> no Chrome, aperte F11 (tela cheia, 1920×1080).
Para fixar um slide: `http://localhost:8080/?slide=3` (de 1 a 7).

## Fontes e frequência

| Dado | Fonte | Frequência | Selo na tela |
|---|---|---|---|
| Soja Paranaguá / Paraná, milho Campinas, trigo PR | CEPEA/ESALQ (cepea.org.br) | 1 por dia útil | diário |
| Soja, milho e trigo em Maringá | SEAB/DERAL, SIMA (agricultura.pr.gov.br), núcleo regional de Maringá, inclui Paiçandu | 1 por dia útil | diário |
| Soja, milho e trigo Chicago | CBOT via Yahoo Finance | ~15 min de atraso | ao vivo |
| Soja B3 | B3 via Notícias Agrícolas | fechamento diário | diário |
| Dólar comercial | AwesomeAPI (direto da TV, a cada 5 min) | quase em tempo real | ao vivo |
| Diesel S10 PR e Maringá | ANP, levantamento semanal | semanal | semanal |
| Ureia, DAP, KCl | Banco Mundial, Pink Sheet (preço internacional) | mensal | mensal |
| Tempo, previsão, chuva, cidades | Open-Meteo (direto da TV) | 20–60 min | — |
| Alertas oficiais | INMET (apiprevmet3.inmet.gov.br) | a cada coleta | INMET |
| Nuvens | NASA GIBS, satélite GOES-East (GeoColor) | ~1h15 de atraso (às vezes mais; o selo avisa acima de 3 h) | satélite |
| Notícias | RSS do g1 Agro e do Canal Rural | a cada coleta | — |

Observações honestas:
- **MAP**: o Banco Mundial publica o **DAP**, que é a referência internacional mais próxima. Não há fonte gratuita de MAP posto no Brasil.
- **Paiçandu** não tem cotação própria: entra no núcleo regional de Maringá da SEAB.
- **Chuva passada** é estimativa de modelo/satélite, não de pluviômetro.
- **Janela de pulverização** é indicativa (vento 3–10 km/h, umidade acima de 55%, abaixo de 30 °C e sem chuva). Confira sempre na lavoura.

## Se uma fonte sair do ar

O painel nunca cai inteiro. O cartão afetado mantém o último valor e mostra, em laranja, **"desatualizado desde HH:MM"**.
Para corrigir: veja a aba **Actions** no GitHub. O log do coletor mostra uma linha `✗ fonte: motivo` para cada falha.
Cada fonte é uma função separada em `coletor/coletar.mjs` (`cepea`, `cbot`, `b3Soja`, `sima`, `anp`, `bancoMundial`, `alertasInmet`, `satelite`, `noticias`). Se um site mudar de formato, só aquela função precisa de ajuste.

## Fully Kiosk Browser (no box)

- **Start URL**: a URL do GitHub Pages.
- **Web Content Settings → Enable JavaScript / Local Storage**: ligados.
- **Advanced Web Settings → Reload on Network Reconnect**: ligado.
- **Device Management → Keep Screen On**: ligado. **Screensaver**: desligado.
- Na TV LG, desative **Desligamento automático** (Geral → Eco), senão ela desliga após 4 h sem uso do controle.
