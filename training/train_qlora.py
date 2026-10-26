#!/usr/bin/env python3
"""Fine-tuning LoRA do adjudicador (F6).

Dataset: JSONL com `messages` (system/user/assistant) gerado por
`npm run dataset:build`. Windows (CPU) e Ubuntu/WSL2 (CPU/GPU).

Engines:
  hf  (default) — Trainer + LoRA puro: funciona no Windows/CPU.
  sft           — TRL SFTTrainer (loss fundida): recomendado em Linux/GPU.

Exemplos:
  python training/train_qlora.py --dry-run
  python training/train_qlora.py --dataset data/dataset --output training/out
  python training/train_qlora.py --engine sft --device cuda --epochs 2 --merge
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROLES = {"system", "user", "assistant"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LoRA fine-tuning do adjudicador de ofertas")
    parser.add_argument("--dataset", default="data/dataset", help="diretório com train/valid.jsonl")
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--output", default="training/out")
    parser.add_argument("--engine", choices=["hf", "sft"], default="hf")
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--max-steps", type=int, default=-1, help="-1 = usa epochs")
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--merge", action="store_true", help="salva o modelo final já mesclado (HF)")
    parser.add_argument("--dry-run", action="store_true", help="valida o dataset sem treinar")
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    items: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for number, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"{path}:{number}: JSON inválido ({error.msg})") from error
            messages = value.get("messages")
            if not isinstance(messages, list) or not messages:
                raise SystemExit(f"{path}:{number}: campo 'messages' ausente")
            for message in messages:
                if message.get("role") not in ROLES or not isinstance(message.get("content"), str):
                    raise SystemExit(f"{path}:{number}: mensagem inválida: {message!r}")
            items.append(value)
    return items


def resolve_device(requested: str) -> tuple[bool, bool]:
    """Retorna (usar_cuda, usar_bf16). Importa torch só quando vai treinar."""
    import torch

    if requested == "cuda" and not torch.cuda.is_available():
        raise SystemExit("CUDA pedido, mas indisponível (Windows/CPU?). Use --device cpu.")
    use_cuda = requested == "cuda" or (requested == "auto" and torch.cuda.is_available())
    bf16 = bool(use_cuda and torch.cuda.is_bf16_supported())
    return use_cuda, bf16


def load_model_and_tokenizer(model_id: str, use_cuda: bool, bf16: bool):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dtype = torch.bfloat16 if bf16 else (torch.float16 if use_cuda else torch.float32)
    tokenizer = AutoTokenizer.from_pretrained(model_id, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    try:
        # transformers >= 4.56 renomeou `torch_dtype` para `dtype`.
        model = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype)
    except TypeError:
        model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=dtype)
    if use_cuda:
        model.to("cuda")
    model.config.use_cache = False
    return model, tokenizer


def tokenize_example(tokenizer, messages: list[dict], max_length: int) -> dict:
    """Mascara o prompt (-100) e treina só na resposta do assistente."""
    prompt = tokenizer.apply_chat_template(
        messages[:-1], tokenize=False, add_generation_prompt=True
    )
    answer = messages[-1]["content"]
    prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    answer_ids = tokenizer(answer, add_special_tokens=False)["input_ids"]
    eos = tokenizer.eos_token_id
    if isinstance(eos, int):
        answer_ids = [*answer_ids, eos]

    if len(answer_ids) >= max_length:
        answer_ids = answer_ids[:max_length]
    keep_prompt = max(0, max_length - len(answer_ids))
    if len(prompt_ids) > keep_prompt:
        prompt_ids = prompt_ids[-keep_prompt:] if keep_prompt > 0 else []

    input_ids = [*prompt_ids, *answer_ids]
    labels = [-100] * len(prompt_ids) + list(answer_ids)
    return {
        "input_ids": input_ids,
        "attention_mask": [1] * len(input_ids),
        "labels": labels,
    }


class PadCollator:
    def __init__(self, pad_token_id: int):
        self.pad_token_id = pad_token_id

    def __call__(self, features: list[dict]):
        import torch

        length = max(len(feature["input_ids"]) for feature in features)
        input_ids, attention, labels = [], [], []
        for feature in features:
            pad = length - len(feature["input_ids"])
            input_ids.append(feature["input_ids"] + [self.pad_token_id] * pad)
            attention.append(feature["attention_mask"] + [0] * pad)
            labels.append(feature["labels"] + [-100] * pad)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }


def train_hf(args, model, tokenizer, train_rows, valid_rows, use_cuda, bf16, output: Path):
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import Trainer, TrainingArguments

    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    def prepare(rows: list[dict]) -> Dataset:
        dataset = Dataset.from_list([{"messages": row["messages"]} for row in rows])
        return dataset.map(
            lambda row: tokenize_example(tokenizer, row["messages"], args.max_length),
            remove_columns=dataset.column_names,
            num_proc=1,
        )

    trainer = Trainer(
        model=model,
        args=TrainingArguments(
            output_dir=str(output),
            num_train_epochs=args.epochs,
            max_steps=args.max_steps,
            per_device_train_batch_size=args.batch,
            per_device_eval_batch_size=args.batch,
            gradient_accumulation_steps=args.grad_accum,
            learning_rate=args.lr,
            lr_scheduler_type="cosine",
            warmup_ratio=0.03,
            max_grad_norm=0.3,
            logging_steps=5,
            save_strategy="epoch",
            save_total_limit=2,
            eval_strategy="epoch" if valid_rows else "no",
            use_cpu=not use_cuda,
            fp16=False,
            bf16=bf16,
            gradient_checkpointing=use_cuda,
            dataloader_num_workers=args.workers,
            report_to=[],
            seed=42,
        ),
        train_dataset=prepare(train_rows),
        eval_dataset=prepare(valid_rows) if valid_rows else None,
        data_collator=PadCollator(tokenizer.pad_token_id),
    )
    trainer.train()
    trainer.save_model(str(output))
    tokenizer.save_pretrained(str(output))
    return trainer


def train_sft(args, model, tokenizer, train_rows, valid_rows, use_cuda, bf16, output: Path):
    from datasets import Dataset
    from peft import LoraConfig
    from trl import SFTConfig, SFTTrainer

    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    config = SFTConfig(
        output_dir=str(output),
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.batch,
        per_device_eval_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        max_grad_norm=0.3,
        max_length=args.max_length,
        logging_steps=5,
        save_strategy="epoch",
        save_total_limit=2,
        eval_strategy="epoch" if valid_rows else "no",
        use_cpu=not use_cuda,
        fp16=False,
        bf16=bf16,
        gradient_checkpointing=use_cuda,
        dataloader_num_workers=args.workers,
        dataset_num_proc=1,
        report_to=[],
        seed=42,
    )
    trainer = SFTTrainer(
        model=model,
        args=config,
        train_dataset=Dataset.from_list(train_rows),
        eval_dataset=Dataset.from_list(valid_rows) if valid_rows else None,
        peft_config=lora,
        processing_class=tokenizer,
    )
    trainer.train()
    trainer.save_model(str(output))
    tokenizer.save_pretrained(str(output))
    return trainer


def main() -> int:
    args = parse_args()
    dataset_dir = Path(args.dataset)
    train_path = dataset_dir / "train.jsonl"
    valid_path = dataset_dir / "valid.jsonl"
    if not train_path.exists():
        print(f"Dataset não encontrado: {train_path}", file=sys.stderr)
        print("Rode `npm run dataset:build` primeiro.", file=sys.stderr)
        return 1

    train_rows = read_jsonl(train_path)
    valid_rows = read_jsonl(valid_path) if valid_path.exists() else []
    print(f"train={len(train_rows)} valid={len(valid_rows)} engine={args.engine} max_length={args.max_length}")
    if not train_rows:
        print("Train vazio — colete mais replays shadow antes de treinar.", file=sys.stderr)
        return 1
    if args.dry_run:
        print(json.dumps(train_rows[0]["messages"][-1], ensure_ascii=False)[:400])
        return 0

    use_cuda, bf16 = resolve_device(args.device)
    print(f"device={'cuda' if use_cuda else 'cpu'} bf16={bf16}")
    model, tokenizer = load_model_and_tokenizer(args.model, use_cuda, bf16)

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    trainer = (
        train_hf(args, model, tokenizer, train_rows, valid_rows, use_cuda, bf16, output)
        if args.engine == "hf"
        else train_sft(args, model, tokenizer, train_rows, valid_rows, use_cuda, bf16, output)
    )
    print(f"adapter salvo em {output}")

    if args.merge:
        merged_dir = output / "merged"
        merged = trainer.model.merge_and_unload()
        merged.save_pretrained(str(merged_dir), safe_serialization=True)
        tokenizer.save_pretrained(str(merged_dir))
        print(f"modelo mesclado salvo em {merged_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
