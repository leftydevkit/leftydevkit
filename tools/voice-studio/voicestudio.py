#!/usr/bin/env python3
"""voice-studio — a local tuning bench for leftydevkit voice work.

Brand-wide rather than project-specific: any leftydevkit output that needs a
narrated voice tunes it here, and the presets live with the tool. amitheidiot is
the first consumer, not the owner.

Sits in front of audio.cpp (:8920) and adds the five things it cannot do:

  1. phrase chunking with real stitched silence. Kokoro *speaks* `[pause]` tags
     rather than honouring them (measured: `[pause 500ms]` alone renders 2.25s of
     speech at -25.9 dB, not 0.5s of silence at ~-91 dB), so the pause has to be
     built by concatenating separately-synthesised phrases around real silence.
  2. a post-synthesis tuning chain — pitch, tempo, EQ, compression, room echo.
     audio.cpp has no concept of any of these; they are ffmpeg work.
  3. presets, so a tuned voice is one click instead of a remembered incantation.
  4. per-phrase timings, so a render can sync a text card to each line.
  5. independence of speed and pause length. Applying `atempo` to a finished
     concatenation would stretch the silence too, making the two sliders fight;
     so tempo is applied per phrase, BEFORE the gaps are inserted, and a gap of
     0.40s stays 0.40s at any speed.

Design note: synthesis is the slow step (~3s) and processing is the fast one
(~50ms). Text is therefore synthesised once and staged as per-phrase WAVs; the
sliders only re-run the ffmpeg chain. That is what makes dragging a slider feel
immediate instead of waiting on the model every time.

Stdlib only, on purpose — same reason the book importer is: this runs on the box
that has the models, and pulling a web framework in for one page is not worth it.

    python3 voicestudio.py            # http://127.0.0.1:8930
    python3 voicestudio.py --port N
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUDIOCPP = "http://127.0.0.1:8920"
STAGE = Path(tempfile.gettempdir()) / "voice-studio"
PRESETS = HERE / "presets.json"

# Kokoro 82M voice ids, as registered by audio.cpp. Kept explicit rather than
# discovered because there is no list endpoint (/v1/audio/voices returns the
# *user-uploaded* voice library, which is empty, not the model's built-ins).
KOKORO_VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    "ef_dora", "em_alex", "em_santa", "ff_siwis",
    "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
    "jf_alpha", "jm_kumo", "pf_alex", "pm_santa",
]
POCKET_VOICES = [
    "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette",
    "eponine", "estelle", "eve", "fantine", "george", "giovanni", "jane",
    "javert", "jean", "juergen", "lola", "marius", "mary", "michael", "paul",
    "peter_yearsley", "rafael", "stuart_bell", "vera",
]

# English words eSpeak phonemises with a syllabic consonant, which Kokoro's
# vocab has no glyph for -> the server 500s and the whole line is lost. The
# trigger is the /t/ + n-cluster specifically; /d/ + n ("garden") is fine.
CRASH_WORDS = ["certain", "button", "cotton", "written"]

DEFAULT_PARAMS = {
    "voice": "am_santa",
    "model": "kokoro-tts",
    "pitch": 1.00,      # rubberband ratio; <1 is lower/bigger
    "tempo": 0.90,      # rubberband ratio; <1 is slower (per phrase, so gaps stay fixed)
    "low": 0.0,         # dB at 180 Hz  — chest
    "mid": 0.0,         # dB at 2.5 kHz — presence
    "high": 0.0,        # dB at 6 kHz   — air
    "comp": 0.0,        # 0..1 -> ratio 1:1 .. 5:1, fast attack
    "room": 0.0,        # 0..1 echo wet; a booth, not a hall
    "gap": 1.00,        # scales every punctuation-derived pause
    "gap_base": 0.40,   # seconds after a full stop, before scaling
    "loudness": -14.0,  # LUFS; -14 is YouTube's own target
}

# How much pause each punctuation mark earns, relative to gap_base. This is the
# one place the engine's indifference to punctuation gets turned into an
# advantage: punctuation becomes an explicit timing map instead of a hint.
PUNCT_WEIGHT = [
    (".", 1.0), ("!", 1.15), ("?", 1.15), ("…", 1.6), (";", 0.6),
    (",", 0.45), (":", 0.55), ("—", 0.5), ("-", 0.5),
]

SENTENCE = re.compile(r"[^.!?…]+[.!?…]*", re.UNICODE)


def split_phrases(text: str) -> list[str]:
    """Text -> phrases, one per sentence, newlines forcing a hard break.

    A blank line, or a newline, means "definitely break here" — that is the
    escape hatch when the automatic sentence split guesses wrong.
    """
    out: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        for line in para.split("\n"):
            line = line.strip()
            if not line:
                continue
            for m in SENTENCE.finditer(line):
                frag = m.group(0).strip()
                if frag:
                    out.append(frag)
    return out or ([text.strip()] if text.strip() else [])


def gap_after(phrase: str, base: float) -> float:
    """Seconds of silence after this phrase, from its own punctuation."""
    stripped = phrase.rstrip()
    if not stripped:
        return 0.0
    if stripped[-1] in ".!?…":
        # a lone full stop on an abbreviation is not a sentence end; the splitter
        # already decided it was, so trust it — it only ever errs on more pauses
        pass
    for mark, weight in PUNCT_WEIGHT:
        if stripped.endswith(mark):
            return base * weight
    return base * 0.35      # no terminal punctuation: a breath, not a stop


def encode_audio(args: list[str]) -> bytes:
    return subprocess.run(args, capture_output=True, check=True).stdout


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def silence(seconds: float, dest: Path, rate: int = 24000) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"anullsrc=r={rate}:cl=mono", "-t", f"{seconds:.4f}", str(dest)],
        check=True)


def synth(text: str, dest: Path, voice: str, model: str) -> None:
    """One phrase -> WAV, via audio.cpp. Raises with the server's message on 4xx/5xx."""
    body = json.dumps({"model": model, "input": text, "voice": voice,
                       "response_format": "wav"}).encode()
    req = urllib.request.Request(f"{AUDIOCPP}/v1/audio/speech", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            dest.write_bytes(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except Exception:
            pass
        raise RuntimeError(detail) from None


def tune_chain(p: dict) -> str:
    """The post-synthesis chain. Order matters: pitch/tempo, then tone, then
    dynamics, then room — shaping a signal before compressing it is what keeps
    the compressor reacting to the voice instead of to the EQ."""
    parts: list[str] = []
    if abs(p["pitch"] - 1.0) > 1e-3 or abs(p["tempo"] - 1.0) > 1e-3:
        parts.append(f"rubberband=pitch={p['pitch']:.4f}:tempo={p['tempo']:.4f}")
    if abs(p["low"]) > 0.05:
        parts.append(f"equalizer=f=180:t=q:w=1.0:g={p['low']:.2f}")
    if abs(p["mid"]) > 0.05:
        parts.append(f"equalizer=f=2500:t=q:w=1.2:g={p['mid']:.2f}")
    if abs(p["high"]) > 0.05:
        parts.append(f"highshelf=f=6000:t=q:w=1:g={p['high']:.2f}")
    if p["comp"] > 0.01:
        ratio = 1.0 + p["comp"] * 4.0
        makeup = p["comp"] * 4.0
        parts.append(f"acompressor=threshold=-20dB:ratio={ratio:.2f}"
                     f":attack=4:release=90:makeup={makeup:.2f}")
    if p["room"] > 0.01:
        parts.append(f"aecho=0.9:{p['room']:.3f}:14:0.06")
    return ",".join(parts) if parts else "anull"


class Bench:
    """Staged synthesis. Built once per text, re-processed on every slider move."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}

    def speak(self, text: str, voice: str, model: str) -> dict:
        phrases = split_phrases(text)
        if not phrases:
            raise RuntimeError("nothing to say")
        hit = [w for w in CRASH_WORDS
               if re.search(rf"\b{w}\b", text, re.IGNORECASE)]
        if hit:
            raise RuntimeError(
                f"{', '.join(hit)} will 500 the Kokoro server "
                "(syllabic-consonant phoneme it has no glyph for) — reword it")

        job_id = uuid.uuid4().hex[:12]
        d = STAGE / job_id
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

        meta = []
        for i, ph in enumerate(phrases):
            dest = d / f"{i:03d}.wav"
            synth(ph, dest, voice, model)
            meta.append({"i": i, "text": ph, "raw": dest.name,
                         "raw_dur": probe_duration(dest)})

        self.jobs[job_id] = {"dir": d, "phrases": meta,
                             "voice": voice, "model": model}
        return {"id": job_id, "phrases": meta}

    def render(self, job_id: str, params: dict) -> tuple[bytes, dict]:
        job = self.jobs.get(job_id)
        if job is None:
            raise RuntimeError("unknown job — synthesise the text again")
        d: Path = job["dir"]
        chain = tune_chain(params)
        base = float(params["gap_base"])
        scale = float(params["gap"])
        base *= scale

        timeline, pieces, cursor = [], [], 0.0
        for ph in job["phrases"]:
            src = d / ph["raw"]
            tuned = d / f"{ph['i']:03d}.tuned.wav"
            # No cache here, deliberately. Keying it on the phrase index alone made
            # every settings change return the first render's audio (both takes came
            # back byte-identical), and keying it on a hash of the chain buys ~40ms
            # per phrase. Re-running ffmpeg is the cheap, always-correct option —
            # staging the *raw* phrases is what avoids the expensive re-synthesis.
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                 "-af", chain, str(tuned)], check=True)
            # tempo was applied per phrase, so this duration is already final and
            # the gap below is exact at any speed
            dur = probe_duration(tuned)
            timeline.append({"i": ph["i"], "text": ph["text"],
                             "start": round(cursor, 3), "dur": round(dur, 3),
                             "end": round(cursor + dur, 3)})
            pieces.append(tuned)
            cursor += dur

            gap = gap_after(ph["text"], base)
            if gap > 0.005 and ph is not job["phrases"][-1]:
                sil = d / f"{ph['i']:03d}.gap.wav"
                silence(gap, sil)
                pieces.append(sil)
                timeline[-1]["gap"] = round(gap, 3)
                cursor += gap

        lst = d / "concat.txt"
        lst.write_text("".join(f"file '{p.name}'\n" for p in pieces))
        wav = encode_audio(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(lst), "-af", f"loudnorm=I={params['loudness']:.1f}:TP=-1.5:LRA=11",
             "-ar", "24000", "-ac", "1", "-f", "wav", "-"])
        return wav, {"timeline": timeline, "duration": round(cursor, 3)}


BENCH = Bench()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):        # keep the terminal readable
        if "api/" not in (self.path or ""):
            sys.stderr.write(f"  {fmt % a}\n")

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self._send(200, (HERE / "index.html").read_bytes(),
                       "text/html; charset=utf-8")
        elif self.path == "/api/voices":
            self._json({"kokoro": KOKORO_VOICES, "pocket": POCKET_VOICES,
                        "defaults": DEFAULT_PARAMS,
                        "crashWords": CRASH_WORDS})
        elif self.path == "/api/presets":
            self._json(json.loads(PRESETS.read_text()) if PRESETS.exists() else {})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        try:
            if self.path == "/api/speak":
                b = self._body()
                self._json(BENCH.speak(b.get("text", ""),
                                       b.get("voice", DEFAULT_PARAMS["voice"]),
                                       b.get("model", DEFAULT_PARAMS["model"])))
            elif self.path == "/api/process":
                b = self._body()
                params = {**DEFAULT_PARAMS, **b.get("params", {})}
                wav, info = BENCH.render(b["id"], params)
                self._json({"audio": base64.b64encode(wav).decode(), **info})
            elif self.path == "/api/presets":
                b = self._body()
                store = json.loads(PRESETS.read_text()) if PRESETS.exists() else {}
                if b.get("name"):
                    store[b["name"]] = b.get("params", {})
                    PRESETS.write_text(json.dumps(store, indent=2) + "\n")
                self._json(store)
            else:
                self._json({"error": "not found"}, 404)
        except RuntimeError as e:
            self._json({"error": str(e)}, 400)
        except subprocess.CalledProcessError as e:
            self._json({"error": f"ffmpeg: {e.stderr.decode(errors='replace')[-400:]}"}, 500)
        except Exception as e:
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8930)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()

    # rubberband is an ffmpeg *filter*, not a binary — probing for it with which()
    # would fail on a working setup. ffmpeg/ffprobe are the real dependencies.
    missing = [b for b in ("ffmpeg", "ffprobe") if not shutil.which(b)]
    if missing:
        print(f"{', '.join(missing)} not on PATH — the tuning chain needs them",
              file=sys.stderr, flush=True)
        return 1
    try:
        with urllib.request.urlopen(f"{AUDIOCPP}/health", timeout=4) as r:
            health = json.loads(r.read())
    except Exception as e:
        print(f"audio.cpp not answering at {AUDIOCPP} ({e}).\n"
              f"Start it first — this bench is only the wrapper.", file=sys.stderr)
        return 1

    STAGE.mkdir(parents=True, exist_ok=True)
    # flush: stdout is block-buffered when this is launched without a TTY, so
    # without this the banner sits in the buffer and a log-based readiness
    # check never sees the process come up.
    print(f"audio.cpp: {health.get('backend')} backend, {health.get('models')} models",
          flush=True)
    print(f"voice-studio: http://{a.host}:{a.port}", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
