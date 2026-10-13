


from retainpdf_pipeline.render.layout.payload.line_structure import maybe_preserve_structured_line_breaks
from retainpdf_pipeline.render.layout.inline_content.core.markdown import build_direct_typst_passthrough_text


def test_direct_typst_inline_math_internal_newline_is_folded_before_rendering() -> None:
    markdown = build_direct_typst_passthrough_text(
        "对于较大的 $ CN_{A}^{\\prime}\n$ 值，该 d 能级降低。"
    )

    assert "$CN_{A}^{\\prime}$" in markdown
    assert "$ CN_{A}^{\\prime}\n$" not in markdown
    assert "\n$" not in markdown


def test_direct_typst_keeps_short_latex_text_tags_inside_math() -> None:
    markdown = build_direct_typst_passthrough_text(
        r"其中 $ W_l^{\text{pre}}, W_l^{\text{post}} \in \mathbb{R}^{n_{\text{hc}} d \times n_{\text{hc}}} $ 是参数。"
    )

    assert r"W_l^{\text{pre}}" in markdown
    assert r"W_l^{$ pre $}" not in markdown
    assert r"n_{$ hc $}" not in markdown


# 下面这组曾经断言「LaTeX 被降级成 Unicode 字符」。那是 mitex 0.2.6 吐旧版 Typst
# 符号名时的权宜之计，0.2.7 起这些命令原生可渲染，降级只会白白丢掉保真度
# （括号不再随内容放大、手写体被换成花体）。现在断言的是「原样送出去」，
# 能不能渲染由 test_mitex_latex_coverage.py 真编译一次来保证。


def test_direct_typst_keeps_hbar_as_latex() -> None:
    markdown = build_direct_typst_passthrough_text(
        r"振动常数 $ \omega_e = \hbar \sqrt{k / \mu} $ 等间距分布。"
    )

    assert r"\hbar" in markdown
    assert "ℏ" not in markdown


def test_direct_typst_keeps_partial_as_latex() -> None:
    markdown = build_direct_typst_passthrough_text(
        r"曲率 $ k=\left(\frac{\partial^{2}U}{\partial R^{2}}\right) $。"
    )

    assert r"\partial" in markdown
    assert "∂" not in markdown


def test_direct_typst_keeps_otimes_as_latex() -> None:
    markdown = build_direct_typst_passthrough_text(
        r"选择规则 $ \Gamma_i \otimes \Gamma_f \ni \Gamma_\mu $。"
    )

    assert r"\otimes" in markdown
    assert "⊗" not in markdown


def test_direct_typst_keeps_left_right_angle_ket_as_latex() -> None:
    """保留 \left/\right：括号要随内容自动放大，剥掉就永远是基准尺寸。"""
    markdown = build_direct_typst_passthrough_text(
        r"将单激发行列式与 $ \left|\Psi_0\right\rangle $ 混合。"
    )

    assert r"\left|\Psi_0\right\rangle" in markdown
    assert "⟩" not in markdown


def test_direct_typst_keeps_left_right_bra_matrix_as_latex() -> None:
    markdown = build_direct_typst_passthrough_text(
        r"非对角元满足 $ \left\langle\chi_i\right|f|\chi_j\rangle=0 $。"
    )

    assert r"\left\langle\chi_i\right|f|\chi_j\rangle=0" in markdown
    assert "⟨" not in markdown


def test_direct_typst_keeps_nested_left_right_matrix_element_as_latex() -> None:
    markdown = build_direct_typst_passthrough_text(
        r"矩阵元 $ \left\langle\Psi_a^{rs}\right|\mathcal{H}\left|\Psi_{ab}^{rs}\right\rangle $。"
    )

    assert r"\left\langle\Psi_a^{rs}\right|" in markdown
    assert r"\left|\Psi_{ab}^{rs}\right\rangle" in markdown
    assert "⟨" not in markdown


def test_direct_typst_does_not_inject_empty_base_for_prefix_scripts() -> None:
    """Prefix-script empty bases are translation's job, not render-time regex."""
    markdown = build_direct_typst_passthrough_text(
        r"能量为 $ ^{N}E_0 = \langle ^{N}\Psi_0 | \mathcal{H} | ^{N}\Psi_0 \rangle $。"
    )

    assert r"\{}^{" not in markdown
    assert r"\langle" in markdown and r"\rangle" in markdown
    assert r"^{N}\Psi_0" in markdown


def test_direct_typst_preserves_backslash_space_before_degree_mathrm() -> None:
    r"""LaTeX backslash-space before ^{\circ} must not become \{}^{\circ}."""
    markdown = build_direct_typst_passthrough_text(
        r"反应在 $-78\ ^{\circ}\mathrm{C}$ 至室温下进行。"
    )

    assert r"-78\{}^{\circ}" not in markdown
    assert r"\{}^{" not in markdown
    assert r"^{\circ}\mathrm{C}" in markdown
    assert r"\ ^{\circ}\mathrm{C}" in markdown


def test_body_rendering_folds_model_visual_line_breaks_for_flow_text() -> None:
    item = {
        "item_id": "p005-b025",
        "semantic_role": "body",
        "structure_role": "body",
        "text_flow": "preserve_lines",
    }
    translated = "对于较大的 $ CN_{A}^{\\prime}\n$ 值，该 d 能级能量降低。"

    rendered = maybe_preserve_structured_line_breaks(item, translated)

    assert "\n" not in rendered
    assert rendered == "对于较大的 $ CN_{A}^{\\prime} $ 值，该 d 能级能量降低。"
    assert "_render_preserve_line_breaks" not in item
