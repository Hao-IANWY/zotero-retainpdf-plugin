from __future__ import annotations

import re

TOKEN_RE = re.compile(r"(<[futnvc]\d+-[0-9a-z]{3}/>|\[\[FORMULA_\d+]]|\s+|[A-Za-z0-9_\-./]+|[\u4e00-\u9fff]|.)")
INLINE_MATH_SPAN_RE = re.compile(r"(?<!\\)\$(?:\\.|[^$\\\n])+(?<!\\)\$")
MATH_AWARE_TOKEN_RE = re.compile(
    rf"(<[futnvc]\d+-[0-9a-z]{{3}}/>|\[\[FORMULA_\d+]]|\s+|{INLINE_MATH_SPAN_RE.pattern}|[A-Za-z0-9_\-./]+|[\u4e00-\u9fff]|.)"
)
SPLIT_PUNCTUATION = "。！？；，、,.!?;:)]}）】」』"
# 句末判断：句号类标点后面允许跟收尾的引号 / 括号。
_SENTENCE_CLOSERS = "\"'”’)]}）】」』"
_CJK_SENTENCE_END = "。！？"
_ASCII_SENTENCE_END = ".!?"
# 成员源文以 "Background:" / "Methodology:" / "Results:" 这类小标题开头。
_SOURCE_LABEL_RE = re.compile(r"^\s*[A-Z][A-Za-z]*(?:[ -][A-Za-z]+){0,3}\s*[:：]\s")
# 译文侧对应的小标题：句首的短词 + 冒号（背景：/方法：/Results:）。
_TRANSLATION_LABEL_RE = re.compile(r"^[一-鿿A-Za-z][一-鿿A-Za-z ]{0,11}[：:]")


def math_spans(text: str) -> list[str]:
    return [match.group(0).strip() for match in INLINE_MATH_SPAN_RE.finditer(str(text or "")) if match.group(0).strip()]


def token_units(token: str) -> float:
    if not token:
        return 0.0
    if token.isspace():
        return 0.2
    if token.startswith("<") or token.startswith("[[FORMULA_"):
        return 3.0
    if re.fullmatch(r"[A-Za-z0-9_\-./]+", token):
        return max(1.0, len(token) * 0.55)
    return 1.0


def text_units(text: str) -> float:
    return sum(token_units(token) for token in TOKEN_RE.findall(str(text or "")))


def tokenize_group_translation(text: str) -> list[str]:
    return MATH_AWARE_TOKEN_RE.findall(str(text or "").strip())


def join_tokens(tokens: list[str]) -> str:
    return "".join(tokens).strip()


def _item_source(item: dict) -> str:
    return str(item.get("protected_source_text") or item.get("source_text") or "")


def source_ends_sentence(text: str) -> bool:
    stripped = str(text or "").rstrip().rstrip(_SENTENCE_CLOSERS).rstrip()
    return bool(stripped) and stripped[-1] in _CJK_SENTENCE_END + _ASCII_SENTENCE_END


def source_starts_with_label(text: str) -> bool:
    return _SOURCE_LABEL_RE.match(str(text or "")) is not None


def _sentence_ends_before(tokens: list[str], probe: int) -> bool:
    """``tokens[:probe]`` 是否恰好在一句话结束处收尾。"""
    index = probe - 1
    while index >= 0 and tokens[index] and all(char in _SENTENCE_CLOSERS for char in tokens[index]):
        index -= 1
    if index < 0:
        return False
    token = tokens[index]
    if token.endswith(tuple(_CJK_SENTENCE_END)):
        return True
    if not token.endswith(tuple(_ASCII_SENTENCE_END)):
        return False
    # 英文句号只在后面是空白或文本结尾时才算句末（排除 58.1、e.g 之类的词内点号）。
    return probe >= len(tokens) or tokens[probe].isspace()


def _label_starts_at(tokens: list[str], probe: int) -> bool:
    head = "".join(tokens[probe : probe + 16]).lstrip()
    return _TRANSLATION_LABEL_RE.match(head) is not None


