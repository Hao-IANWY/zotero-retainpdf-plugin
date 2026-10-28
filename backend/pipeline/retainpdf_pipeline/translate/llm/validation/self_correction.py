"""模型把「边想边改」写进了译文：先交一版草稿，再来一句「Wait — … Correct it.」，最后才是改好的译文，三段
一起回来。真实例子（qwen3.8-flash，一本教材）：

    图12.16 烯丙烷（allene）的两种视图。…
    Wait—"allene" should not be translated as 烯丙烷; allene is 丙二烯. Correct it.
    图12.16 丙二烯（allene）的两种视图。…

english_residue 只抓「照抄原文的英文」，这种是模型自己新写的话，原文里没有，所以漏过去了。

只认原文里没有的纠正话术，并且要么在段首（Wait— / 等等，），要么本身就是在说「改正 / 译成 / 输出」。
"""

from __future__ import annotations

import re

# 段首的「打住」：Wait — / Hmm, / Actually, / Oops — / Correction: / 等等， / 更正： / 纠正：
_PARAGRAPH_START_RE = re.compile(
    r"(?:^|\n)\s*(?:"
    r"(?:wait|hmm+|actually|oops|correction|scratch that)\s*[—–\-,:：!！.]"
    r"|(?:等等|稍等|更正|纠正|抱歉)\s*[，,:：—!！]"
    r")",
    re.I,
)

# 不在段首也算：明说在改自己的回答、译法或输出
_CORRECTION_PHRASE_RE = re.compile(
    r"\b(?:"
    r"i\s+(?:need|have|should|must)\s+to\s+(?:correct|fix|revise|redo|re-?translate)"
    r"|let\s+me\s+(?:correct|fix|revise|redo|re-?translate)"
    r"|correct(?:ing)?\s+(?:it|this|that|my\s+(?:reply|answer|response|translation|output))\b"
    r"|(?:should|must)\s*(?:not|n't)\s+be\s+translated\s+as"
    r"|the\s+correct\s+(?:output|translation|answer|reply)\s+is"
    r"|my\s+(?:previous|earlier|last)\s+(?:reply|answer|response|translation|output)"
    r"|(?:not|instead\s+of)\s+the\s+source\s+(?:text\s+)?repeated"
    # 拿不准时的自问自答（没开思考的小模型会把犹豫写进回答）。真实例子（claude-haiku-5-5，
    # 20261013090853-726861 p070-b014，原文只是小标题 "Nak Schedule 2"）：
    #   Translation: "Nak Schedule 2" as a heading. … Keep "NAK" as-is? The source says "Nak Schedule 2" — …
    #   Better to keep "Nak Schedule 2" since it's an identifier-like heading; … I'll use "Nak Schedule 2" …
    r"|i(?:'ll|’ll|\s+will)\s+(?:use|keep|go\s+with|translate|render|output|leave)\b"
    r"|keep\s+(?:[\"“'‘][^\"”'’\n]{1,60}[\"”'’]|it|this|that|them)\s+as[- ]is\b"
    r"|(?:better|best|safer)\s+to\s+(?:keep|leave|translate|use|preserve)\b"
    r"|the\s+source\s+(?:text\s+)?says\b"
    r"|translate\s+(?:it\s+|this\s+)?as\s+an?\s+(?:heading|title|label)\b"
    r")",
    re.I,
)

# 中文的纠正话术：只在和「译 / 翻译 / 改正」连在一起时才算，避免「苹果、香蕉等等」这类正常用法
_ZH_CORRECTION_RE = re.compile(r"(?:不应|不该|不能)(?:被)?(?:译|翻译)(?:为|成)|(?:上面|上述|刚才)的?(?:译文|翻译|回答)(?:有误|错了|不对)")
_ZH_TRANSLATION_WORD_RE = re.compile(r"译|翻译|改正|纠正|更正|修正")
_CJK_RE = re.compile(r"[一-鿿]")


def _present_in_source(match_text: str, source_text: str) -> bool:
    needle = re.sub(r"\s+", " ", match_text.strip().strip("—–-,:：!！.，")).lower()
    return bool(needle) and needle in re.sub(r"\s+", " ", source_text).lower()


def _leak_position(source: str, translated: str, *, require_cjk: bool = True) -> int | None:
    """自我纠正话术在译文里的位置（第一处，落在那句话的第一个字上），没有时 None。

    require_cjk：判断「这是不是一段混进了自言自语的译文」时要求有汉字（纯英文归 english_residue 管）；
    切出改好的那一版时，剩下的可能是纯英文的自言自语，不能因为没汉字就放过。
    """
    if not translated.strip() or (require_cjk and not _CJK_RE.search(translated)):
        return None
    positions = []
    for match in _CORRECTION_PHRASE_RE.finditer(translated):
        if not _present_in_source(match.group(0), source):
            positions.append(match.start())
            break
    for match in _ZH_CORRECTION_RE.finditer(translated):
        positions.append(match.start())
        break
    for match in _PARAGRAPH_START_RE.finditer(translated):
        # 跳过前面的换行和空白（`\n\nWait` 要落在 W 上，不然「切掉这一行」切掉的是空行）
        start = match.start() + len(match.group(0)) - len(match.group(0).lstrip())
        paragraph = translated[start:].split("\n", 1)[0]
        marker = match.group(0).strip()
        if _present_in_source(marker, source):
            continue
        # 段首的 Wait / 等等 还要看这一段在不在说「改 / 译」，单独一个「等等，」可能是正常译文
        if re.match(r"\s*(?:等等|稍等|抱歉)", paragraph) and not _ZH_TRANSLATION_WORD_RE.search(paragraph):
            continue
        positions.append(start)
        break
    return min(positions) if positions else None


def self_correction_leak(source_text: str, translated_text: str) -> str:
    """译文里混进了模型的自我纠正就返回那句话（截断），否则返回空字符串。"""
    translated = str(translated_text or "")
    position = _leak_position(str(source_text or ""), translated)
    return "" if position is None else _snippet(translated, position)


def text_after_self_correction(source_text: str, translated_text: str) -> str:
    """模型纠正之后给的那一版：最后一处自言自语所在行之后的内容；纠正之后什么都没写时返回空字符串。

    真实例子：先把原文抄一遍，再「Wait — the instruction says output only the translation. Let me correct
    that.」，最后才是译文。取出来的仍要走完整校验，过了才用——这里只负责切，不负责信。
    """
    source = str(source_text or "")
    remainder = str(translated_text or "")
    for _ in range(5):  # 偶尔纠正不止一次
        position = _leak_position(source, remainder, require_cjk=False)
        if position is None:
            return remainder.strip()
        line_end = remainder.find("\n", position)
        if line_end < 0:
            return ""
        remainder = remainder[line_end + 1 :]
    return ""


def _snippet(text: str, start: int, limit: int = 120) -> str:
    """命中位置所在的那一行（从行首起），给诊断看。"""
    line_start = text.rfind("\n", 0, start) + 1
    return text[line_start:].strip().split("\n", 1)[0][:limit]


__all__ = ["self_correction_leak", "text_after_self_correction"]
