"""模型把「草稿 + Wait — … Correct it. + 改好的译文」一起交回来时，校验要拦下来重译。

两个正例都是真实输出（qwen3.8-flash 翻一本量子化学教材）。"""

import pytest

from retainpdf_pipeline.translate.llm.result_validator import validate_batch_result
from retainpdf_pipeline.translate.llm.validation.errors import TranslationProtocolError
from retainpdf_pipeline.translate.llm.validation.self_correction import self_correction_leak
from retainpdf_pipeline.translate.services.quality import review_translation_item

ALLENE_SOURCE = "FIGURE 12.16 Two views of allene. The C=C=C axis is perpendicular to the plane of the paper in (a)."
ALLENE_OUTPUT = (
    "图12.16 烯丙烷（allene）的两种视图。图(a)中 C=C=C 轴垂直于纸面。\n\n"
    'Wait—"allene" should not be translated as 烯丙烷; allene is 丙二烯. Correct it.\n\n'
    "图12.16 丙二烯（allene）的两种视图。图(a)中 $\\mathrm{C=C=C}$ 轴垂直于纸面。"
)
REPEAT_SOURCE = "Thus we have the following correspondence:"
REPEAT_OUTPUT = (
    "Thus we have the following correspondence:\n\n"
    "Wait — I need to correct my reply: the correct output is the translation, not the source repeated. \n\n"
    "因此我们有如下对应关系："
)


@pytest.mark.parametrize(
    ("source", "translated", "expected"),
    [
        (ALLENE_SOURCE, ALLENE_OUTPUT, "Wait—"),
        (REPEAT_SOURCE, REPEAT_OUTPUT, "Wait — I need to correct my reply"),
        ("The apparatus is shown below.", "装置如下图所示。\n\n等等，上面的译文有误，应改为：装置见下图。", "等等，上面的译文有误"),
        ("Allene is shown.", "图中是丙二烯。注意：allene 不应译为烯丙烷。", "不应译为烯丙烷"),
    ],
)
def test_self_correction_is_detected(source, translated, expected):
    assert expected in self_correction_leak(source, translated)


@pytest.mark.parametrize(
    ("source", "translated"),
    [
        # 原文本身就有 Wait（对话、引文）：照译出来的不算
        ('"Wait — I need to correct my reply," she said.', '她说："Wait — I need to correct my reply."'),
        # 「等等」的正常用法
        ("Fruits such as apples, bananas, and so on.", "水果，如苹果、香蕉等等。"),
        ("Wait, he said, and listen.", "等等，他说，听我讲。"),
        # 正常的中文译文里提到「翻译」
        ("The paper was translated into Chinese.", "这篇论文被翻译成了中文。"),
        # 纯英文（没翻译）不归这里管，交给 english_residue
        ("Wait — correct it.", "Wait — correct it."),
    ],
)
def test_ordinary_translations_pass(source, translated):
    assert self_correction_leak(source, translated) == ""


def _caption_item(item_id: str, source: str) -> dict:
    return {
        "item_id": item_id,
        "block_type": "text",
        "metadata": {"structure_role": "caption"},
        "translation_unit_protected_source_text": source,
    }


def test_quality_review_flags_it_as_an_error():
    report = review_translation_item(
        _caption_item("p014-b008", ALLENE_SOURCE),
        {"decision": "translate", "translated_text": ALLENE_OUTPUT},
    )
    kinds = {(issue.kind, issue.severity) for issue in report.issues}
    assert ("self_correction_leak", "error") in kinds


def test_validation_raises_so_the_item_is_retranslated():
    item = _caption_item("p015-b022", REPEAT_SOURCE)
    with pytest.raises(TranslationProtocolError):
        validate_batch_result([item], {"p015-b022": {"decision": "translate", "translated_text": REPEAT_OUTPUT}})


# ---------------------------------------------------------------- 拆外壳 / 部分接受不能把自言自语收下

from retainpdf_pipeline.translate.llm.shared.orchestration.direct_typst_salvage import (  # noqa: E402
    try_salvage_direct_typst_protocol_shell_error,
)
from retainpdf_pipeline.translate.llm.validation.self_correction import text_after_self_correction  # noqa: E402

# 真实输出（续接段落，p005-b013）：先抄原文，再自言自语，最后才是译文。以前被「部分接受」整段收下。
ECHO_SOURCE = (
    "in adaptive mode, such that reactions are removed from further evaluation as soon as a TS is found and validated."
)
ECHO_OUTPUT = (
    ECHO_SOURCE
    + "\n\nWait — the instruction says output only the translation. Let me correct that.\n\n"
    + "以自适应模式运行，即一旦找到并验证过渡态，便将该反应移出后续评估。"
)


def test_text_after_self_correction():
    assert text_after_self_correction(ECHO_SOURCE, ECHO_OUTPUT) == "以自适应模式运行，即一旦找到并验证过渡态，便将该反应移出后续评估。"
    assert text_after_self_correction(ALLENE_SOURCE, ALLENE_OUTPUT).startswith("图12.16 丙二烯")
    assert text_after_self_correction("x", "正常译文。") == "正常译文。"
    assert text_after_self_correction("x", "草稿。\nWait — I need to correct my reply.") == ""


def _salvage(source: str, output: str):
    item = {
        "item_id": "p005-b013",
        "block_type": "text",
        "math_mode": "direct_typst",
        "metadata": {"structure_role": "body"},
        "translation_unit_protected_source_text": source,
    }
    exc = TranslationProtocolError("p005-b013", source_text=source, translated_text=output)
    return try_salvage_direct_typst_protocol_shell_error(
        item,
        exc=exc,
        context=None,
        diagnostics=None,
        route_path=["block_level", "direct_typst", "protocol_shell_unwrap"],
        output_mode_path=["plain_text"],
        allow_partial_accept=True,
    )


def test_salvage_keeps_only_the_corrected_translation():
    entry = _salvage(ECHO_SOURCE, ECHO_OUTPUT)["p005-b013"]
    assert entry["translated_text"] == "以自适应模式运行，即一旦找到并验证过渡态，便将该反应移出后续评估。"
    assert entry["translation_diagnostics"]["degradation_reason"] == "self_correction_salvaged"


def test_nothing_after_the_correction_means_retranslate_not_partial_accept():
    output = "这是一段足够长的中文草稿译文，汉字数量超过了部分接受的门槛。\n\nWait — I need to correct my reply."
    assert _salvage(ECHO_SOURCE, output) is None