def _sentence_boundary_probe(
    tokens: list[str],
    prefix_costs: list[float],
    *,
    cursor: int,
    max_probe: int,
    target_cost: float,
    next_starts_with_label: bool,
) -> int | None:
    """前一个成员源文以句末标点收尾时，只在译文的句末处切。

    下一个成员源文以小标题开头（Background:/Methodology:/Results:/Conclusion:）
    时，优先选译文里紧跟着小标题（背景：/方法：/结果：/结论：）的那个句末。
    候选里取累计长度最接近源文比例的一个；一个句末都没有就返回 None，交回比例切分。
    """
    candidates = [probe for probe in range(cursor + 1, max_probe + 1) if _sentence_ends_before(tokens, probe)]
    if not candidates:
        return None
    if next_starts_with_label:
        labeled = [probe for probe in candidates if _label_starts_at(tokens, probe)]
        if labeled:
            candidates = labeled
    return min(candidates, key=lambda probe: abs(prefix_costs[probe] - target_cost))


def split_group_protected_translation(protected_text: str, items: list[dict]) -> list[str]:
    if len(items) <= 1:
        return [str(protected_text or "").strip()]
    tokens = tokenize_group_translation(protected_text)
    if not tokens:
        return [""] * len(items)

    token_costs = [token_units(token) for token in tokens]
    total_cost = sum(token_costs)
    if total_cost <= 0:
        return [join_tokens(tokens)] + [""] * (len(items) - 1)

    source_weights = [max(1.0, text_units(_item_source(item))) for item in items]
    total_source_weight = max(1.0, sum(source_weights))
    prefix_costs = [0.0]
    for cost in token_costs:
        prefix_costs.append(prefix_costs[-1] + cost)

    chunks: list[str] = []
    cursor = 0
    cumulative_target_cost = 0.0
    source_seen = 0.0
    for index, weight in enumerate(source_weights[:-1]):
        source_seen += weight
        target_cost = total_cost * source_seen / total_source_weight
        max_probe = len(tokens) - (len(source_weights) - index - 1)
        if source_ends_sentence(_item_source(items[index])):
            sentence_probe = _sentence_boundary_probe(
                tokens,
                prefix_costs,
                cursor=cursor,
                max_probe=max_probe,
                target_cost=target_cost,
                next_starts_with_label=source_starts_with_label(_item_source(items[index + 1])),
            )
            if sentence_probe is not None:
                chunks.append(join_tokens(tokens[cursor:sentence_probe]))
                cumulative_target_cost = prefix_costs[sentence_probe]
                cursor = sentence_probe
                continue

        # 源文停在半句（续段）或译文里找不到句末：按源文长度比例在锚点附近找切点。
        cumulative = cumulative_target_cost
        anchor = cursor + 1
        while anchor < len(tokens) - (len(source_weights) - index - 1) and cumulative < target_cost:
            cumulative += token_costs[anchor - 1]
            anchor += 1

        left = max(cursor + 1, anchor - 36)
        right = min(len(tokens) - (len(source_weights) - index - 1), anchor + 36)
        best = anchor
        best_score = None
        for probe in range(left, right + 1):
            if probe <= cursor:
                continue
            probe_cost = cumulative_target_cost + sum(token_costs[cursor:probe])
            score = abs(probe_cost - target_cost)
            prev = tokens[probe - 1].rstrip() if probe - 1 < len(tokens) else ""
            if prev.endswith(SPLIT_PUNCTUATION):
                score -= 2.0
            if best_score is None or score < best_score:
                best = probe
                best_score = score

        chunks.append(join_tokens(tokens[cursor:best]))
        cumulative_target_cost += sum(token_costs[cursor:best])
        cursor = best

    chunks.append(join_tokens(tokens[cursor:]))
    while len(chunks) < len(items):
        chunks.append("")
    return chunks[: len(items)]


__all__ = [
    "INLINE_MATH_SPAN_RE",
    "math_spans",
    "split_group_protected_translation",
    "text_units",
    "token_units",
]
