# Code KOL Studio

Editor de vídeo pessoal que roda 100% no navegador (Chrome desktop). Sem login, sem backend, sem upload: todo o processamento é local.

Monta vídeos verticais (1080x1920, 30 fps) no formato **react + takes com imagem**:

1. **Abertura (react)**: clipe de outra pessoa (16:9, áudio original) com título em cima e seu rosto recortado reagindo embaixo.
2. **Takes**: cada frase gravada no celular, com o rosto recortado por cima da parte de baixo de uma imagem.
3. **Música de fundo** baixa no vídeo todo.

## Rodar

```bash
npm install      # também copia os wasm do MediaPipe e do FFmpeg para public/
npm run dev      # abre http://localhost:5173
```

Alvo: Chrome desktop atualizado. Precisa de WebCodecs com H.264 + AAC (Chrome normal tem; Chromium "puro" não).

## Como testar a Fase 1

1. Coloque arquivos reais em `samples/` (veja `samples/README.md`): `react/clipe.*`, `react/reacao.*`, `takes/`, `imagens/`, `musica/`.
2. Abra o app e **arraste a pasta `samples/` inteira** na área "Arraste uma pasta inteira aqui" (ou clique nela e escolha a pasta). Os arquivos são classificados pela subpasta e pelo nome. Se errar, troque no menu ao lado de cada vídeo.
3. Confira à esquerda: 1 clipe, 1 reação, os takes numerados na ordem natural (take2 antes de take10), as imagens e a música.
4. O preview monta tudo sozinho. Aperte **Play** (ou espaço). A react vem primeiro (clipe + título + rosto), depois os takes com imagem.
5. No topo: botão **⌂ Projeto** volta à tela principal (título, avisos, música) e os botões de **Velocidade** mudam todos os takes de uma vez. No painel da direita (Projeto): digite o **título**, troque a **velocidade** (1.1x / 1.2x / 1.25x), a intensidade do **corte de pausas** e o volume/início da **música**.
6. Corte como no CapCut: clique na faixa pra posicionar o cursor dentro de um take e aperte **Q** (apaga o que vem antes) ou **W** (apaga o que vem depois). O corte automático de pausas vem **desligado**; ligue em Projeto se quiser. Clique num take na linha do tempo: a faixa de baixo mostra verde (mantido) e vermelho (cortado). Arraste para selecionar um trecho e **Cortar**; clique num trecho vermelho para **restaurar**. À direita ajuste rosto (esquerda/centro/direita, tamanho), aparar início/fim, velocidade própria e imagens.
7. Arraste no preview para mover título, clipe, imagem ou rosto. Roda do mouse dá zoom.
8. Arraste imagens entre takes na linha do tempo (Alt = copiar). Com várias imagens no mesmo take, arraste a linha branca para mudar o ponto de troca.
9. Clique no clipe (bloco roxo) para marcar início e fim do trecho da react.
10. **Exportar MP4**: escolha onde salvar; o arquivo é gravado em streaming direto no disco, com barra de progresso e tempo estimado. Nome: `nome-do-projeto_data.mp4`.

### Vídeo que o Chrome não decodifica (ex.: HEVC de iPhone)

Aparece um aviso e o arquivo é convertido localmente com FFmpeg.wasm antes de entrar no projeto.

## Recorte de fundo

- Logo depois do upload, cada take (e a reação) tem a máscara calculada **uma vez, em segundo plano**, e guardada no disco do navegador (OPFS). O preview e a exportação só leem a máscara pronta, por isso não pesam. O progresso aparece na lista de arquivos ("recorte 45%").
- Modelo padrão do pré-cálculo: **Robust Video Matting** (ONNX Runtime Web, local). Tem memória temporal (sem tremido nem rastro) e borda de cabelo com transparência. Alternativa: `?maskmodel=mediapipe` na URL.
- Enquanto a máscara não fica pronta, o preview usa o MediaPipe ao vivo.
- Páginas de teste (só em dev): `/bench.html` compara MediaPipe e RVM lado a lado no mesmo vídeo; `/masktest.html` testa o cache.

## Stack

Vite + React + TypeScript · Mediabunny (ler/gravar MP4, WebCodecs) · MediaPipe Image Segmenter (recorte, GPU) · SoundTouch (velocidade com tom preservado) · FFmpeg.wasm (fallback de decodificação).

Modelos e wasm são servidos de `public/` (sem CDN).

## Estrutura

```
src/lib        regras: classificação, imagens, corte de pausas, loudness, linha do tempo, layout
src/render     compositor do quadro (preview e exportação usam o mesmo) e recorte MediaPipe
src/preview    motor do preview ao vivo (vídeos + Web Audio)
src/export     worker de exportação (Mediabunny + WebCodecs), mix de áudio offline
src/media      probe de arquivos e fallback FFmpeg
src/state      store (zustand)
src/ui         interface (arquivos | preview | propriedades, linha do tempo)
```
