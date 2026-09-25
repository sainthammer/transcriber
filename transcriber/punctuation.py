"""Punctuation and casing restoration via vosk-recasepunc (BERT)."""

import sys
import warnings
from pathlib import Path

import torch

DEFAULT_PUNCT_MODEL = str(Path(__file__).resolve().parent.parent / "models" / "vosk-recasepunc-ru-0.22")

# recasepunc puts a space before "?" and "!" (French style), so map labels ourselves.
PUNCT_SYMBOLS = {"O": "", "COMMA": ",", "PERIOD": ".", "QUESTION": "?", "EXCLAMATION": "!"}


class _Stub:
    """Inert placeholder for tokenizer objects pickled into the checkpoint."""

    def __init__(self, *args, **kwargs):
        pass

    def __setstate__(self, state):
        pass


class Punctuator:
    def __init__(self, model_dir: str = DEFAULT_PUNCT_MODEL):
        sys.path.insert(0, str(Path(model_dir).resolve()))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            import recasepunc as rp
        from huggingface_hub.utils import logging as hf_logging
        from transformers import logging

        logging.set_verbosity_error()
        logging.disable_progress_bar()
        hf_logging.set_verbosity_error()
        self._rp = rp

        # The checkpoint pickles transformers 4.x tokenizer objects alongside the weights.
        # Load weights-only and swap those objects for stubs: the tokenizer is rebuilt by
        # rp.init() anyway, and no code from the file gets executed.
        checkpoint = Path(model_dir) / "checkpoint"
        unsafe = torch.serialization.get_unsafe_globals_in_checkpoint(str(checkpoint))
        with torch.serialization.safe_globals([(_Stub, name) for name in unsafe]):
            loaded = torch.load(checkpoint, map_location="cpu", weights_only=True)

        config = {k: v for k, v in loaded["config"].items() if k != "tokenizer"}
        config["device"] = "cpu"

        self.predictor = rp.CasePuncPredictor.__new__(rp.CasePuncPredictor)
        self.predictor.config = rp.Config(**config)
        rp.init(self.predictor.config)
        self.predictor.model = rp.Model(self.predictor.config.flavor, "cpu")
        state = loaded["model_state_dict"]
        # Non-persistent buffer in transformers >= 4.31, stored in the old checkpoint.
        state.pop("bert.embeddings.position_ids", None)
        self.predictor.model.load_state_dict(state)
        self.predictor.model.eval()
        self.predictor.rev_case = {v: k for k, v in rp.case.items()}
        self.predictor.rev_punc = {v: k for k, v in rp.punctuation.items()}

    def punctuate(self, phrases: list[str]) -> list[str]:
        """Punctuate phrases as one continuous text, keeping phrase boundaries."""
        cfg = self.predictor.config
        tokens = [(-1, cfg.cls_token)]
        for i, phrase in enumerate(phrases):
            tokens += [(i, t) for t in cfg.tokenizer.tokenize(phrase)]
        tokens.append((-1, cfg.sep_token))

        out = [""] * len(phrases)
        with torch.inference_mode():
            predictions = self.predictor.predict(tokens, lambda t: t[1])
            for (i, token), case_label, punc_label in predictions:
                word = self._rp.recase(token.removeprefix("##"), self._rp.case[case_label])
                word += PUNCT_SYMBOLS[punc_label]
                # BERT splits hyphenated words ("из-за") into separate tokens around "-".
                if token.startswith("##") or token == "-" or out[i].endswith("-"):
                    out[i] += word
                else:
                    out[i] += (" " if out[i] else "") + word
        return out
