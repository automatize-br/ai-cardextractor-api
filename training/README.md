# Treino do adjudicador (F6)

Pipeline: **replays `shadow` → dataset → LoRA → GGUF**. O serviço roda em
Windows para teste e em **Ubuntu** em produção; o treino pode rodar no Windows
(CPU, smoke) ou no **WSL2 Ubuntu** (recomendado, paridade com o servidor).

## 1. Coletar replays (opt-in)

No `.env` do serviço:

```env
AI_ADJ_MODE=shadow
AI_REPLAY_PATH=data/replays.jsonl
AI_REPLAY_MAX_BYTES=50000000
```

Reinicie e deixe coletar. Cada linha contém o pack completo + decisões finais +
escolha `shadow` do modelo. **Contém dados de produto** (título/imagem/preço):
não versione `data/` e defina retenção.

## 2. Gerar o dataset

Windows (PowerShell) ou WSL2, na raiz do repo:

```powershell
npm run dataset:build
# opcional: correções humanas (JSONL: {packHash, cardId, titleId|reject})
npm run dataset:build -- --in data/replays.jsonl --labels data/labels.jsonl
```

Saída em `data/dataset/`: `train.jsonl`, `valid.jsonl`, `test.jsonl`
(`messages` p/ SFT), `test.eval.jsonl` (formato do harness) e `stats.json`.

Split: por **marketplace** quando há 3+ domínios; senão hash determinístico do
pack. Sempre verifique `stats.json` antes de treinar.

Avaliação (usa o `LLM_PROVIDER` do `.env`; `--mode on` chama o modelo):

```powershell
npm run eval:adjudication -- --file data/dataset/test.eval.jsonl
```

## 3. Ambiente

Windows (CPU):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r training\requirements.txt
```

WSL2 Ubuntu (GPU/CPU) — o repo em `/mnt/d/...` funciona, mas copie o dataset
para o home (I/O do `/mnt` é lento):

```bash
cd "/mnt/d/MEUS_PROJETOS/AUTOMATIZE/IA OFERT EXTRACT/ai-extractor-api"
python3 -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu124   # GPU; sem CUDA use o torch do PyPI
pip install -r training/requirements.txt
cp -r data/dataset ~/dataset
```

## 4. Treinar

```powershell
python training/train_qlora.py --dry-run
python training/train_qlora.py --dataset data/dataset --output training/out
```

`--engine hf` (default) usa `Trainer` + LoRA puro e funciona no **Windows/CPU**.
`--engine sft` usa o TRL (loss fundida, precisa de Triton) e é indicado para
Linux/GPU:

```bash
python training/train_qlora.py --dataset ~/dataset --output training/out --engine sft --device cuda --epochs 2 --merge
```

O adapter vai para `training/out/`; com `--merge`, o HF mesclado fica em
`training/out/merged/`. Windows/CPU funciona com `--device cpu` (lento).

## 5. Virar GGUF (Ubuntu/WSL2)

O runtime v2 não carrega GGUF dentro do Node. Converta o modelo mesclado com o
llama.cpp, quantize e sirva via `llama.cpp server`/vLLM/Ollama (OpenAI-compatible):

```bash
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
python3 ~/llama.cpp/convert_hf_to_gguf.py training/out/merged --outfile ~/qwen-ft.f16.gguf --outtype f16
~/llama.cpp/build/bin/llama-quantize ~/qwen-ft.f16.gguf ~/qwen-ft.q4_k_m.gguf Q4_K_M
```

Sirva o GGUF com `llama-server -m ~/qwen-ft.q4_k_m.gguf --port 8080`, declare
um modelo `openai-compatible` em `AI_MODELS_JSON` e reinicie com
`AI_MODE=shadow` para comparar com a linha de base antes de `assist`.

## 6. Regras

- A IA nunca gera valores: o dataset só contém **letras** de candidatos do pack.
- Rótulo humano > escolha shadow > decisão do modelo.
- Split por domínio evita vazamento; não embaralhe manualmente.
- Métricas: acurácia por campo no `eval`, packs inválidos e latência p95.
- `data/` e `training/out/` não entram no git.
