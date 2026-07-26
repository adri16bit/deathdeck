#!/usr/bin/env python3
"""
DECK-01 intel module — gera hashes, fingerprints e "sinais" procedurais.
Usado pelo backend Node via stdin/stdout JSON.
"""
from __future__ import annotations

import hashlib
import json
import random
import string
import sys
import time
from datetime import datetime, timezone


NODES = [
    "NEON-GATE",
    "ASH-PROTOCOL",
    "VOID-RELAY",
    "CHROME-SPINE",
    "BLACK-ICE",
    "GHOST-PORT",
    "SYNTH-DOCK",
    "RUST-ORBIT",
]

SIGILS = ["⌬", "◈", "▣", "⬡", "⟐", "⟡", "⧉", "⬡"]


def sha(text: str, algo: str = "sha256") -> str:
    h = getattr(hashlib, algo, hashlib.sha256)()
    h.update(text.encode("utf-8", errors="ignore"))
    return h.hexdigest()


def fingerprint(seed: str) -> dict:
    rnd = random.Random(sha(seed)[:16])
    return {
        "id": f"FP-{rnd.randint(1000, 9999)}-{rnd.choice(string.ascii_uppercase)}{rnd.randint(10, 99)}",
        "entropy": round(rnd.random() * 100, 2),
        "sigil": rnd.choice(SIGILS),
        "tier": rnd.choice(["LOW", "MID", "HIGH", "BLACK"]),
        "lat": round(-23.5 + rnd.random() * 0.4, 5),
        "lon": round(-46.6 + rnd.random() * 0.4, 5),
    }


def scan_net(seed: str, count: int = 6) -> list[dict]:
    rnd = random.Random(sha(f"net:{seed}")[:16])
    nodes = []
    for i in range(count):
        name = rnd.choice(NODES)
        nodes.append(
            {
                "host": f"{name.lower()}.{rnd.randint(10, 99)}.deck",
                "ip": f"10.{rnd.randint(0, 255)}.{rnd.randint(0, 255)}.{rnd.randint(1, 254)}",
                "port": rnd.choice([22, 443, 1337, 8080, 31337, 666]),
                "latency_ms": rnd.randint(12, 420),
                "status": rnd.choice(["OPEN", "FILTERED", "ICE", "GHOST"]),
                "sigil": rnd.choice(SIGILS),
            }
        )
    return nodes


def decrypt_payload(cipher: str, key: str) -> dict:
    """XOR + hex decode style toy decrypt for the deck UI."""
    raw = cipher.strip()
    try:
        data = bytes.fromhex(raw) if all(c in string.hexdigits for c in raw.replace(" ", "")) else raw.encode()
    except ValueError:
        data = raw.encode()

    k = (key or "DECK").encode()
    out = bytes(b ^ k[i % len(k)] for i, b in enumerate(data))
    try:
        plain = out.decode("utf-8")
    except UnicodeDecodeError:
        plain = out.decode("latin-1", errors="replace")

    return {
        "plain": plain,
        "sha256": sha(plain),
        "bytes": len(out),
        "key_len": len(k),
        "algo": "XOR-DECK/1",
    }


def encrypt_payload(plain: str, key: str) -> dict:
    k = (key or "DECK").encode()
    data = (plain or "").encode("utf-8")
    out = bytes(b ^ k[i % len(k)] for i, b in enumerate(data))
    return {
        "cipher_hex": out.hex(),
        "sha256": sha(plain or ""),
        "algo": "XOR-DECK/1",
    }


def boot_banner() -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "deck": "PANCHIKO / D>E>A>T>H>D>E>C>K",
        "firmware": "0.0.1-burned-cdr",
        "uptime_seed": int(time.time()),
        "utc": now,
        "operator": "adri16bit",
        "modules": ["LINK", "WAVE", "COMMS", "CART", "SCOPE", "INK"],
    }


def main() -> None:
    # Windows consoles often use a legacy code page; force UTF-8 for JSON I/O.
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "error": "JSON inválido"}))
        return

    op = str(payload.get("op") or "boot").lower()
    seed = str(payload.get("seed") or payload.get("query") or "deck")
    key = str(payload.get("key") or "DECK")

    try:
        if op == "boot":
            data = boot_banner()
        elif op == "fingerprint":
            data = fingerprint(seed)
        elif op == "scan":
            data = {"nodes": scan_net(seed, int(payload.get("count") or 6))}
        elif op == "decrypt":
            data = decrypt_payload(str(payload.get("cipher") or ""), key)
        elif op == "encrypt":
            data = encrypt_payload(str(payload.get("plain") or ""), key)
        elif op == "hash":
            text = str(payload.get("text") or seed)
            data = {
                "md5": sha(text, "md5"),
                "sha1": sha(text, "sha1"),
                "sha256": sha(text, "sha256"),
            }
        else:
            print(json.dumps({"ok": False, "error": f"op desconhecida: {op}"}))
            return

        print(json.dumps({"ok": True, "op": op, "data": data}, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
